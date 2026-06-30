import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { getKubeconfigForEnv } from "@/lib/runner/creds";
import { runStage } from "@/lib/runner/exec";
import { FALLBACK_RESOURCES, type ApiResource } from "@/lib/devops/manifest-templates";

const PATH = [process.env.PATH ?? "", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"].filter(Boolean).join(":");

/**
 * Parse `kubectl api-resources --no-headers` output. Default columns are:
 *   NAME  [SHORTNAMES]  APIVERSION  NAMESPACED  KIND
 * SHORTNAMES is optional (blank for many resources), so we parse from the RIGHT:
 * the trailing three columns (APIVERSION, NAMESPACED, KIND) are always single
 * tokens, and NAME is the first token.
 */
function parseApiResources(stdout: string): ApiResource[] {
  const out: ApiResource[] = [];
  for (const line of stdout.split("\n")) {
    const t = line.trim().split(/\s+/).filter(Boolean);
    if (t.length < 4) continue;
    const kind = t[t.length - 1];
    const namespaced = t[t.length - 2];
    const apiVersion = t[t.length - 3];
    const name = t[0];
    if (!/^(true|false)$/i.test(namespaced)) continue; // not a resource row
    out.push({ kind, apiVersion, namespaced: namespaced.toLowerCase() === "true", name });
  }
  // De-dupe by kind+apiVersion, sort by kind.
  const seen = new Set<string>();
  return out
    .filter((r) => {
      const k = `${r.apiVersion}/${r.kind}`;
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    })
    .sort((a, b) => a.kind.localeCompare(b.kind));
}

/**
 * GET /projects/[slug]/envs/[key]/kubernetes/api-resources
 *
 * Lists the resource kinds the env's cluster supports (`kubectl api-resources`).
 * Falls back to a built-in list when the cluster isn't reachable.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const env = await envBySlugAndKey(gate.access.project.id, key);
  if (!env) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });

  const kcfg = await getKubeconfigForEnv(env.id);
  if (!kcfg.ok) {
    return NextResponse.json({ ok: true, source: "builtin", resources: FALLBACK_RESOURCES, note: kcfg.message });
  }
  try {
    const res = await runStage({
      command: "kubectl",
      args: ["api-resources", "--no-headers"],
      cwd: process.cwd(),
      env: { PATH, KUBECONFIG: kcfg.handle.path },
      timeoutMs: 20_000,
    });
    if (res.exitCode !== 0) {
      return NextResponse.json({
        ok: true,
        source: "builtin",
        resources: FALLBACK_RESOURCES,
        note: res.stderr.slice(-300) || "kubectl api-resources failed; showing built-in list.",
      });
    }
    const resources = parseApiResources(res.stdout);
    return NextResponse.json({
      ok: true,
      source: resources.length ? "cluster" : "builtin",
      resources: resources.length ? resources : FALLBACK_RESOURCES,
    });
  } finally {
    await kcfg.handle.cleanup().catch(() => {});
  }
}
