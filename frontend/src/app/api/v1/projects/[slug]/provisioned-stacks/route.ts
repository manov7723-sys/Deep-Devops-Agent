import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { getTerraformRunAsync, listTerraformRunsAsync } from "@/lib/devops/terraform-run";
import { getAzureAccessToken } from "@/lib/cloud/azure";
import { findAksClusterByName } from "@/lib/cloud/azure-arm";
import type { ProvisionedStack } from "@/app/(app)/p/[projectSlug]/provisioned/route-source";

/**
 * GET /projects/[slug]/provisioned-stacks
 *
 * "Cloud-truth" list of everything the agent has applied — one row per stack
 * — annotated with whether the primary resource still EXISTS in the cloud.
 *
 * WHY THIS EXISTS:
 * The naive "list from tfRun history" view lies when infra is deleted outside
 * the app (Portal / CLI / another team). This endpoint reconciles against the
 * cloud API so the Provisioned page can show "gone in cloud" for a stack
 * whose cluster someone Portal-deleted, and offer to just clean up state
 * rather than trying to run destroy on non-existent resources.
 *
 * Pattern (per stack):
 *   1. Take the LATEST SUCCESSFUL apply run per (env, stack name), skipping
 *      stacks whose most recent successful run was a destroy.
 *   2. Pull the run's source spec from the DB (persisted alongside the run
 *      for rerun support) to extract the primary resource identity.
 *   3. Ask the cloud API "does this resource exist?" — a fast, cheap lookup
 *      that mirrors what the agent's own connect/deploy flows already do.
 *   4. Attach the answer as `cloudStatus`.
 *
 * Reconciler support is currently AKS-only (matches where the demo pain is).
 * EKS + GKE mirror the shape — swap `findAksClusterByName` for a resource-
 * specific existence check.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const envs = await prisma.env.findMany({
    where: { projectId: gate.access.project.id },
    select: { id: true, key: true, cloudProviderId: true, cloudProvider: { select: { kind: true } } },
  });

  const stacks: ProvisionedStack[] = [];

  for (const env of envs) {
    const runs = await listTerraformRunsAsync(env.id, 100);
    // Newest first — the sort matters for the "latest wins per stack" logic.
    const sorted = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    const winner = new Map<string, (typeof sorted)[number]>();
    const disqualified = new Set<string>();
    for (const r of sorted) {
      if (r.status !== "succeeded") continue;
      if (winner.has(r.name) || disqualified.has(r.name)) continue;
      if (r.action === "destroy") disqualified.add(r.name);
      else if (r.action === "apply") winner.set(r.name, r);
    }

    for (const run of winner.values()) {
      const cloudKind = env.cloudProvider?.kind ?? "unknown";
      const source = await getTerraformRunAsync(run.id);
      const primary = source ? extractPrimaryResource(source.stages) : null;
      // stages don't carry files — pull from the source spec directly. The
      // rerun path already reads it the same way; safe pattern.
      const files = await sourceFiles(run.id);
      const parsedPrimary = primary ?? (files ? extractPrimaryFromFiles(files) : null);

      let cloudStatus: ProvisionedStack["cloudStatus"] = "unsupported";
      let cloudNote: string | undefined;

      if (
        cloudKind === "azure" &&
        env.cloudProviderId &&
        parsedPrimary?.kind === "azurerm_kubernetes_cluster"
      ) {
        const cp = await prisma.cloudProvider.findFirst({
          where: { id: env.cloudProviderId, kind: "azure" },
          select: { accountRef: true },
        });
        const tok = cp?.accountRef ? await getAzureAccessToken(env.cloudProviderId) : null;
        if (cp?.accountRef && tok?.ok) {
          const found = await findAksClusterByName(tok.accessToken, cp.accountRef, parsedPrimary.name);
          if (found.ok) {
            cloudStatus = "exists";
          } else if (/no aks cluster named/i.test(found.error)) {
            cloudStatus = "gone";
            cloudNote = "Cluster is no longer visible in Azure — deleted outside the app.";
          } else {
            cloudStatus = "unknown";
            cloudNote = `Cloud lookup failed: ${found.error}`;
          }
        } else {
          cloudStatus = "unknown";
          cloudNote = tok && !tok.ok ? `Azure token failed: ${tok.error}` : "No Azure provider connected.";
        }
      }

      stacks.push({
        envKey: env.key,
        stack: run.name,
        runId: run.id,
        appliedAt: run.createdAt,
        cloud:
          cloudKind === "aws" || cloudKind === "azure" || cloudKind === "gcp"
            ? (cloudKind as "aws" | "azure" | "gcp")
            : "unknown",
        primaryResource: parsedPrimary,
        cloudStatus,
        cloudNote,
      });
    }
  }

  return NextResponse.json({ ok: true, stacks });
}

function extractPrimaryResource(_stages: unknown): { kind: string; name: string } | null {
  // Placeholder for a future signal path where the run stores a summary of
  // what it created (e.g. from `terraform show` output). For now we fall
  // through to file parsing.
  return null;
}

/**
 * Read the source files for a run — same path rerunTerraformRun uses.
 * Returns null if the source has been evicted (older than the ring buffer).
 */
async function sourceFiles(runId: string): Promise<Record<string, string> | null> {
  const row = await prisma.tfRun.findUnique({
    where: { id: runId },
    select: { sourceFiles: true },
  });
  if (!row?.sourceFiles) return null;
  // Prisma types sourceFiles as JsonValue since it's a Json column, but this
  // codebase always writes it as an object of {path: content}. Handle both
  // stored-as-object (typical) and stored-as-string (older writes) cases.
  if (typeof row.sourceFiles === "string") {
    try {
      return JSON.parse(row.sourceFiles) as Record<string, string>;
    } catch {
      return null;
    }
  }
  if (typeof row.sourceFiles === "object" && row.sourceFiles !== null) {
    return row.sourceFiles as unknown as Record<string, string>;
  }
  return null;
}

/**
 * Fish the "primary resource" name out of a stack's Terraform. Priority:
 *   AKS cluster > EKS cluster > GKE cluster > anything with a `name = "..."`.
 *
 * Cheap regex — good enough because the generators in this codebase always
 * put the resource block with `name = "<value>"` on a single line. If a
 * generator changes format this needs to update in lockstep.
 */
function extractPrimaryFromFiles(
  files: Record<string, string>,
): { kind: string; name: string } | null {
  for (const [, content] of Object.entries(files)) {
    for (const kind of [
      "azurerm_kubernetes_cluster",
      "aws_eks_cluster",
      "google_container_cluster",
    ]) {
      const rx = new RegExp(
        `resource\\s+"${kind}"\\s+"[^"]+"\\s*\\{[^}]*?\\bname\\s*=\\s*"([^"]+)"`,
        "s",
      );
      const m = rx.exec(content);
      if (m) return { kind, name: m[1] };
    }
  }
  return null;
}
