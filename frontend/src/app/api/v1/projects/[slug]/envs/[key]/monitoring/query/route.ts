import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { queryClusterPrometheus } from "@/lib/observability/cluster-monitoring";

/**
 * POST /projects/[slug]/envs/[key]/monitoring/query
 *
 * Run a PromQL query against the env's IN-CLUSTER Prometheus through the
 * Kubernetes API-server proxy (no exposed endpoint). Same request/response
 * shape as the Model-A /observability/prometheus/query route so the metrics
 * panel can target either source.
 */
const Body = z.object({
  query: z.string().trim().min(1).max(2000),
  type: z.enum(["instant", "range"]).default("instant"),
  minutes: z.number().int().min(1).max(1440).optional(),
  step: z.number().int().min(5).max(3600).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok)
    return NextResponse.json({ ok: false, code: `status_${gate.status}` }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }

  const env = await envBySlugAndKey(gate.access.project.id, key);
  if (!env)
    return NextResponse.json(
      { ok: false, code: "env_not_found", message: "Environment not found." },
      { status: 404 },
    );

  const { query, type, minutes, step } = parsed.data;
  const result = await queryClusterPrometheus(env.id, query, {
    range: type === "range",
    minutes,
    step,
  });

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, code: "query_failed", message: result.error },
      { status: 400 },
    );
  }
  return NextResponse.json(result);
}
