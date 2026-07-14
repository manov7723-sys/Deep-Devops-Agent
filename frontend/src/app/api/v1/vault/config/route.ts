import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { getVaultConfigView, saveVaultConfig, deleteVaultConfig } from "@/lib/cloud/vault-config";
import { pingVault } from "@/lib/cloud/vault";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * Per-PROJECT Vault connection (URL + token). Scoped by `?slug=<project>`.
 *   GET    → non-secret view (configured?, addr, source) — never the token
 *   POST   → save URL + token (tested against Vault first); token stored encrypted
 *   DELETE → disconnect
 */
async function gate(req: Request) {
  const slug = new URL(req.url).searchParams.get("slug") ?? "";
  if (!slug)
    return { error: NextResponse.json({ ok: false, code: "missing_slug" }, { status: 400 }) };
  const g = await requireProjectAccess(slug, "developer");
  if (!g.ok) return { error: NextResponse.json({ ok: false }, { status: g.status }) };
  return { projectId: g.access.project.id, userId: g.access.session.userId };
}

export async function GET(req: Request) {
  const g = await gate(req);
  if (g.error) return g.error;
  const view = await getVaultConfigView(g.projectId);
  return NextResponse.json({ ok: true, ...view });
}

const SaveBody = z.object({
  addr: z
    .string()
    .trim()
    .url("Enter a valid Vault URL, e.g. https://vault.example.com:8200")
    .max(300),
  token: z.string().trim().min(3, "Enter your Vault token.").max(512),
  kvMount: z.string().trim().max(120).optional(),
  pathPrefix: z.string().trim().max(200).optional(),
});

export async function POST(req: Request) {
  const g = await gate(req);
  if (g.error) return g.error;

  const parsed = SaveBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const { addr, token, kvMount, pathPrefix } = parsed.data;

  // Test the connection BEFORE saving so the user gets immediate feedback.
  const ping = await pingVault({
    addr: addr.replace(/\/+$/, ""),
    token,
    mount: kvMount || "secret",
    prefix: pathPrefix || "dda/cloud",
  });
  if (!ping.reachable) {
    return NextResponse.json(
      {
        ok: false,
        code: "unreachable",
        message: ping.error ?? "Could not reach Vault with those details.",
      },
      { status: 400 },
    );
  }

  await saveVaultConfig(g.projectId, { addr, token, kvMount, pathPrefix });

  const meta = extractRequestMeta(req);
  await audit({
    userId: g.userId,
    action: "vault.configured",
    targetType: "vault_config",
    targetId: g.projectId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { addr },
  });

  return NextResponse.json({ ok: true, reachable: true });
}

export async function DELETE(req: Request) {
  const g = await gate(req);
  if (g.error) return g.error;
  await deleteVaultConfig(g.projectId);
  const meta = extractRequestMeta(req);
  await audit({
    userId: g.userId,
    action: "vault.disconnected",
    targetType: "vault_config",
    targetId: g.projectId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  });
  return NextResponse.json({ ok: true });
}
