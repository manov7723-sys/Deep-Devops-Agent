import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextResponse } from "next/server";
import JSZip from "jszip";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { getDecryptedAzureCreds } from "@/lib/cloud/azure";
import { runStage } from "@/lib/runner/exec";
import { pickBackendForEnv } from "@/lib/devops/envs";
import { backendOverride, san, stripBackendBlocks } from "@/lib/devops/terraform-run";
import { readCaFromOutputs, resolveCaFromState, resolveInitialClientCertFromState } from "@/lib/devops/client-vpn-state";
import { encryptSecret } from "@/lib/auth/crypto";

/**
 * POST /projects/[slug]/azure/vpn/[approvalId]/initial-cert
 *
 * Pull the auto-generated initial client cert + CA from Terraform state, wrap
 * them into a self-contained `.ovpn` file, encrypt + persist to VpnUserCert
 * (userName = "initial"), and stream a zip. Users never have to run
 * `terraform output -raw ...` locally — the whole cert bundle is served by
 * the app.
 *
 * Idempotent: if this endpoint has been called before for the same approval,
 * the persisted row is reused for the download so the CN + serial stay stable
 * across re-downloads (matches how the AWS per-user cert flow behaves).
 */

const EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

export async function POST(
  _req: Request,
  ctx: { params: Promise<{ slug: string; approvalId: string }> },
) {
  const { slug, approvalId } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const projectId = gate.access.project.id;

  const approval = await prisma.approval.findFirst({
    where: { id: approvalId, projectId, kind: "terraform" },
    select: {
      id: true,
      payloadJson: true,
      env: {
        select: {
          key: true,
          cloudProvider: { select: { kind: true } },
          tfBackendBucket: true,
          tfBackendRegion: true,
          tfBackendTable: true,
          tfBackendGcsBucket: true,
          tfBackendAzureResourceGroup: true,
          tfBackendAzureStorageAccount: true,
          tfBackendAzureContainer: true,
        },
      },
    },
  });
  if (!approval) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });

  const payload = (approval.payloadJson ?? {}) as {
    envKey?: string;
    stack?: string;
    files?: Array<{ path: string; content: string }>;
  };
  if (!payload.files?.length || !payload.stack?.startsWith("azure-vpn-")) {
    return NextResponse.json(
      { ok: false, code: "not_azure_vpn", message: "Not an Azure VPN approval." },
      { status: 400 },
    );
  }

  const backend = approval.env ? pickBackendForEnv(approval.env) : null;
  if (!backend || backend.kind !== "azurerm") {
    return NextResponse.json(
      { ok: false, code: "no_backend", message: "This env has no Azure blob backend — cannot read state." },
      { status: 409 },
    );
  }

  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId, kind: "azure" },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  });
  if (!cp) return NextResponse.json({ ok: false, code: "no_azure_provider" }, { status: 409 });

  const creds = await getDecryptedAzureCreds(cp.id);
  if (!creds.ok) {
    return NextResponse.json({ ok: false, code: "azure_creds", message: creds.error }, { status: 502 });
  }

  const workspace = await mkdtemp(join(tmpdir(), "dda-azvpn-initial-"));
  try {
    for (const f of payload.files) {
      const filePath = join(workspace, f.path.split("/").pop() ?? "unnamed.tf");
      await writeFile(filePath, stripBackendBlocks(f.content), "utf8");
    }
    const envKey = approval.env?.key ?? payload.envKey ?? "default";
    const stateKey = `${san(projectId)}/${san(envKey)}/${payload.stack}`;
    await writeFile(join(workspace, "backend_override.tf"), backendOverride(backend, stateKey), "utf8");

    const execEnv: Record<string, string | undefined> = {
      ...process.env,
      ARM_CLIENT_ID: creds.clientId,
      ARM_CLIENT_SECRET: creds.clientSecret,
      ARM_TENANT_ID: creds.tenantId,
      ARM_SUBSCRIPTION_ID: creds.subscriptionId,
      PATH: [...EXTRA_PATH, process.env.PATH ?? ""].filter(Boolean).join(":"),
    };
    const cleanEnv: Record<string, string> = {};
    for (const [k, v] of Object.entries(execEnv)) {
      if (typeof v === "string") cleanEnv[k] = v;
    }

    const init = await runStage({
      command: "terraform",
      args: ["init", "-input=false", "-no-color"],
      cwd: workspace,
      env: cleanEnv,
      timeoutMs: 120_000,
    });
    if (init.exitCode !== 0) {
      return NextResponse.json(
        { ok: false, code: "init_failed", message: `terraform init failed: ${init.stderr.slice(-400)}` },
        { status: 502 },
      );
    }

    // ── Read CA + endpoint DNS from state ────────────────────────────────
    const out = await runStage({
      command: "terraform",
      args: ["output", "-json", "-no-color"],
      cwd: workspace,
      env: cleanEnv,
      timeoutMs: 60_000,
    });
    if (out.exitCode !== 0) {
      return NextResponse.json(
        { ok: false, code: "output_failed", message: `terraform output failed: ${out.stderr.slice(-400)}` },
        { status: 502 },
      );
    }
    let parsedOut: Record<string, { value: unknown; sensitive?: boolean }> = {};
    try {
      parsedOut = JSON.parse(out.stdout) as typeof parsedOut;
    } catch {
      /* fall through — resolveCaFromState will use state-pull */
    }
    const seed = readCaFromOutputs(parsedOut);
    const resolved = await resolveCaFromState({ workspace, execEnv, seed });
    if (!resolved.ok) {
      return NextResponse.json(
        { ok: false, code: "missing_ca", message: resolved.message },
        { status: 409 },
      );
    }
    const { caCertPem, endpointDns } = resolved.material;
    if (!endpointDns) {
      return NextResponse.json(
        { ok: false, code: "missing_endpoint_dns", message: "Endpoint public IP not in state — apply not complete?" },
        { status: 409 },
      );
    }

    // ── Read initial client cert + key from state ────────────────────────
    const clientMat = await resolveInitialClientCertFromState({ workspace, execEnv });
    if (!clientMat.ok) {
      return NextResponse.json(
        { ok: false, code: "missing_client_cert", message: clientMat.message },
        { status: 409 },
      );
    }
    const { clientCertPem, clientKeyPem } = clientMat.material;

    // ── Read the VPN's transport + port from outputs so the .ovpn matches ──
    const vpnPort = (parsedOut.vpn_port?.value as number | undefined) ?? 1194;
    const vpnTransport = ((parsedOut.vpn_transport?.value as string | undefined) ?? "udp").toLowerCase();

    // ── Assemble BOTH .ovpn variants — split-tunnel + full-tunnel ────────
    // Same certs, only the client-side `redirect-gateway` directives differ.
    // Server accepts both regardless of its own split/full setting because
    // the VM's iptables NAT MASQUERADES the client CIDR out any interface —
    // internet traffic routes fine either way.
    const vpnName = payload.stack.slice("azure-vpn-".length);
    const cnSafe = sanitiseName(vpnName + "-initial");
    const ovpnSplit = buildOvpn({
      remote: endpointDns,
      port: vpnPort,
      proto: vpnTransport,
      caPem: caCertPem,
      clientCertPem,
      clientKeyPem,
      fullTunnel: false,
    });
    const ovpnFull = buildOvpn({
      remote: endpointDns,
      port: vpnPort,
      proto: vpnTransport,
      caPem: caCertPem,
      clientCertPem,
      clientKeyPem,
      fullTunnel: true,
    });
    // Persist the split-tunnel variant as the canonical stored ovpn (users
    // who re-download from the sidebar get the same choice via the zip).
    const ovpn = ovpnSplit;

    // ── Persist (upsert-like: reuse existing "initial" row if present) ──
    const existing = await prisma.vpnUserCert.findFirst({
      where: { projectId, approvalId, userName: cnSafe, revokedAt: null },
      select: { id: true },
    });
    if (!existing) {
      await prisma.vpnUserCert
        .create({
          data: {
            projectId,
            approvalId,
            userName: cnSafe,
            serial: "initial",
            certPemEnc: encryptSecret(clientCertPem),
            privateKeyEnc: encryptSecret(clientKeyPem),
            caPemEnc: encryptSecret(caCertPem),
            ovpnBaseEnc: encryptSecret(ovpn),
            endpointId: resolved.material.endpointId,
            endpointDns,
            region: resolved.material.region,
            issuedById: gate.access.session.userId,
            validityDays: 365,
          },
        })
        .catch((e) => {
          console.error("[azure-vpn/initial-cert] failed to persist VpnUserCert:", e);
        });
    }

    // ── Package the zip ──────────────────────────────────────────────────
    const stamp = nowStamp();
    const folder = `${vpnName}-vpn-${stamp}`;
    const zip = new JSZip();
    const root = zip.folder(folder)!;
    root.file(`${vpnName}-split.ovpn`, ovpnSplit);
    root.file(`${vpnName}-full.ovpn`, ovpnFull);
    root.file(`${vpnName}-client.crt`, clientCertPem.trim() + "\n");
    root.file(`${vpnName}-client.key`, clientKeyPem.trim() + "\n");
    root.file("ca.crt", caCertPem.trim() + "\n");
    root.file(
      "README.txt",
      [
        `Azure OpenVPN — initial client bundle`,
        `VPN name:  ${vpnName}`,
        `Endpoint:  ${endpointDns}:${vpnPort}/${vpnTransport}`,
        `Cert issued: ${new Date().toISOString()}`,
        ``,
        `WHICH .ovpn FILE TO USE`,
        `-----------------------`,
        `${vpnName}-split.ovpn  → SPLIT-TUNNEL (recommended default)`,
        `                        Only traffic destined for the Azure VNet routes`,
        `                        through the VPN. Your internet stays on your ISP.`,
        `                        Fast, cheap, no bandwidth cost on Azure side.`,
        ``,
        `${vpnName}-full.ovpn   → FULL-TUNNEL`,
        `                        ALL your internet traffic routes through Azure`,
        `                        (looks like you're in ${resolved.material.region ?? "Azure"}).`,
        `                        Use for: geo-testing, privacy, hostile networks.`,
        `                        Cost: ~$0.087/GB Azure egress. Slower — expect`,
        `                        +100-300ms latency to non-Azure destinations.`,
        ``,
        `HOW TO CONNECT`,
        `--------------`,
        `1. Install OpenVPN client — Tunnelblick (Mac), OpenVPN Connect (Win/Mac/iOS/Android), or the CLI.`,
        `2. Import ONE of the .ovpn files — the cert / key / CA are already embedded.`,
        `3. Connect.`,
        ``,
        `Once connected in either mode, you can reach VMs on the VNet's private IPs.`,
        ``,
        `TO SWITCH BETWEEN SPLIT AND FULL`,
        `--------------------------------`,
        `Disconnect → remove the current profile → import the other .ovpn → connect.`,
        `Both files share the same cert so you can flip anytime.`,
        ``,
        `TO ADD MORE USERS (per-user certs, so each user's name shows in the log)`,
        `------------------------------------------------------------------------`,
        `In chat, run \`create vpn certificates\` → pick this VPN → add names → Issue.`,
        `Each user gets their own bundle. Revoke individual certs from the sidebar.`,
        ``,
        `SECURITY`,
        `--------`,
        `${vpnName}-client.key is a private key. Anyone with it can authenticate as`,
        `the "initial" user. For team access, issue per-user certs instead of sharing this.`,
      ].join("\n"),
    );

    const buf = await zip.generateAsync({ type: "nodebuffer" });
    return new Response(new Uint8Array(buf), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${folder}.zip"`,
        "Cache-Control": "no-store",
      },
    });
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}

// ── helpers ─────────────────────────────────────────────────────────────

function nowStamp(): string {
  return new Date().toISOString().replace(/:/g, "-").replace(/\..*/, "Z");
}

function sanitiseName(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

function buildOvpn(args: {
  remote: string;
  port: number;
  proto: string;
  caPem: string;
  clientCertPem: string;
  clientKeyPem: string;
  /** true = client-side full-tunnel via redirect-gateway, false = server-pushed default (split). */
  fullTunnel: boolean;
}): string {
  const { remote, port, proto, caPem, clientCertPem, clientKeyPem, fullTunnel } = args;
  // Client-side override: `redirect-gateway def1 bypass-dhcp` reroutes ALL
  // client traffic through the tunnel regardless of what the server pushes.
  // Combined with `dhcp-option DNS` so name resolution still works (local
  // ISP DNS becomes unreachable once its route no longer matches).
  const fullTunnelLines = fullTunnel
    ? `redirect-gateway def1 bypass-dhcp
dhcp-option DNS 8.8.8.8
dhcp-option DNS 1.1.1.1
`
    : "";
  return `client
dev tun
proto ${proto}
remote ${remote} ${port}
resolv-retry infinite
nobind
persist-key
persist-tun
${fullTunnelLines}remote-cert-tls server
cipher AES-256-GCM
data-ciphers AES-256-GCM:AES-128-GCM
auth SHA256
verb 3

<ca>
${caPem.trim()}
</ca>

<cert>
${clientCertPem.trim()}
</cert>

<key>
${clientKeyPem.trim()}
</key>
`;
}
