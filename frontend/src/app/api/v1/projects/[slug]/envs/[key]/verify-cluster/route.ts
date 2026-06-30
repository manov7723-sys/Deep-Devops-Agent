import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { runStage } from "@/lib/runner/exec";
import { getKubeconfigForEnv } from "@/lib/runner/creds";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * POST /projects/[slug]/envs/[key]/verify-cluster
 *
 * Smoke-test the env's kubeconfig by running `kubectl get nodes`. Used by
 * the env settings modal "Verify cluster" button so admins can confirm a
 * pasted kubeconfig works before any real pipeline depends on it.
 *
 * Returns:
 *   ok=true  + a parsed list of {name, status, version} per node
 *   ok=false + a code (missing_kubeconfig / decrypt_failed / kubectl_failed / no_binary)
 *            + the raw stderr so the admin can see exactly what went wrong
 *
 * developer+ gate — viewing the cluster state isn't a viewer-level action.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const env = await envBySlugAndKey(gate.access.project.id, key);
  if (!env) {
    return NextResponse.json({ ok: false, code: "env_not_found" }, { status: 404 });
  }

  const kcfg = await getKubeconfigForEnv(env.id);
  if (!kcfg.ok) {
    return NextResponse.json(
      { ok: false, code: kcfg.code, message: kcfg.message },
      { status: 400 },
    );
  }

  const meta = extractRequestMeta(req);
  try {
    const res = await runStage({
      command: "kubectl",
      args: ["get", "nodes", "-o", "json"],
      cwd: process.cwd(),
      env: { KUBECONFIG: kcfg.handle.path },
      timeoutMs: 15_000,
      // Node JSON is ~16KB/node; the default 32KB cap tail-truncates it and
      // breaks JSON.parse (showing "no nodes"). Allow up to 8MB.
      maxBufferBytes: 8 * 1024 * 1024,
    });

    if (res.exitCode !== 0) {
      // ENOENT comes back through error events with exit code -1 + an
      // [exec] suffix in stderr. Detect that for a friendlier error.
      const probablyMissing =
        res.exitCode === -1 &&
        (res.stderr.includes("ENOENT") || res.stderr.includes("[exec]"));
      await audit({
        userId: gate.access.session.userId,
        projectId: gate.access.project.id,
        action: "env.cluster_verify_failed",
        targetType: "env",
        targetId: env.id,
        ipAddress: meta.ipAddress,
        userAgent: meta.userAgent,
        metadata: { exitCode: res.exitCode, timedOut: res.timedOut },
      });
      return NextResponse.json({
        ok: false,
        code: probablyMissing ? "kubectl_not_installed" : "kubectl_failed",
        message: probablyMissing
          ? "The `kubectl` binary isn't on the server's PATH. Install it on the host running DeepAgent."
          : res.timedOut
            ? "kubectl timed out — the cluster API server may be unreachable."
            : "kubectl returned a non-zero exit code.",
        stderr: res.stderr.slice(-2_000),
        durationMs: res.durationMs,
      });
    }

    // Parse the JSON output into a digestible list for the UI.
    let parsedNodes: Array<{ name: string; status: string; version: string }> = [];
    try {
      const parsed = JSON.parse(res.stdout) as {
        items?: Array<{
          metadata?: { name?: string };
          status?: {
            conditions?: Array<{ type?: string; status?: string }>;
            nodeInfo?: { kubeletVersion?: string };
          };
        }>;
      };
      parsedNodes = (parsed.items ?? []).map((n) => {
        const ready = n.status?.conditions?.find((c) => c.type === "Ready");
        return {
          name: n.metadata?.name ?? "(unknown)",
          status: ready?.status === "True" ? "Ready" : ready?.status ?? "Unknown",
          version: n.status?.nodeInfo?.kubeletVersion ?? "?",
        };
      });
    } catch {
      // Output wasn't JSON for some reason — fall back to raw stdout
      // truncated.
      parsedNodes = [];
    }

    await audit({
      userId: gate.access.session.userId,
      projectId: gate.access.project.id,
      action: "env.cluster_verified",
      targetType: "env",
      targetId: env.id,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
      metadata: { nodeCount: parsedNodes.length, durationMs: res.durationMs },
    });

    return NextResponse.json({
      ok: true,
      nodes: parsedNodes,
      durationMs: res.durationMs,
      namespace: kcfg.namespace,
    });
  } finally {
    // Always wipe the kubeconfig tempfile, even on error.
    await kcfg.handle.cleanup().catch(() => {});
  }
}
