import { NextResponse } from "next/server";
import { getActiveSession } from "@/lib/auth/session";
import { acceptInvitation } from "@/lib/projects/invitations";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * Accept an invitation. The caller MUST be signed in — and their email MUST
 * match the invited address. If they're signed in as the wrong user we 403
 * rather than silently creating a membership for the wrong identity.
 */
export async function POST(req: Request, ctx: { params: Promise<{ token: string }> }) {
  const sess = await getActiveSession();
  if (!sess) {
    return NextResponse.json(
      { ok: false, code: "unauthenticated", message: "Sign in to accept this invitation." },
      { status: 401 },
    );
  }
  const { token } = await ctx.params;
  const res = await acceptInvitation(token, sess.userId, sess.user.email);
  if (!res.ok) {
    const status =
      res.code === "email_mismatch" ? 403 :
      res.code === "already_member" ? 409 :
      400;
    return NextResponse.json(
      { ok: false, code: res.code, message: messageFor(res.code) },
      { status },
    );
  }
  const meta = extractRequestMeta(req);
  await audit({
    userId: sess.userId,
    action: "project.invitation_accepted",
    targetType: "invitation",
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { projectSlug: res.projectSlug, role: res.role },
  });
  return NextResponse.json({
    ok: true,
    projectSlug: res.projectSlug,
    role: res.role,
    redirect: `/p/${res.projectSlug}/dashboard`,
  });
}

function messageFor(
  code: "not_found" | "expired" | "consumed" | "email_mismatch" | "already_member",
): string {
  switch (code) {
    case "expired":
      return "This invitation has expired. Ask the inviter for a new one.";
    case "consumed":
      return "This invitation has already been accepted.";
    case "email_mismatch":
      return "This invitation was sent to a different email. Sign in with that account to accept.";
    case "already_member":
      return "You're already a member of this project.";
    default:
      return "This invitation link isn't valid.";
  }
}
