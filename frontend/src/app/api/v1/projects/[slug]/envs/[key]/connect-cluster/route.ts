import { NextResponse } from "next/server";
import { z } from "zod";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey, updateEnv } from "@/lib/devops/envs";
import { resolveAwsExecEnv } from "@/lib/cloud/aws-onboard";
import { getAzureAccessToken } from "@/lib/cloud/azure";
import { getAksKubeconfig, getSubscriptionTenant } from "@/lib/cloud/azure-arm";
import { getGcpAccessToken } from "@/lib/cloud/gcp";
import { getGkeKubeconfig } from "@/lib/cloud/gcp-oauth";
import { runStage } from "@/lib/runner/exec";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * Connect a running Kubernetes cluster across the three clouds — the new-app
 * equivalent of the old EKSModal, extended to AKS + GKE.
 *
 * Produces a kubeconfig, stores it (encrypted) on the env, then smoke-tests it
 * with `kubectl get nodes`. Credentials are APP-MANAGED so the server never
 * depends on a host login (works behind a mobile client):
 *   aws   → aws eks update-kubeconfig (uses the provider's stored keys)
 *   azure → ARM listClusterAdminCredentials via the stored service principal
 *   gcp   → gcloud container clusters get-credentials
 * Only `kubectl` (for the smoke test) and, for AWS/GCP, their CLI need to be on
 * the server image — none of them require an interactive login.
 */
const Body = z
  .object({
    cloud: z.enum(["aws", "azure", "gcp"]),
    clusterName: z.string().trim().min(1).max(120),
    region: z.string().trim().max(60).optional(),
    resourceGroup: z.string().trim().max(120).optional(),
    project: z.string().trim().max(120).optional(),
  })
  .refine((d) => d.cloud !== "aws" || !!d.region, {
    message: "AWS needs a region.",
    path: ["region"],
  })
  .refine((d) => d.cloud !== "azure" || !!d.resourceGroup, {
    message: "Azure needs a resource group.",
    path: ["resourceGroup"],
  })
  .refine((d) => d.cloud !== "gcp" || !!d.project, {
    message: "GCP needs a project.",
    path: ["project"],
  });

const CLI: Record<"aws" | "azure" | "gcp", string> = { aws: "aws", azure: "az", gcp: "gcloud" };

type AzureKubeResult =
  { ok: true; kubeconfig: string } | { ok: false; code: string; message: string };

/**
 * Resolve the project's Azure provider (preferring the env's), then fetch the
 * AKS kubeconfig over ARM with its stored service-principal token.
 */
async function azureKubeconfig(
  projectId: string,
  envProviderId: string | null,
  resourceGroup: string,
  clusterName: string,
): Promise<AzureKubeResult> {
  const cp = envProviderId
    ? await prisma.cloudProvider.findFirst({
        where: { id: envProviderId, kind: "azure" },
        select: { id: true, accountRef: true },
      })
    : await prisma.cloudProvider.findFirst({
        where: { projectId, kind: "azure" },
        select: { id: true, accountRef: true },
      });
  if (!cp?.accountRef) {
    return {
      ok: false,
      code: "no_azure_provider",
      message:
        "No Azure subscription is connected for this project. Connect one on the Cloud providers page.",
    };
  }
  const tok = await getAzureAccessToken(cp.id);
  if (!tok.ok) return { ok: false, code: "azure_auth_failed", message: tok.error };

  // Re-acquire a token scoped to the SUBSCRIPTION'S tenant. A personal Microsoft
  // account that owns the subscription otherwise gets a "live.com#…" passthrough
  // token that can read the cluster but can't fetch its credentials. Targeting
  // the real tenant produces a proper token that can. Fall back to the original.
  let accessToken = tok.accessToken;
  const tenantId = await getSubscriptionTenant(tok.accessToken, cp.accountRef);
  if (tenantId) {
    const scoped = await getAzureAccessToken(cp.id, tenantId);
    if (scoped.ok) accessToken = scoped.accessToken;
  }

  const kc = await getAksKubeconfig(accessToken, cp.accountRef, resourceGroup, clusterName, cp.id);
  if (!kc.ok) return { ok: false, code: "connect_failed", message: kc.error };
  return { ok: true, kubeconfig: kc.kubeconfig };
}

/**
 * Resolve the project's GCP provider, then build a kubeconfig from the GKE REST
 * API with its stored OAuth token — app-managed, no `gcloud`.
 */
async function gcpKubeconfig(
  projectId: string,
  envProviderId: string | null,
  gcpProject: string,
  location: string,
  clusterName: string,
): Promise<AzureKubeResult> {
  const cp = envProviderId
    ? await prisma.cloudProvider.findFirst({
        where: { id: envProviderId, kind: "gcp" },
        select: { id: true },
      })
    : await prisma.cloudProvider.findFirst({
        where: { projectId, kind: "gcp" },
        select: { id: true },
      });
  if (!cp) {
    return {
      ok: false,
      code: "no_gcp_provider",
      message:
        "No GCP account is connected for this project. Connect one on the Cloud providers page.",
    };
  }
  const tok = await getGcpAccessToken(cp.id);
  if (!tok.ok) return { ok: false, code: "gcp_auth_failed", message: tok.error };
  const kc = await getGkeKubeconfig(tok.accessToken, gcpProject, location, clusterName);
  if (!kc.ok) return { ok: false, code: "connect_failed", message: kc.error };
  return { ok: true, kubeconfig: kc.kubeconfig };
}

export async function POST(req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const env = await envBySlugAndKey(gate.access.project.id, key);
  if (!env) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const { cloud, clusterName, region, resourceGroup, project } = parsed.data;

  // AWS creds: stored long-lived keys, or a proper STS AssumeRole exchange for
  // role-based providers (resolveAwsExecEnv — NOT the raw getDecryptedCloudCreds,
  // which returns only role METADATA for role-based providers and leaves the CLI
  // with no usable credentials, causing "security token invalid" from EKS).
  // Prefer the env's own provider; fall back to the project's AWS provider so a
  // freshly-created env without cloudProviderId set still resolves correctly.
  let credEnv: Record<string, string> = {};
  // Tracked so we can back-link the env below when this connection succeeds —
  // otherwise every downstream consumer that (correctly) expects
  // env.cloudProviderId to be accurate (deploy_my_app, list_ecr_repos, etc.)
  // has to re-derive the same fallback themselves.
  let fallbackProvider: { id: string; userId: string } | null = null;
  if (cloud === "aws") {
    let providerId = env.cloudProviderId;
    if (!providerId) {
      fallbackProvider = await prisma.cloudProvider.findFirst({
        where: { projectId: gate.access.project.id, kind: "aws" },
        select: { id: true, userId: true },
      });
      providerId = fallbackProvider?.id ?? null;
    }
    if (providerId) {
      const creds = await resolveAwsExecEnv(providerId);
      if (creds.ok) credEnv = creds.env;
    }
  }

  const workdir = await mkdtemp(join(tmpdir(), "dda-kube-"));
  const kubeconfigPath = join(workdir, "config");
  const childEnv: Record<string, string> = {
    ...credEnv,
    PATH: [process.env.PATH ?? "", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
      .filter(Boolean)
      .join(":"),
    KUBECONFIG: kubeconfigPath,
  };

  const meta = extractRequestMeta(req);
  try {
    if (cloud === "azure") {
      // App-managed: fetch the kubeconfig from ARM using the project's stored
      // Azure service principal — no `az` CLI, no host login.
      const azure = await azureKubeconfig(
        gate.access.project.id,
        env.cloudProviderId,
        resourceGroup!,
        clusterName,
      );
      if (!azure.ok) {
        return NextResponse.json({ ok: false, code: azure.code, message: azure.message });
      }
      await writeFile(kubeconfigPath, azure.kubeconfig, { mode: 0o600 });
    } else if (cloud === "gcp") {
      // App-managed: build the kubeconfig from the GKE REST API using the
      // project's stored Google OAuth token — no `gcloud`, no host login.
      const gcp = await gcpKubeconfig(
        gate.access.project.id,
        env.cloudProviderId,
        project!,
        region || "us-central1",
        clusterName,
      );
      if (!gcp.ok) {
        return NextResponse.json({ ok: false, code: gcp.code, message: gcp.message });
      }
      await writeFile(kubeconfigPath, gcp.kubeconfig, { mode: 0o600 });
    } else {
      const args = [
        "eks",
        "update-kubeconfig",
        "--name",
        clusterName,
        "--region",
        region!,
        "--kubeconfig",
        kubeconfigPath,
      ];
      const gen = await runStage({
        command: CLI[cloud],
        args,
        cwd: workdir,
        env: childEnv,
        timeoutMs: 60_000,
      });
      if (gen.exitCode !== 0) {
        const missing =
          gen.exitCode === -1 && (gen.stderr.includes("ENOENT") || gen.stderr.includes("[exec]"));
        return NextResponse.json({
          ok: false,
          code: missing ? "cli_not_installed" : "connect_failed",
          message: missing
            ? `The \`${CLI[cloud]}\` CLI isn't on the server's PATH. Install it on the runner host.`
            : gen.timedOut
              ? "The cloud CLI timed out."
              : `${CLI[cloud]} failed to fetch cluster credentials.`,
          stderr: gen.stderr.slice(-2_000),
        });
      }
    }

    // Persist the kubeconfig (encrypted) on the env so the runner can reuse it.
    // Also back-link cloudProviderId when we resolved it via the project-level
    // fallback above and the current user owns that provider (updateEnv
    // rejects a cloudProviderId it can't verify against ownerId) — so this env
    // resolves directly next time instead of every caller re-deriving the
    // fallback itself.
    const kubeconfig = await readFile(kubeconfigPath, "utf8");
    const backlinkProviderId =
      fallbackProvider && fallbackProvider.userId === gate.access.session.userId
        ? fallbackProvider.id
        : undefined;
    await updateEnv(gate.access.project.id, gate.access.session.userId, key, {
      kubeconfig,
      ...(backlinkProviderId && { cloudProviderId: backlinkProviderId }),
    });

    // Smoke-test the connection.
    const verify = await runStage({
      command: "kubectl",
      args: ["get", "nodes", "-o", "json"],
      cwd: workdir,
      env: childEnv,
      timeoutMs: 20_000,
      // Node JSON exceeds the default 32KB cap on multi-node clusters; raising
      // it prevents tail-truncation that would parse as "0 nodes".
      maxBufferBytes: 8 * 1024 * 1024,
    });
    let nodes: Array<{ name: string; status: string; version: string }> = [];
    if (verify.exitCode === 0) {
      try {
        const parsedNodes = JSON.parse(verify.stdout) as {
          items?: Array<{
            metadata?: { name?: string };
            status?: {
              conditions?: Array<{ type?: string; status?: string }>;
              nodeInfo?: { kubeletVersion?: string };
            };
          }>;
        };
        nodes = (parsedNodes.items ?? []).map((n) => {
          const ready = n.status?.conditions?.find((c) => c.type === "Ready");
          return {
            name: n.metadata?.name ?? "(unknown)",
            status: ready?.status === "True" ? "Ready" : (ready?.status ?? "Unknown"),
            version: n.status?.nodeInfo?.kubeletVersion ?? "?",
          };
        });
      } catch {
        /* non-JSON output — leave nodes empty */
      }
    }

    await audit({
      userId: gate.access.session.userId,
      projectId: gate.access.project.id,
      action: "env.cluster_connected",
      targetType: "env",
      targetId: env.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { cloud, cluster: clusterName, nodeCount: nodes.length },
    });

    return NextResponse.json({
      ok: true,
      cloud,
      cluster: clusterName,
      stored: true,
      // verified is false when kubectl isn't installed or the cluster is unreachable;
      // the kubeconfig is still stored so a later run can use it.
      verified: verify.exitCode === 0,
      nodes,
      ...(verify.exitCode !== 0 ? { verifyError: verify.stderr.slice(-1_000) } : {}),
    });
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}
