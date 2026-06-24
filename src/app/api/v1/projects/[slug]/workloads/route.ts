import { NextResponse } from "next/server";
import type { ResourceCategory } from "@prisma/client";
import { CreateWorkloadRequest } from "@/lib/api/schemas/insights-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { createWorkload, listWorkloads } from "@/lib/insights/workloads";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const sp = new URL(req.url).searchParams;
  const envKey = sp.get("env");
  const cat = sp.get("category");
  let envId: string | undefined;
  if (envKey && envKey !== "all") {
    const env = await envBySlugAndKey(gate.access.project.id, envKey);
    if (!env) return NextResponse.json([]);
    envId = env.id;
  }
  const workloads = await listWorkloads(gate.access.project.id, {
    envId,
    category: isCategory(cat) ? cat : undefined,
  });
  return NextResponse.json(workloads);
}

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = CreateWorkloadRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const env = await envBySlugAndKey(gate.access.project.id, parsed.data.envKey);
  if (!env) return NextResponse.json({ ok: false, code: "env_not_found" }, { status: 404 });

  const workload = await createWorkload({
    projectId: gate.access.project.id,
    envId: env.id,
    name: parsed.data.name,
    category: parsed.data.category,
    type: parsed.data.type,
    provisionedBy: parsed.data.provisionedBy,
    enabled: parsed.data.enabled,
    region: parsed.data.region,
    cpuPct: parsed.data.cpuPct,
    memPct: parsed.data.memPct,
    replicasReady: parsed.data.replicasReady,
    replicasDesired: parsed.data.replicasDesired,
    cloudProviderId: parsed.data.cloudProviderId,
  });
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "workload.created",
    targetType: "workload",
    targetId: workload.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { envKey: parsed.data.envKey, category: parsed.data.category },
  });
  return NextResponse.json({ ok: true, workload });
}

function isCategory(v: string | null | undefined): v is ResourceCategory {
  return (
    v === "compute" ||
    v === "network" ||
    v === "storage" ||
    v === "data" ||
    v === "cache" ||
    v === "security" ||
    v === "other"
  );
}
