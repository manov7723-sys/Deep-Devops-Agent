import { NextResponse } from "next/server";
import { UpdateCloudProviderRequest } from "@/lib/api/schemas/connectivity-api";
import { getActiveSession } from "@/lib/auth/session";
import { deleteProvider, updateProvider } from "@/lib/cloud/providers";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function PATCH(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  const { id } = await ctx.params;
  const parsed = UpdateCloudProviderRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid_request",
        message: parsed.error.errors[0]?.message ?? "Invalid update.",
      },
      { status: 400 },
    );
  }
  const res = await updateProvider(sess.userId, id, parsed.data);
  if (!res.ok) return NextResponse.json({ ok: false, code: res.code }, { status: 404 });
  const meta = extractRequestMeta(req);
  await audit({
    userId: sess.userId,
    action: "cloud_provider.updated",
    targetType: "cloud_provider",
    targetId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: Object.keys(parsed.data),
  });
  return NextResponse.json({ ok: true, provider: res.provider });
}

export async function DELETE(req: Request, ctx: { params: Promise<{ id: string }> }) {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  const { id } = await ctx.params;
  const res = await deleteProvider(sess.userId, id);
  if (!res.ok) {
    const status = res.code === "in_use" ? 409 : 404;
    const message =
      res.code === "in_use"
        ? "This provider is in use by one or more environments."
        : "Provider not found.";
    return NextResponse.json({ ok: false, code: res.code, message }, { status });
  }
  const meta = extractRequestMeta(req);
  await audit({
    userId: sess.userId,
    action: "cloud_provider.removed",
    targetType: "cloud_provider",
    targetId: id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
  return NextResponse.json({ ok: true });
}
