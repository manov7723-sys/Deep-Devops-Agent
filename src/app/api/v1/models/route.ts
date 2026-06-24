import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { getActiveSession } from "@/lib/auth/session";

/**
 * Public list of models a user can pick as their project default. Only
 * returns rows where `enabled = true` (admin has flipped them on); the
 * admin-only `/admin/models` surface returns everything including disabled.
 */
export async function GET() {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  const rows = await prisma.model.findMany({
    where: { enabled: true },
    orderBy: [{ isDefault: "desc" }, { name: "asc" }],
    select: {
      id: true,
      name: true,
      provider: true,
      ctxTokens: true,
      isDefault: true,
    },
  });
  return NextResponse.json(
    rows.map((m) => ({
      id: m.id,
      name: m.name,
      provider: m.provider,
      ctx: m.ctxTokens
        ? m.ctxTokens >= 1_000_000
          ? `${(m.ctxTokens / 1_000_000).toFixed(0)}M`
          : `${Math.round(m.ctxTokens / 1000)}K`
        : "—",
      isDefault: m.isDefault,
    })),
  );
}
