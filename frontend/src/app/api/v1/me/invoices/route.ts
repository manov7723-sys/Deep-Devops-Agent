import { NextResponse } from "next/server";
import { getActiveSession } from "@/lib/auth/session";
import { listMyInvoices } from "@/lib/billing/billing";

export async function GET() {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  const invoices = await listMyInvoices(sess.userId);
  return NextResponse.json({ invoices });
}
