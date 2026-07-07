import { NextResponse } from "next/server";
import { CreateCloudProviderRequest } from "@/lib/api/schemas/connectivity-api";
import { getActiveSession } from "@/lib/auth/session";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { createProvider, listProvidersForUser } from "@/lib/cloud/providers";
import { connectAzureServicePrincipal, encryptAzureSecret } from "@/lib/cloud/azure";
import { connectProxmox, encryptProxmoxSecret, normalizeProxmoxEndpoint } from "@/lib/cloud/proxmox";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function GET() {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });
  const providers = await listProvidersForUser(sess.userId);
  return NextResponse.json({ providers });
}

export async function POST(req: Request) {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });

  const raw = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const parsed = CreateCloudProviderRequest.safeParse(raw);
  if (!parsed.success) {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid_request",
        message: parsed.error.errors[0]?.message ?? "Invalid provider details.",
      },
      { status: 400 },
    );
  }
  const data = { ...parsed.data };

  // ISOLATION: a provider belongs to the project it's connected in. The modal
  // sends `projectSlug`; resolve it (and verify access) to set projectId.
  let projectId: string | undefined;
  const projectSlug = typeof raw.projectSlug === "string" ? raw.projectSlug : "";
  if (projectSlug) {
    const g = await requireProjectAccess(projectSlug, "developer");
    if (!g.ok) return NextResponse.json({ ok: false, code: "project_access" }, { status: g.status });
    projectId = g.access.project.id;
  }

  // Azure Service Principal: authenticate against Azure AD + validate ARM access
  // BEFORE storing (mirrors the Python azure_connector.connect()). The client
  // secret is then encrypted at rest. Field mapping: accountId=Tenant,
  // roleArn=Client ID, externalId=Client secret, accountRef=Subscription ID.
  if (data.kind === "azure") {
    const tenantId = data.accountId ?? "";
    const clientId = data.roleArn ?? "";
    const clientSecret = data.externalId ?? "";
    if (!tenantId || !clientId || !clientSecret) {
      return NextResponse.json(
        { ok: false, code: "invalid_request", message: "Azure needs Tenant ID, Client ID and Client secret." },
        { status: 400 },
      );
    }
    const conn = await connectAzureServicePrincipal({
      tenantId,
      clientId,
      clientSecret,
      subscriptionId: data.accountRef,
    });
    if (!conn.ok) {
      return NextResponse.json({ ok: false, code: "azure_connect_failed", message: conn.error }, { status: 400 });
    }
    // Persist the validated subscription + encrypt the secret.
    data.accountRef = conn.subscriptionId;
    data.externalId = encryptAzureSecret(clientSecret);
  }

  // Proxmox API token: validate against /api2/json/version BEFORE storing, then
  // encrypt the token secret. Field mapping: accountRef=endpoint URL,
  // roleArn=token id (user@realm!name), externalId=token secret, region=node.
  if (data.kind === "proxmox") {
    const endpoint = data.accountRef ?? "";
    const tokenId = data.roleArn ?? "";
    const tokenSecret = data.externalId ?? "";
    if (!endpoint || !tokenId || !tokenSecret) {
      return NextResponse.json(
        { ok: false, code: "invalid_request", message: "Proxmox needs the host URL, API token ID and token secret." },
        { status: 400 },
      );
    }
    const conn = await connectProxmox({ endpoint, tokenId, tokenSecret });
    if (!conn.ok) {
      return NextResponse.json({ ok: false, code: "proxmox_connect_failed", message: conn.error }, { status: 400 });
    }
    data.accountRef = normalizeProxmoxEndpoint(endpoint);
    data.externalId = encryptProxmoxSecret(tokenSecret);
  }

  const provider = await createProvider({ userId: sess.userId, projectId, ...data });
  const meta = extractRequestMeta(req);
  await audit({
    userId: sess.userId,
    action: "cloud_provider.created",
    targetType: "cloud_provider",
    targetId: provider.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { kind: provider.kind, name: provider.name, region: provider.region },
  });
  return NextResponse.json({ ok: true, provider });
}
