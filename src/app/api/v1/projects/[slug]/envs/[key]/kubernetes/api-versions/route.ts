import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { getKubeconfigForEnv } from "@/lib/runner/creds";
import { runStage } from "@/lib/runner/exec";
import { FALLBACK_API_VERSIONS } from "@/lib/devops/manifest-templates";

const PATH = [process.env.PATH ?? "", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].filter(Boolean).join(":");

/**
 * GET /projects/[slug]/envs/[key]/kubernetes/api-versions
 *
 * Lists the apiVersions the env's cluster actually supports (`kubectl
 * api-versions`). Falls back to a built-in list when the env has no kubeconfig
 * or kubectl is unavailable, so the manifest builder still works offline.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const env = await envBySlugAndKey(gate.access.project.id, key);
  if (!env) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });

  const kcfg = await getKubeconfigForEnv(env.id);
  if (!kcfg.ok) {
    return NextResponse.json({ ok: true, source: "builtin", apiVersions: FALLBACK_API_VERSIONS, note: kcfg.message });
  }
  try {
    const res = await runStage({
      command: "kubectl",
      args: ["api-versions"],
      cwd: process.cwd(),
      env: { PATH, KUBECONFIG: kcfg.handle.path },
      timeoutMs: 15_000,
    });
    if (res.exitCode !== 0) {
      return NextResponse.json({
        ok: true,
        source: "builtin",
        apiVersions: FALLBACK_API_VERSIONS,
        note: res.stderr.slice(-300) || "kubectl api-versions failed; showing built-in list.",
      });
    }
    const apiVersions = res.stdout
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    return NextResponse.json({ ok: true, source: "cluster", apiVersions });
  } finally {
    await kcfg.handle.cleanup().catch(() => {});
  }
}
