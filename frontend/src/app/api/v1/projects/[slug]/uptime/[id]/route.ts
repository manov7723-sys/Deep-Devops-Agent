import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { prisma } from "@/lib/db/prisma";

/**
 * Resolve any still-open alerts a monitor raised (its uptime + cert alerts), so a
 * deleted/disabled monitor doesn't leave an orphaned "… is DOWN" alert stuck on
 * the banner forever (nothing else would ever resolve it).
 */
async function resolveMonitorAlerts(projectId: string, monitorId: string) {
  await prisma.alert.updateMany({
    where: {
      projectId,
      sourceLabel: { in: [`uptime:${monitorId}`, `uptime-cert:${monitorId}`] },
      status: { not: "resolved" },
    },
    data: { status: "resolved", resolvedAt: new Date() },
  });
}

/**
 * PATCH { name?, url?, expectedStatus?, intervalSec?, enabled? } → update a monitor
 * DELETE → remove a monitor
 */
const Patch = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  url: z.string().trim().url().optional(),
  method: z.enum(["GET", "HEAD"]).optional(),
  expectedStatus: z.number().int().min(100).max(599).optional(),
  intervalSec: z.number().int().min(30).max(86400).optional(),
  enabled: z.boolean().optional(),
});

async function owned(projectId: string, id: string) {
  return prisma.uptimeMonitor.findFirst({ where: { id, projectId }, select: { id: true } });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  if (!(await owned(gate.access.project.id, id)))
    return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
  const parsed = Patch.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  const m = await prisma.uptimeMonitor.update({ where: { id }, data: parsed.data });
  // Disabling (or pausing) a monitor should clear its open alerts — a paused
  // monitor will never recover to auto-resolve them.
  if (parsed.data.enabled === false) await resolveMonitorAlerts(gate.access.project.id, id);
  return NextResponse.json({ ok: true, monitor: m });
}

export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  if (!(await owned(gate.access.project.id, id)))
    return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
  await resolveMonitorAlerts(gate.access.project.id, id); // don't orphan its open alerts
  await prisma.uptimeMonitor.delete({ where: { id } });
  return NextResponse.json({ ok: true });
}
