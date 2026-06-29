import { NextResponse } from "next/server";
import { getActiveSession } from "@/lib/auth/session";
import { listMyPaymentMethods } from "@/lib/billing/billing";

export async function GET() {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  const methods = await listMyPaymentMethods(sess.userId);
  return NextResponse.json({ methods });
}
