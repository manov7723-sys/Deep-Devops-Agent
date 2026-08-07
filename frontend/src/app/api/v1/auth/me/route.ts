import { NextResponse } from "next/server";
import { getActiveSession } from "@/lib/auth/session";

export async function GET() {
  const sess = await getActiveSession();
  if (!sess) {
    return NextResponse.json(
      { ok: false, code: "unauthenticated", message: "No active session." },
      { status: 401 },
    );
  }
  return NextResponse.json({
    ok: true,
    user: {
      id: sess.user.id,
      email: sess.user.email,
      name: sess.user.name,
      isSuperAdmin: sess.user.isSuperAdmin,
      twoFactorEnabled: sess.user.twoFactorEnabled,
      globalAccess: sess.user.globalAccess,
      // Consolidated "can this account create projects" flag. The client
      // uses it to hide the New Project button — the server-side gate on
      // /projects still rejects a non-admin attempt.
      canCreateProjects: sess.user.isSuperAdmin || sess.user.globalAccess === "admin",
    },
  });
}
