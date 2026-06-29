import { NextResponse } from "next/server";
import { InviteRequest } from "@/lib/api/schemas/projects-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { createInvitation, listInvitations } from "@/lib/projects/invitations";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const invitations = await listInvitations(gate.access.project.id);
  return NextResponse.json(invitations);
}

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const raw = await req.json().catch(() => ({}));
  const parsed = InviteRequest.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid_request",
        message: parsed.error.errors[0]?.message ?? "Invalid invite.",
      },
      { status: 400 },
    );
  }
  const meta = extractRequestMeta(req);
  const origin = req.headers.get("origin") ?? new URL(req.url).origin;
  const res = await createInvitation({
    projectId: gate.access.project.id,
    projectName: gate.access.project.name,
    projectSlug: gate.access.project.slug,
    invitedById: gate.access.session.userId,
    inviterName: gate.access.session.user.name,
    email: parsed.data.email,
    role: parsed.data.role,
    origin,
    requestedIp: meta.ipAddress,
  });
  if (!res.ok) {
    const status = res.code === "already_member" ? 409 : 400;
    return NextResponse.json(
      { ok: false, code: res.code, message: messageFor(res.code) },
      { status },
    );
  }
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "project.invitation_created",
    targetType: "invitation",
    targetId: res.invitationId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { email: parsed.data.email, role: parsed.data.role },
  });
  return NextResponse.json({
    ok: true,
    invitationId: res.invitationId,
    expiresAt: res.expiresAt.toISOString(),
  });
}

function messageFor(code: "already_member" | "already_invited"): string {
  if (code === "already_member") return "That user is already a member of this project.";
  return "There is already a pending invitation for that email.";
}
