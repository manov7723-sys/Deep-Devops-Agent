import { NextResponse } from "next/server";
import { z } from "zod";
import { adminGateResponse, requireSuperAdmin } from "@/lib/auth/admin-gate";
import { grantTokensToUser } from "@/lib/admin/aggregates";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

const GrantBody = z.object({
  amount: z.number().int().min(1, "Amount must be at least 1").max(1_000_000_000),
  reason: z.string().trim().max(280).optional(),
});

/**
 * POST /admin/users/[id]/grant-tokens
 *
 * Super-admin credits N tokens to a user's Usage.tokensGranted. Idempotency
 * is at the caller — the audit row records who did what and why; replays
 * stack. Use small amounts (≤ 10M typical pack sizes); the upper cap of 1B
 * is just a sanity bound.
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const gate = await requireSuperAdmin();
  if (!gate.ok) return adminGateResponse(gate.status);

  const { id } = await params;
  const parsed = GrantBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }

  const result = await grantTokensToUser({ userId: id, amount: parsed.data.amount });
  if (!result.ok) {
    return NextResponse.json({ ok: false, code: result.code }, { status: 404 });
  }

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.session.userId,
    action: "admin.tokens_granted",
    targetType: "user",
    targetId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: {
      amount: parsed.data.amount,
      reason: parsed.data.reason ?? null,
      tokensGranted: result.tokensGranted,
      tokensRemaining: result.tokensRemaining,
    },
  });

  return NextResponse.json({
    ok: true,
    tokensGranted: result.tokensGranted,
    tokensRemaining: result.tokensRemaining,
  });
}
