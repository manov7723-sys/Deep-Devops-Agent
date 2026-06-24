import { NextResponse } from "next/server";
import { z } from "zod";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey, updateEnv } from "@/lib/devops/envs";
import { getDecryptedCloudCreds } from "@/lib/runner/creds";
import { runStage } from "@/lib/runner/exec";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * Connect a running Kubernetes cluster across the three clouds — the new-app
 * equivalent of the old EKSModal, extended to AKS + GKE.
 *
 * Runs the cloud's CLI to produce a kubeconfig, stores it (encrypted) on the
 * env, then smoke-tests it with `kubectl get nodes`:
 *   aws   → aws eks update-kubeconfig --name --region
 *   azure → az aks get-credentials --name --resource-group
 *   gcp   → gcloud container clusters get-credentials --region --project
 *
 * AWS uses the provider's Vault credentials; Azure/GCP rely on the runner
 * host's `az`/`gcloud` already being authenticated (same model as the old app
 * relying on the host's CLI auth).
 */
const Body = z
  .object({
    cloud: z.enum(["aws", "azure", "gcp"]),
    clusterName: z.string().trim().min(1).max(120),
    region: z.string().trim().max(60).optional(),
    resourceGroup: z.string().trim().max(120).optional(),
    project: z.string().trim().max(120).optional(),
  })
  .refine((d) => d.cloud !== "aws" || !!d.region, { message: "AWS needs a region.", path: ["region"] })
  .refine((d) => d.cloud !== "azure" || !!d.resourceGroup, {
    message: "Azure needs a resource group.",
    path: ["resourceGroup"],
  })
  .refine((d) => d.cloud !== "gcp" || !!d.project, { message: "GCP needs a project.", path: ["project"] });

const CLI: Record<"aws" | "azure" | "gcp", string> = { aws: "aws", azure: "az", gcp: "gcloud" };

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

  // AWS creds come from Vault (when a provider is linked); az/gcloud use host auth.
  let credEnv: Record<string, string> = {};
  if (cloud === "aws" && env.cloudProviderId) {
    const creds = await getDecryptedCloudCreds(env.cloudProviderId);
    if (creds.ok) credEnv = creds.env;
  }

  const workdir = await mkdtemp(join(tmpdir(), "dda-kube-"));
  const kubeconfigPath = join(workdir, "config");
  const childEnv: Record<string, string> = {
    ...credEnv,
    PATH: [process.env.PATH ?? "", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].filter(Boolean).join(":"),
    KUBECONFIG: kubeconfigPath,
  };

  const args =
    cloud === "aws"
      ? ["eks", "update-kubeconfig", "--name", clusterName, "--region", region!, "--kubeconfig", kubeconfigPath]
      : cloud === "azure"
        ? ["aks", "get-credentials", "--name", clusterName, "--resource-group", resourceGroup!, "--file", kubeconfigPath, "--overwrite-existing"]
        : ["container", "clusters", "get-credentials", clusterName, "--region", region || "us-central1", "--project", project!];

  const meta = extractRequestMeta(req);
  try {
    const gen = await runStage({ command: CLI[cloud], args, cwd: workdir, env: childEnv, timeoutMs: 60_000 });
    if (gen.exitCode !== 0) {
      const missing = gen.exitCode === -1 && (gen.stderr.includes("ENOENT") || gen.stderr.includes("[exec]"));
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

    // Persist the kubeconfig (encrypted) on the env so the runner can reuse it.
    const kubeconfig = await readFile(kubeconfigPath, "utf8");
    await updateEnv(gate.access.project.id, gate.access.session.userId, key, { kubeconfig });

    // Smoke-test the connection.
    const verify = await runStage({
      command: "kubectl",
      args: ["get", "nodes", "-o", "json"],
      cwd: workdir,
      env: childEnv,
      timeoutMs: 20_000,
    });
    let nodes: Array<{ name: string; status: string; version: string }> = [];
    if (verify.exitCode === 0) {
      try {
        const parsedNodes = JSON.parse(verify.stdout) as {
          items?: Array<{ metadata?: { name?: string }; status?: { conditions?: Array<{ type?: string; status?: string }>; nodeInfo?: { kubeletVersion?: string } } }>;
        };
        nodes = (parsedNodes.items ?? []).map((n) => {
          const ready = n.status?.conditions?.find((c) => c.type === "Ready");
          return {
            name: n.metadata?.name ?? "(unknown)",
            status: ready?.status === "True" ? "Ready" : ready?.status ?? "Unknown",
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
