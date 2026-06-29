import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { createScrapeTarget, detectScrapeCandidates } from "@/lib/observability/cluster-monitoring";

/**
 * POST /projects/[slug]/envs/[key]/monitoring/scrape
 *
 * Create a ServiceMonitor or PodMonitor so Prometheus scrapes the app's own
 * /metrics endpoint (request rate, latency, custom metrics). Requires the app
 * to expose Prometheus-format metrics.
 */
const Body = z.object({
  kind: z.enum(["ServiceMonitor", "PodMonitor"]),
  name: z.string().trim().min(1).max(60),
  namespace: z.string().trim().min(1).max(63),
  // selector: matchLabels as a record, or a single key/value pair.
  matchLabels: z.record(z.string(), z.string()).optional(),
  selectorKey: z.string().trim().optional(),
  selectorValue: z.string().trim().optional(),
  port: z.string().trim().min(1).max(40),
  path: z.string().trim().max(200).optional(),
  interval: z.string().trim().max(20).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message }, { status: 400 });
  }
  const d = parsed.data;

  const matchLabels = d.matchLabels && Object.keys(d.matchLabels).length
    ? d.matchLabels
    : d.selectorKey && d.selectorValue
      ? { [d.selectorKey]: d.selectorValue }
      : null;
  if (!matchLabels) {
    return NextResponse.json({ ok: false, code: "no_selector", message: "Provide a label selector (e.g. app=vote)." }, { status: 400 });
  }

  const env = await envBySlugAndKey(gate.access.project.id, key);
  if (!env) return NextResponse.json({ ok: false, code: "env_not_found" }, { status: 404 });

  const res = await createScrapeTarget(env.id, {
    kind: d.kind,
    name: d.name,
    namespace: d.namespace,
    matchLabels,
    port: d.port,
    path: d.path || "/metrics",
    interval: d.interval || "30s",
  });
  return NextResponse.json(res, { status: res.ok ? 200 : 400 });
}

/** GET ?namespace=… — auto-detect scrape candidates (labels + metrics port). */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const env = await envBySlugAndKey(gate.access.project.id, key);
  if (!env) return NextResponse.json({ ok: false, code: "env_not_found" }, { status: 404 });

  const namespace = new URL(req.url).searchParams.get("namespace") || env.namespace || "default";
  const res = await detectScrapeCandidates(env.id, namespace);
  if (!res.ok) return NextResponse.json({ ok: false, message: res.error }, { status: 400 });
  return NextResponse.json({ ok: true, namespace, candidates: res.candidates });
}
