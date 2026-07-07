import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { listEnvs } from "@/lib/devops/envs";
import { createInfraApproval, type TerraformFile } from "@/lib/devops/infra-approval";
import { estimateInfraCost } from "@/lib/cost/estimate";

/**
 * Manually submit an infra change to the approval GATE (the same path the agent
 * uses via request_infra_approval) — so the gate can be tested/demoed WITHOUT
 * the AI. GET returns the project's envs (with their cloud) for the picker.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const envs = await listEnvs(gate.access.project.id);
  return NextResponse.json({
    ok: true,
    envs: envs.map((e) => ({ key: e.key, name: e.name, cloud: e.cloudKind })),
  });
}

const Body = z.object({
  envKey: z.string().trim().min(1),
  cloud: z.enum(["aws", "azure", "gcp"]).optional(), // ignored — derived from the env server-side
  title: z.string().trim().min(1).max(120),
  summary: z.string().trim().max(300).optional(),
  region: z.string().trim().optional(),
  instanceType: z.string().trim().optional(),
  nodeCount: z.number().int().min(0).max(1000).optional(),
  managedK8s: z.boolean().optional(),
  storageGb: z.number().min(0).max(1_000_000).optional(),
  loadBalancers: z.number().int().min(0).max(1000).optional(),
  publicBucket: z.boolean().optional(),
  hcl: z.string().max(200_000).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ ok: false, message: parsed.error.issues[0]?.message }, { status: 400 });
  const b = parsed.data;

  const envs = await listEnvs(gate.access.project.id);
  const env = envs.find((e) => e.key === b.envKey);
  if (!env) return NextResponse.json({ ok: false, message: `Env "${b.envKey}" not found.` }, { status: 400 });

  // Cloud is ALWAYS the env's connected cloud — never the client's choice. This
  // keeps the whole gate scoped to THIS project's cloud provider.
  const cloud = env.cloudKind === "aws" || env.cloudKind === "azure" || env.cloudKind === "gcp" ? env.cloudKind : null;
  if (!cloud) return NextResponse.json({ ok: false, message: `Environment "${b.envKey}" has no cloud provider connected.` }, { status: 400 });

  const files: TerraformFile[] = (b.hcl || "").trim() ? [{ path: "main.tf", content: b.hcl!.trim() }] : [];

  const est = estimateInfraCost({
    cloud,
    instanceType: b.instanceType,
    nodeCount: b.nodeCount,
    managedK8s: b.managedK8s,
    storageGb: b.storageGb,
    loadBalancers: b.loadBalancers,
  });

  const res = await createInfraApproval({
    projectId: gate.access.project.id,
    envId: env.id,
    envKey: env.key,
    title: b.title,
    summary: b.summary,
    cloud,
    region: b.region,
    instanceType: b.instanceType,
    publicBucket: b.publicBucket,
    name: b.title.toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 40) || "infra-change",
    files,
    costMonthly: est.monthly,
    planSummary: [
      { change: "add", text: b.summary || b.title },
      ...(b.instanceType && b.nodeCount ? [{ change: "add" as const, text: `${b.nodeCount} × ${b.instanceType} in ${b.region || "default region"}` }] : []),
    ],
  });

  if (!res.ok) return NextResponse.json({ ok: true, status: "blocked", violations: res.policy.violations, costMonthly: est.monthly });
  return NextResponse.json({ ok: true, status: "pending_approval", approvalId: res.approvalId, risk: res.risk, costMonthly: est.monthly });
}
