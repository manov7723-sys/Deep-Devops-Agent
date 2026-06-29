import { NextResponse } from "next/server";
import { listPlans } from "@/lib/billing/billing";

export async function GET() {
  const plans = await listPlans();
  return NextResponse.json({ plans });
}
