import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { prisma } from "@/lib/db/prisma";
import {
  listEnvThresholds,
  upsertThreshold,
  resetThreshold,
  METRIC_KEYS,
} from "@/lib/observability/thresholds";

/**
 * Custom alarm thresholds per environment + metric. Drives both the live
 * in-cluster evaluation and the cloud alarms (AWS/Azure/GCP).
 *   GET    ?envKey=…                         → list (defaults flagged)
 *   PUT    { envKey, metric, percent, … }    → create/update a rule
 *   DELETE { envKey, metric }                → reset the metric to its default
 */
async function resolveEnv(projectId: string, envKey: string) {
  return prisma.env.findFirst({ where: { projectId, key: envKey }, select: { id: true } });
}

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const envKey = (new URL(req.url).searchParams.get("envKey") || "").trim();
  if (!envKey)
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: "envKey is required." },
      { status: 400 },
    );
  const env = await resolveEnv(gate.access.project.id, envKey);
  if (!env) return NextResponse.json({ ok: false, code: "env_not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, thresholds: await listEnvThresholds(env.id) });
}

const PutBody = z.object({
  envKey: z.string().trim().min(1),
  metric: z.enum(METRIC_KEYS as [string, ...string[]]),
  percent: z.number().int().min(1).max(100),
  severity: z.enum(["low", "medium", "high"]).default("high"),
  enabled: z.boolean().default(true),
});

export async function PUT(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const parsed = PutBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  const env = await resolveEnv(gate.access.project.id, parsed.data.envKey);
  if (!env) return NextResponse.json({ ok: false, code: "env_not_found" }, { status: 404 });
  const row = await upsertThreshold(
    gate.access.project.id,
    env.id,
    parsed.data.metric as "cpu" | "memory" | "disk",
    parsed.data.percent,
    parsed.data.severity,
    parsed.data.enabled,
  );
  return NextResponse.json({ ok: true, threshold: row });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const sp = new URL(req.url).searchParams;
  const envKey = (sp.get("envKey") || "").trim();
  const metric = (sp.get("metric") || "").trim();
  if (!envKey || !(METRIC_KEYS as string[]).includes(metric)) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: "envKey and a valid metric are required." },
      { status: 400 },
    );
  }
  const env = await resolveEnv(gate.access.project.id, envKey);
  if (!env) return NextResponse.json({ ok: false, code: "env_not_found" }, { status: 404 });
  await resetThreshold(env.id, metric as "cpu" | "memory" | "disk");
  return NextResponse.json({ ok: true });
}
