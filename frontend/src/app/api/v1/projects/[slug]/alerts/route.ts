import { NextResponse } from "next/server";
import type { AlertCategory, AlertSeverity, AlertStatus } from "@prisma/client";
import { CreateAlertRequest } from "@/lib/api/schemas/agentops-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { createAlert, listAlerts } from "@/lib/agentops/alerts";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const sp = new URL(req.url).searchParams;
  const cat = sp.get("category") ?? sp.get("cat");
  const sev = sp.get("severity");
  const st = sp.get("status");
  const envKey = sp.get("env");

  let envId: string | undefined;
  if (envKey && envKey !== "all") {
    const env = await envBySlugAndKey(gate.access.project.id, envKey);
    if (!env) return NextResponse.json([]);
    envId = env.id;
  }

  const alerts = await listAlerts(gate.access.project.id, {
    category: isCategory(cat) ? cat : undefined,
    severity: isSeverity(sev) ? sev : undefined,
    status: isStatus(st) ? st : undefined,
    envId,
  });
  return NextResponse.json(alerts);
}

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = CreateAlertRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const env = await envBySlugAndKey(gate.access.project.id, parsed.data.envKey);
  if (!env) return NextResponse.json({ ok: false, code: "env_not_found" }, { status: 404 });

  const alert = await createAlert({
    projectId: gate.access.project.id,
    envId: env.id,
    title: parsed.data.title,
    detail: parsed.data.detail,
    resource: parsed.data.resource,
    sourceLabel: parsed.data.sourceLabel,
    category: parsed.data.category,
    severity: parsed.data.severity,
    recommendation: parsed.data.recommendation,
  });
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "alert.created",
    targetType: "alert",
    targetId: alert.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { envKey: parsed.data.envKey, severity: parsed.data.severity },
  });
  return NextResponse.json({ ok: true, alert });
}

function isCategory(v: string | null | undefined): v is AlertCategory {
  return v === "Security" || v === "Performance" || v === "Compliance" || v === "Reliability";
}
function isSeverity(v: string | null | undefined): v is AlertSeverity {
  return v === "low" || v === "medium" || v === "high";
}
function isStatus(v: string | null | undefined): v is AlertStatus {
  return v === "open" || v === "ack" || v === "resolved";
}
