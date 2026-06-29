import { NextResponse } from "next/server";
import { SetAwsKeysRequest } from "@/lib/api/schemas/connectivity-api";
import { getActiveSession } from "@/lib/auth/session";
import {
  getProviderForUser,
  setProviderCredVaultPath,
} from "@/lib/cloud/providers";
import {
  deleteAwsKeys,
  providerVaultPath,
  saveAwsKeys,
} from "@/lib/cloud/vault";
import { getVaultConfigView } from "@/lib/cloud/vault-config";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/** Whether Vault is configured (for this user) + whether keys are stored. */
export async function GET(_req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  const { id } = await ctx.params;
  const cp = await getProviderForUser(sess.userId, id);
  if (!cp) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
  // Vault is per-PROJECT now — read the config of the project this provider belongs to.
  const view = cp.projectId ? await getVaultConfigView(cp.projectId) : null;
  return NextResponse.json({
    vaultConfigured: view?.configured ?? false,
    hasVaultCreds: !!cp.credVaultPath,
  });
}

/** Store an AWS access key + secret for this provider in Vault. */
export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  const { id } = await ctx.params;

  const cp = await getProviderForUser(sess.userId, id);
  if (!cp) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
  if (cp.kind !== "aws") {
    return NextResponse.json(
      { ok: false, code: "kind_unsupported", message: "Vault keys are only supported for AWS providers." },
      { status: 400 },
    );
  }
  const vaultView = cp.projectId ? await getVaultConfigView(cp.projectId) : null;
  if (!vaultView?.configured) {
    return NextResponse.json(
      { ok: false, code: "vault_unconfigured", message: "Configure this project's Vault connection (URL + token) first." },
      { status: 409 },
    );
  }

  const parsed = SetAwsKeysRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }

  try {
    await saveAwsKeys(id, {
      accessKeyId: parsed.data.accessKeyId,
      secretAccessKey: parsed.data.secretAccessKey,
      region: parsed.data.region ?? cp.region,
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, code: "vault_error", message: String(e) },
      { status: 502 },
    );
  }
  await setProviderCredVaultPath(sess.userId, id, providerVaultPath(id));

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

/** Remove the provider's stored AWS keys from Vault. */
export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  const { id } = await ctx.params;
  const cp = await getProviderForUser(sess.userId, id);
  if (!cp) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });

  try {
    await deleteAwsKeys(id);
  } catch (e) {
    return NextResponse.json({ ok: false, code: "vault_error", message: String(e) }, { status: 502 });
  }
  await setProviderCredVaultPath(sess.userId, id, null);

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
