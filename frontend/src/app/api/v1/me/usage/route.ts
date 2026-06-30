import { NextResponse } from "next/server";
import { getActiveSession } from "@/lib/auth/session";
import { getMyUsage } from "@/lib/billing/billing";

export async function GET() {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  const usage = await getMyUsage(sess.userId);
  return NextResponse.json({ usage });
}
