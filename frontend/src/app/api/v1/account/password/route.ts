import { NextResponse } from "next/server";
import { PasswordPolicy } from "@/lib/api/schemas/auth";

// Phase 3 will verify `current` against the stored argon2 hash and persist the
// new hash via `hashPassword`. Phase 1 keeps the stub but uses the shared policy.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as {
    current?: string;
    password?: string;
    confirmPassword?: string;
  };
  if (!body.current || body.current.length < 1) {
    return NextResponse.json({ ok: false, code: "current_required" }, { status: 400 });
  }
  const pwOk = PasswordPolicy.safeParse(body.password ?? "");
  if (!pwOk.success) {
    return NextResponse.json(
      {
        ok: false,
        code: "weak_password",
        message: pwOk.error.errors[0]?.message ?? "Password must meet all requirements.",
      },
      { status: 400 },
    );
  }
  if (body.password !== body.confirmPassword) {
    return NextResponse.json({ ok: false, code: "mismatch", message: "New passwords do not match." }, { status: 400 });
  }
  return NextResponse.json({ ok: true });
}
