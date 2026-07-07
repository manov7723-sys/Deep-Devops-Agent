import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { prisma } from "@/lib/db/prisma";
import { estimateInfraCost, INSTANCE_TYPES, DEFAULT_INSTANCE_TYPE, type Cloud } from "@/lib/cost/estimate";

/**
 * GET → the clouds THIS project is connected to (so the estimator uses the
 * project's own provider — AWS project → AWS pricing, etc.) plus the priced
 * instance-type options per cloud for the dropdown.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const rows = await prisma.cloudProvider.findMany({
    where: { projectId: gate.access.project.id },
    select: { kind: true },
    distinct: ["kind"],
  });
  const clouds = rows.map((r) => r.kind).filter((k): k is Cloud => k === "aws" || k === "azure" || k === "gcp");
  return NextResponse.json({ ok: true, clouds, instanceTypes: INSTANCE_TYPES, defaults: DEFAULT_INSTANCE_TYPE });
}

/** Monthly infra cost estimate (deterministic — no AI). POST the infra spec. */
const Body = z.object({
  cloud: z.enum(["aws", "azure", "gcp"]),
  instanceType: z.string().trim().optional(),
  nodeCount: z.number().int().min(0).max(1000).optional(),
  managedK8s: z.boolean().optional(),
  storageGb: z.number().min(0).max(1_000_000).optional(),
  loadBalancers: z.number().int().min(0).max(1000).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ ok: false, message: parsed.error.issues[0]?.message }, { status: 400 });

  // Enforce project-cloud-awareness SERVER-SIDE (not just in the UI): only price
  // for a cloud this project is actually connected to. Single-cloud projects are
  // locked to their one cloud regardless of what the body asked for.
  const rows = await prisma.cloudProvider.findMany({ where: { projectId: gate.access.project.id }, select: { kind: true }, distinct: ["kind"] });
  const clouds = rows.map((r) => r.kind).filter((k): k is Cloud => k === "aws" || k === "azure" || k === "gcp");
  if (clouds.length === 0) return NextResponse.json({ ok: false, message: "This project has no cloud provider connected. Connect one on the Cloud providers page first." }, { status: 400 });
  const cloud: Cloud = clouds.length === 1 ? clouds[0] : parsed.data.cloud;
  if (!clouds.includes(cloud)) return NextResponse.json({ ok: false, message: `This project isn't connected to ${cloud}. Connected: ${clouds.join(", ")}.` }, { status: 400 });

  return NextResponse.json(estimateInfraCost({ ...parsed.data, cloud }));
}
