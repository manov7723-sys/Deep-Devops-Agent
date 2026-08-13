import { NextResponse } from "next/server";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";

/**
 * GET   — the project's saved Deployment Plan (null when analysis was skipped).
 * PATCH — update per-item statuses ({ items: { [id]: "accepted"|"skipped"|"applied" } }).
 *
 * The plan is advisory: PATCH only mutates bookkeeping, never cloud state.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const row = await prisma.deploymentPlan.findUnique({
    where: { projectId: gate.access.project.id },
  });
  return NextResponse.json({
    ok: true,
    plan: row
      ? {
          repoFullName: row.repoFullName,
          analyzedAt: row.analyzedAt.toISOString(),
          updatedAt: row.updatedAt.toISOString(),
          data: row.plan,
        }
      : null,
  });
}

const PatchBody = z.object({
  items: z.record(z.string(), z.enum(["accepted", "skipped", "applied"])),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }

  const row = await prisma.deploymentPlan.findUnique({
    where: { projectId: gate.access.project.id },
    select: { plan: true },
  });
  if (!row) return NextResponse.json({ ok: false, code: "no_plan" }, { status: 404 });

  const current = (row.plan ?? {}) as { report?: unknown; items?: Record<string, string> };
  const merged = { ...current, items: { ...(current.items ?? {}), ...parsed.data.items } };

  await prisma.deploymentPlan.update({
    where: { projectId: gate.access.project.id },
    data: { plan: merged as Prisma.InputJsonValue },
  });
  return NextResponse.json({ ok: true });
}
