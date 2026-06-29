import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { archiveProject, unarchiveProject } from "@/lib/projects/projects";
import { audit } from "@/lib/audit/log";
import { recordActivity } from "@/lib/agentops/activity";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * Archive — sets archivedAt. Reversible. Owner-only.
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "owner");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  if (gate.access.project.archivedAt) {
    return NextResponse.json(
      { ok: false, code: "already_archived" },
      { status: 409 },
    );
  }
  const { archivedAt } = await archiveProject(gate.access.project.id);
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "project.archived",
    targetType: "project",
    targetId: gate.access.project.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
  await recordActivity({
    projectId: gate.access.project.id,
    actorUserId: gate.access.session.userId,
    action: "archived",
    targetType: "project",
    targetLabel: gate.access.project.name,
    icon: "lock",
  }).catch(() => {});
  return NextResponse.json({ ok: true, archivedAt });
}

/**
 * Unarchive — clears archivedAt. Owner-only.
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "owner");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  if (!gate.access.project.archivedAt) {
    return NextResponse.json(
      { ok: false, code: "not_archived" },
      { status: 409 },
    );
  }
  await unarchiveProject(gate.access.project.id);
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "project.unarchived",
    targetType: "project",
    targetId: gate.access.project.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
  await recordActivity({
    projectId: gate.access.project.id,
    actorUserId: gate.access.session.userId,
    action: "unarchived",
    targetType: "project",
    targetLabel: gate.access.project.name,
    icon: "unlock",
  }).catch(() => {});
  return NextResponse.json({ ok: true });
}
