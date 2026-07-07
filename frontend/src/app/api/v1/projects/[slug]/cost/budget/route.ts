import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { prisma } from "@/lib/db/prisma";

/** POST /projects/[slug]/cost/budget — set this project's monthly budget ($). */
const Body = z.object({ budgetDollars: z.number().min(0).max(10_000_000) });

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ ok: false, code: "invalid_request" }, { status: 400 });

  const budgetCents = Math.round(parsed.data.budgetDollars * 100);
  const now = new Date();
  const periodStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const projectId = gate.access.project.id;

  // Set budget on the current month's snapshot (create a stub if none yet).
  const existing = await prisma.costSnapshot.findUnique({
    where: { projectId_periodStart: { projectId, periodStart } },
    select: { id: true },
  });
  if (existing) {
    await prisma.costSnapshot.update({ where: { id: existing.id }, data: { budgetCents } });
  } else {
    await prisma.costSnapshot.create({ data: { projectId, periodStart, totalCents: 0, budgetCents } });
  }
  return NextResponse.json({ ok: true, budgetCents });
}
