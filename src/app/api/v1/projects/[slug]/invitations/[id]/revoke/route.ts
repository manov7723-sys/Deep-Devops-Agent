import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { revokeInvitation } from "@/lib/projects/invitations";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string; id: string }> },
) {
  const { slug, id } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const ok = await revokeInvitation(gate.access.project.id, id);
  if (!ok) {
    return NextResponse.json(
      { ok: false, code: "not_found", message: "Invitation not found or already revoked." },
      { status: 404 },
    );
  }
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "project.invitation_revoked",
    targetType: "invitation",
    targetId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
  return NextResponse.json({ ok: true });
}
