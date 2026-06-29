import { NextResponse } from "next/server";
import { getActiveSession } from "@/lib/auth/session";
import { getMySubscription } from "@/lib/billing/billing";

/** Alias for /me/subscription — the project Stats screen calls this. */
export async function GET() {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  const subscription = await getMySubscription(sess.userId);
  return NextResponse.json({ subscription });
}
