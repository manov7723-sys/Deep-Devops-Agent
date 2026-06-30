import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";

/**
 * GET /projects/[slug]/audit-log
 *
 * Read-only project-scoped audit trail. Returns the latest 200 AuditLog
 * rows where `projectId = this project`. Includes the actor's name so the
 * UI doesn't need a second roundtrip.
 *
 * Query params:
 *   ?action=<prefix>   filter by action prefix ("pipeline.", "billing.")
 *   ?limit=<n>         override default (200), clamped 1..500
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const url = new URL(req.url);
  const actionPrefix = url.searchParams.get("action")?.trim();
  const limitParam = Number(url.searchParams.get("limit") ?? "200");
  const limit = Math.min(500, Math.max(1, Number.isFinite(limitParam) ? limitParam : 200));

  const rows = await prisma.auditLog.findMany({
    where: {
      projectId: gate.access.project.id,
      ...(actionPrefix ? { action: { startsWith: actionPrefix } } : {}),
    },
    orderBy: { createdAt: "desc" },
    take: limit,
    include: { user: { select: { name: true, email: true } } },
  });

  return NextResponse.json(
    rows.map((r) => ({
      id: r.id,
      action: r.action,
      targetType: r.targetType,
      targetId: r.targetId,
      actorName: r.user?.name ?? null,
      actorEmail: r.user?.email ?? null,
      ipAddress: r.ipAddress,
      metadata: r.metadata,
      createdAt: r.createdAt.toISOString(),
    })),
  );
}
