import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { queryPrometheusInstant, queryPrometheusRange } from "@/lib/observability/prometheus";

/**
 * POST /projects/[slug]/observability/prometheus/query
 *
 * Run a PromQL query against the project's connected Prometheus and return the
 * result, so the app can render metrics natively. `type: "instant"` for a
 * snapshot, `"range"` for a time series.
 */
const Body = z.object({
  query: z.string().trim().min(1).max(2000),
  type: z.enum(["instant", "range"]).default("instant"),
  minutes: z.number().int().min(1).max(1440).optional(),
  step: z.number().int().min(5).max(3600).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
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
  const { query, type, minutes, step } = parsed.data;

  const result =
    type === "range"
      ? await queryPrometheusRange(
          gate.access.project.id,
          query,
          Math.floor(Date.now() / 1000),
          minutes ?? 60,
          step ?? 30,
        )
      : await queryPrometheusInstant(gate.access.project.id, query);

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, code: "query_failed", message: result.error },
      { status: 400 },
    );
  }
  return NextResponse.json(result);
}
