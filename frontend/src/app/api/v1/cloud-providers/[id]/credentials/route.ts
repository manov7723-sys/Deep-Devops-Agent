import { NextResponse } from "next/server";
import { SetAwsKeysRequest } from "@/lib/api/schemas/connectivity-api";
import { getActiveSession } from "@/lib/auth/session";
import { getProviderForUser, setProviderAwsKeys } from "@/lib/cloud/providers";
import { encryptSecret } from "@/lib/auth/crypto";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/** Whether an AWS access key + secret are stored for this provider. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  const { id } = await ctx.params;
  const cp = await getProviderForUser(sess.userId, id);
  if (!cp) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
  return NextResponse.json({ hasAwsKeysStored: !!cp.awsAccessKeyIdEnc });
}

/** Store an AWS access key + secret for this provider, encrypted at rest. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  const { id } = await ctx.params;

  const cp = await getProviderForUser(sess.userId, id);
  if (!cp) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
  if (cp.kind !== "aws") {
    return NextResponse.json(
      {
        ok: false,
        code: "kind_unsupported",
        message: "Access keys are only supported for AWS providers.",
      },
      { status: 400 },
    );
  }

  const parsed = SetAwsKeysRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }

  const result = await setProviderAwsKeys(sess.userId, id, {
    accessKeyIdEnc: encryptSecret(parsed.data.accessKeyId),
    secretAccessKeyEnc: encryptSecret(parsed.data.secretAccessKey),
  });
  if (!result.ok) return NextResponse.json({ ok: false, code: result.code }, { status: 404 });

  const meta = extractRequestMeta(req);
  await audit({
    userId: sess.userId,
    action: "cloud_provider.credentials_set",
    targetType: "cloud_provider",
    targetId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    // Never log the secret — only that one was set + the masked access key id.
    metadata: { accessKeyId: parsed.data.accessKeyId.slice(0, 4) + "…" },
  });
  return NextResponse.json({ ok: true });
}

/** Remove the provider's stored AWS keys. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  const { id } = await ctx.params;
  const cp = await getProviderForUser(sess.userId, id);
  if (!cp) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });

  const result = await setProviderAwsKeys(sess.userId, id, null);
  if (!result.ok) return NextResponse.json({ ok: false, code: result.code }, { status: 404 });

  const meta = extractRequestMeta(req);
  await audit({
    userId: sess.userId,
    action: "cloud_provider.credentials_cleared",
    targetType: "cloud_provider",
    targetId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
  return NextResponse.json({ ok: true });
}
