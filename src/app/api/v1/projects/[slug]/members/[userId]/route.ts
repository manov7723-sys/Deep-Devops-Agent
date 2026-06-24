import { NextResponse } from "next/server";
import { ChangeRoleRequest } from "@/lib/api/schemas/projects-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { changeMemberRole, removeMember } from "@/lib/projects/projects";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function PATCH(
  req: Request,
  ctx: { params: Promise<{ slug: string; userId: string }> },
) {
  const { slug, userId } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const raw = await req.json().catch(() => ({}));
  const parsed = ChangeRoleRequest.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_role", message: "Role must be developer or viewer." },
      { status: 400 },
    );
  }
  const res = await changeMemberRole(gate.access.project.id, userId, parsed.data.role);
  if (!res.ok) {
    const status = res.code === "not_a_member" ? 404 : 400;
    return NextResponse.json({ ok: false, code: res.code }, { status });
  }
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "project.member_role_changed",
    targetType: "user",
    targetId: userId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { role: parsed.data.role },
  });
  return NextResponse.json({ ok: true });
}

export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ slug: string; userId: string }> },
) {
  const { slug, userId } = await ctx.params;
  // Self-leave is allowed for any role; managing others requires developer.
  const gate = await requireProjectAccess(
    slug,
    // tighter check inline: leaving yourself = viewer is fine; removing
    // someone else = developer+
    "viewer",
  );
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const isSelf = gate.access.session.userId === userId;
  if (!isSelf) {
    // Need manage permission to remove someone else.
    const mgr = await requireProjectAccess(slug, "developer");
    if (!mgr.ok) return NextResponse.json({ ok: false }, { status: mgr.status });
  }
  const res = await removeMember(gate.access.project.id, userId);
  if (!res.ok) {
    const status = res.code === "not_a_member" ? 404 : 400;
    return NextResponse.json({ ok: false, code: res.code }, { status });
  }
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "project.member_removed",
    targetType: "user",
    targetId: userId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { self: isSelf },
  });
  return NextResponse.json({ ok: true });
}
