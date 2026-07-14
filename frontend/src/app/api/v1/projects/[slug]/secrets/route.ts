import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import {
  listSecretKeys,
  setSecret,
  deleteSecret,
  SECRET_KEY_RE,
} from "@/lib/integrations/secrets-store";

/**
 * App secrets (values never returned to the client).
 *   GET    → [{ key, updatedAt }]
 *   PUT    { key, value } → create/update
 *   DELETE ?key=…         → remove
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  return NextResponse.json({ ok: true, secrets: await listSecretKeys(gate.access.project.id) });
}

const PutBody = z.object({
  key: z
    .string()
    .trim()
    .min(1)
    .max(253)
    .regex(
      SECRET_KEY_RE,
      "Keys must start with a letter/underscore and contain only letters, digits, _, . or -",
    ),
  value: z.string().max(1_000_000),
});

export async function PUT(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const parsed = PutBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  await setSecret(gate.access.project.id, parsed.data.key, parsed.data.value);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const key = (new URL(req.url).searchParams.get("key") || "").trim();
  if (!key)
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: "key is required." },
      { status: 400 },
    );
  await deleteSecret(gate.access.project.id, key);
  return NextResponse.json({ ok: true });
}
