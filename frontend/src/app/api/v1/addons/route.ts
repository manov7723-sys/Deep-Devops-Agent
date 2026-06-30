import { NextResponse } from "next/server";
import { listAddons } from "@/lib/billing/billing";

export async function GET() {
  const addons = await listAddons();
  return NextResponse.json({ addons });
}
