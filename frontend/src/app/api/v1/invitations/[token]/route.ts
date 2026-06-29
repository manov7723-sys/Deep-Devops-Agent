import { NextResponse } from "next/server";
import { previewInvitationByToken } from "@/lib/projects/invitations";

/**
 * Public preview of an invitation: shows the project name + role so the accept
 * page can render meaningful copy. Does NOT consume the token.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ token: string }> }) {
  const { token } = await ctx.params;
  const preview = await previewInvitationByToken(token);
  if (!preview) {
    return NextResponse.json(
      {
        ok: false,
        code: "not_found",
        message: "This invitation link isn't valid, has expired, or was already used.",
      },
      { status: 400 },
    );
  }
  return NextResponse.json({
    ok: true,
    projectName: preview.projectName,
    projectSlug: preview.projectSlug,
    inviterName: preview.inviterName,
    role: preview.role,
    invitedEmail: preview.invitedEmail,
    expiresAt: preview.expiresAt.toISOString(),
  });
}
