import { NextResponse } from "next/server";
import { getActiveSession } from "@/lib/auth/session";
import { listSessionsForUser } from "@/lib/auth/sessions";

export async function GET() {
  const sess = await getActiveSession();
  if (!sess) {
    return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  }
  const sessions = await listSessionsForUser(sess.userId);
  return NextResponse.json({ sessions });
}
