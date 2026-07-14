import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { sendServiceTraffic } from "@/lib/observability/cluster-monitoring";

/** POST — send test HTTP traffic to a service so request-rate metrics show up. */
const Body = z.object({
  namespace: z.string().trim().min(1).max(63).optional(),
  service: z.string().trim().max(120).optional(),
  port: z.string().trim().max(10).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json(
      { ok: false, message: parsed.error.errors[0]?.message },
      { status: 400 },
    );

  const env = await envBySlugAndKey(gate.access.project.id, key);
  if (!env) return NextResponse.json({ ok: false, code: "env_not_found" }, { status: 404 });

  const namespace = parsed.data.namespace || env.namespace || "default";
  const res = await sendServiceTraffic(env.id, namespace, parsed.data.service, parsed.data.port);
  return NextResponse.json(res, { status: res.ok ? 200 : 400 });
}
