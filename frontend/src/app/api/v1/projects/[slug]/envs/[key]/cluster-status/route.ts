import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { getKubeconfigForEnv, getDecryptedCloudCreds } from "@/lib/runner/creds";
import { runStage } from "@/lib/runner/exec";

const PATH = [process.env.PATH ?? "", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].filter(Boolean).join(":");

/** Pass the host's AWS creds + HOME so an EKS kubeconfig's `aws eks get-token`
 *  exec plugin can authenticate (Option A local creds live in process.env). */
function hostAwsPassthrough(): Record<string, string> {
  const out: Record<string, string> = {};
  if (process.env.HOME) out.HOME = process.env.HOME;
  for (const k of [
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "AWS_SESSION_TOKEN",
    "AWS_PROFILE",
    "AWS_DEFAULT_PROFILE",
    "AWS_REGION",
    "AWS_DEFAULT_REGION",
    "AWS_SHARED_CREDENTIALS_FILE",
    "AWS_CONFIG_FILE",
  ]) {
    const v = process.env[k];
    if (v) out[k] = v;
  }
  return out;
}

/** Extract the EKS cluster name from the kubeconfig (clusters[].name is the ARN). */
function clusterNameFromKubeconfig(yaml: string): string | undefined {
  const m = yaml.match(/cluster\/([A-Za-z0-9._-]+)/) || yaml.match(/name:\s*([A-Za-z0-9._-]+)\b/);
  return m?.[1];
}

/**
 * GET /projects/[slug]/envs/[key]/cluster-status
 *
 * Reports whether the env has a connected cluster and lists its nodes live from
 * the stored kubeconfig (using the env's + host AWS creds so EKS auth works).
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const env = await envBySlugAndKey(gate.access.project.id, key);
  if (!env) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
  if (!env.kubeconfigRef) return NextResponse.json({ ok: true, connected: false });

  const kcfg = await getKubeconfigForEnv(env.id);
  if (!kcfg.ok) {
    return NextResponse.json({ ok: true, connected: true, verified: false, verifyError: kcfg.message });
  }
  try {
    // Cluster name from the stored kubeconfig (for the UI label).
    let cluster: string | undefined;
    try {
      cluster = clusterNameFromKubeconfig(await readFile(kcfg.handle.path, "utf8"));
    } catch {
      /* ignore */
    }

    // EKS kubeconfig auth needs AWS creds — env's provider creds + host fallback.
    let credEnv: Record<string, string> = {};
    if (env.cloudProviderId) {
      const creds = await getDecryptedCloudCreds(env.cloudProviderId);
      if (creds.ok) credEnv = creds.env;
    }
    const childEnv: Record<string, string> = {
      ...hostAwsPassthrough(),
      ...credEnv,
      PATH,
      KUBECONFIG: kcfg.handle.path,
    };

    const res = await runStage({
      command: "kubectl",
      args: ["get", "nodes", "-o", "json"],
      cwd: process.cwd(),
      env: childEnv,
      timeoutMs: 25_000,
    });
    if (res.exitCode !== 0) {
      return NextResponse.json({ ok: true, connected: true, verified: false, cluster, verifyError: res.stderr.slice(-500) });
    }
    let nodes: Array<{ name: string; status: string; version: string }> = [];
    try {
      const parsed = JSON.parse(res.stdout) as {
        items?: Array<{ metadata?: { name?: string }; status?: { conditions?: Array<{ type?: string; status?: string }>; nodeInfo?: { kubeletVersion?: string } } }>;
      };
      nodes = (parsed.items ?? []).map((n) => {
        const ready = n.status?.conditions?.find((c) => c.type === "Ready");
        return {
          name: n.metadata?.name ?? "(unknown)",
          status: ready?.status === "True" ? "Ready" : ready?.status ?? "Unknown",
          version: n.status?.nodeInfo?.kubeletVersion ?? "?",
        };
      });
    } catch {
      /* non-JSON */
    }
    return NextResponse.json({ ok: true, connected: true, verified: true, cluster, nodes });
  } finally {
    await kcfg.handle.cleanup().catch(() => {});
  }
}
