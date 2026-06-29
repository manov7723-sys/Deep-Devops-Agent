/**
 * Super-admin gate for /admin/* routes. Non-admins get a 404 to avoid
 * disclosing the surface (per DECISIONS.md).
 */
import { NextResponse } from "next/server";
import { getActiveSession, type LoadedSession } from "./session";

export type AdminGate =
  | { ok: true; session: LoadedSession }
  | { ok: false; status: 401 | 404 };

export async function requireSuperAdmin(): Promise<AdminGate> {
  const session = await getActiveSession();
  if (!session) return { ok: false, status: 401 };
  if (!session.user.isSuperAdmin) return { ok: false, status: 404 };
  return { ok: true, session };
}

export function adminGateResponse(status: 401 | 404): Response {
  return NextResponse.json({ ok: false }, { status });
}
