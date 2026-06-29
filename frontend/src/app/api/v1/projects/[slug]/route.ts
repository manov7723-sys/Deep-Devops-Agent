import { NextResponse } from "next/server";
import { UpdateProjectRequest } from "@/lib/api/schemas/projects-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { projectStats, softDeleteProject, updateProject } from "@/lib/projects/projects";
import { audit } from "@/lib/audit/log";
import { recordActivity } from "@/lib/agentops/activity";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const { project, role } = gate.access;
  const stats = await projectStats(project.id);
  return NextResponse.json({
    project: {
      id: project.id,
      slug: project.slug,
      name: project.name,
      description: project.description,
      colorHue: project.colorHue,
      health: project.health,
      cloud: project.cloud,
      ownerId: project.ownerId,
      archivedAt: project.archivedAt?.toISOString() ?? null,
      createdAt: project.createdAt.toISOString(),
      updatedAt: project.updatedAt.toISOString(),
      myRole: role,
      memberCount: stats.memberCount,
      pendingInvitations: stats.pendingInvitations,
    },
  });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const raw = await req.json().catch(() => ({}));
  const parsed = UpdateProjectRequest.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid_request",
        message: parsed.error.errors[0]?.message ?? "Invalid update.",
      },
      { status: 400 },
    );
  }
  await updateProject(gate.access.project.id, parsed.data);
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "project.updated",
    targetType: "project",
    targetId: gate.access.project.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: parsed.data,
  });
  return NextResponse.json({ ok: true });
}

/**
 * Soft-delete the project (sets deletedAt). Only the project owner can do
 * this — destructive lifecycle actions don't fall back to developer.
 */
export async function DELETE(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "owner");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const res = await softDeleteProject(gate.access.project.id);
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "project.deleted",
    targetType: "project",
    targetId: gate.access.project.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { slug: gate.access.project.slug, name: gate.access.project.name },
  });
  await recordActivity({
    projectId: gate.access.project.id,
    actorUserId: gate.access.session.userId,
    action: "deleted",
    targetType: "project",
    targetLabel: gate.access.project.name,
    icon: "trash",
  }).catch(() => {});
  return NextResponse.json({ ok: true, deletedAt: res.deletedAt });
}
