import { NextResponse } from "next/server";
import { getActiveSession } from "@/lib/auth/session";
import { listMyAddons } from "@/lib/billing/billing";

export async function GET() {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  const items = await listMyAddons(sess.userId);
  return NextResponse.json({ items });
}
