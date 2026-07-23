import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import forge from "node-forge";
import JSZip from "jszip";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { resolveAwsExecEnv } from "@/lib/cloud/aws-onboard";
import { runStage } from "@/lib/runner/exec";
import { pickBackendForEnv } from "@/lib/devops/envs";
import { backendOverride, san, stripBackendBlocks } from "@/lib/devops/terraform-run";
import { readCaFromOutputs, resolveCaFromState } from "@/lib/devops/client-vpn-state";
import { encryptSecret } from "@/lib/auth/crypto";

/**
 * POST /projects/[slug]/aws/client-vpn/[approvalId]/issue-user
 *
 * Mint a NEW per-user client certificate against an EXISTING Client VPN
 * endpoint's CA. Does not run Terraform — reads the CA private key + cert
 * from the VPN's Terraform state (via `terraform output`), signs a fresh
 * client cert imperatively with node-forge, and streams a zip containing:
 *
 *   <userName>-<vpn>-<timestamp>/
 *     README.txt
 *     <userName>.ovpn         (assembled — cert/key/ca already embedded)
 *     <userName>.crt          (raw cert)
 *     <userName>.key          (raw private key)
 *     ca.crt                  (shared CA — informational)
 *
 * The user imports the .ovpn into AWS VPN Client / Tunnelblick and connects.
 * AWS Connection Log's Common Name column then shows their name for that
 * session (since the CN on their cert matches userName).
 *
 * Note: the client cert is NOT uploaded to ACM. AWS Client VPN only stores
 * the server cert + client-CA cert in ACM; individual client certs are
 * validated at connect time against the CA chain. So we don't need to
 * touch ACM for per-user issuance.
 */

const EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

const Body = z.object({
  userName: z
    .string()
    .trim()
    .min(1, "userName is required — this becomes the cert's CN + shows in Connection Log.")
    .max(60)
    .regex(
      /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
      "userName must start with alphanumeric; only letters, digits, . _ - allowed.",
    ),
  /** Validity period in days. Default 365. Max 730 (2 years). */
  validityDays: z.number().int().min(30).max(730).optional(),
});

export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string; approvalId: string }> },
) {
  const { slug, approvalId } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const projectId = gate.access.project.id;

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const { userName, validityDays = 365 } = parsed.data;

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
  if (!payload.files?.length || !payload.stack?.startsWith("client-vpn-")) {
    return NextResponse.json(
      { ok: false, code: "not_client_vpn", message: "Not a Client VPN approval." },
      { status: 400 },
    );
  }

  const backend = approval.env ? pickBackendForEnv(approval.env) : null;
  if (!backend || backend.kind !== "s3") {
    return NextResponse.json(
      { ok: false, code: "no_backend", message: "This env has no S3 backend — cannot read the CA from state." },
      { status: 409 },
    );
  }

  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId, kind: "aws" },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  });
  if (!cp) return NextResponse.json({ ok: false, code: "no_aws_provider" }, { status: 409 });
  const resolved = await resolveAwsExecEnv(cp.id);
  if (!resolved.ok) {
    return NextResponse.json({ ok: false, code: "aws_creds", message: resolved.message }, { status: 502 });
  }

  const workspace = await mkdtemp(join(tmpdir(), "dda-issue-user-"));
  try {
    // Rebuild the workspace + backend override so `terraform init/output` targets
    // the same S3 state the apply wrote to.
    for (const f of payload.files) {
      const filePath = join(workspace, f.path.split("/").pop() ?? "unnamed.tf");
      await writeFile(filePath, stripBackendBlocks(f.content), "utf8");
    }
    const envKey = approval.env?.key ?? payload.envKey ?? "default";
    const stateKey = `${san(projectId)}/${san(envKey)}/${payload.stack}`;
    await writeFile(join(workspace, "backend_override.tf"), backendOverride(backend, stateKey), "utf8");

    const execEnv = {
      ...process.env,
      ...resolved.env,
      PATH: [...EXTRA_PATH, process.env.PATH ?? ""].filter(Boolean).join(":"),
    };

    const init = await runStage({
      command: "terraform",
      args: ["init", "-input=false", "-no-color"],
      cwd: workspace,
      env: execEnv,
      timeoutMs: 120_000,
    });
    if (init.exitCode !== 0) {
      return NextResponse.json(
        { ok: false, code: "init_failed", message: `terraform init failed: ${init.stderr.slice(-400)}` },
        { status: 502 },
      );
    }

    const out = await runStage({
      command: "terraform",
      args: ["output", "-json", "-no-color"],
      cwd: workspace,
      env: execEnv,
      timeoutMs: 60_000,
    });
    if (out.exitCode !== 0) {
      return NextResponse.json(
        { ok: false, code: "output_failed", message: `terraform output failed: ${out.stderr.slice(-400)}` },
        { status: 502 },
      );
    }
    let parsedOut: Record<string, { value: unknown; sensitive?: boolean }>;
    try {
      parsedOut = JSON.parse(out.stdout) as typeof parsedOut;
    } catch {
      return NextResponse.json(
        { ok: false, code: "output_parse", message: "terraform output returned non-JSON." },
        { status: 502 },
      );
    }
    // Outputs → state fallback. Older stacks didn't expose ca_private_key_pem
    // as an output, but the CA is always present in the raw state file — we
    // pull it directly instead of forcing a re-apply.
    const seed = readCaFromOutputs(parsedOut);
    const resolved2 = await resolveCaFromState({ workspace, execEnv, seed });
    if (!resolved2.ok) {
      return NextResponse.json(
        { ok: false, code: "missing_ca", message: resolved2.message },
        { status: 409 },
      );
    }
    const { caCertPem, caPrivateKeyPem, endpointId, endpointDns } = resolved2.material;
    const region = resolved2.material.region ?? backend.region;

    if (!endpointId) {
      return NextResponse.json(
        { ok: false, code: "missing_endpoint_id", message: "client_vpn_endpoint_id missing from state." },
        { status: 409 },
      );
    }

    // ── Mint the new client cert with node-forge ─────────────────────────
    // 1. Parse CA cert + private key from PEM.
    // 2. Generate a fresh RSA-2048 key pair for the user.
    // 3. Build an X.509 cert, sign it with the CA's private key.
    // 4. Serialize both to PEM.
    let userCertPem = "";
    let userKeyPem = "";
    let certSerial = "";
    let signedCn = userName;
    try {
      const caCert = forge.pki.certificateFromPem(caCertPem);
      const caKey = forge.pki.privateKeyFromPem(caPrivateKeyPem);

      const keys = forge.pki.rsa.generateKeyPair(2048);
      const cert = forge.pki.createCertificate();
      cert.publicKey = keys.publicKey;
      certSerial = randomSerialHex();
      cert.serialNumber = certSerial;
      cert.validity.notBefore = new Date();
      cert.validity.notAfter = new Date(Date.now() + validityDays * 24 * 3600 * 1000);

      const subject = [
        { name: "commonName", value: signedCn },
        { name: "organizationName", value: "DeepAgent VPN Users" },
      ];
      cert.setSubject(subject);
      cert.setIssuer(caCert.subject.attributes);
      cert.setExtensions([
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
        { name: "extKeyUsage", clientAuth: true },
        { name: "subjectAltName", altNames: [{ type: 2, value: signedCn }] }, // 2 = DNS
      ]);

      cert.sign(caKey, forge.md.sha256.create());

      userCertPem = forge.pki.certificateToPem(cert);
      userKeyPem = forge.pki.privateKeyToPem(keys.privateKey);
    } catch (err) {
      return NextResponse.json(
        { ok: false, code: "signing_failed", message: `Failed to sign new client cert: ${err instanceof Error ? err.message : String(err)}` },
        { status: 500 },
      );
    }

    // ── Grab AWS's .ovpn base config so we return a self-contained file ──
    let ovpnBase = "";
    const cfg = await runStage({
      command: "aws",
      args: [
        "ec2",
        "export-client-vpn-client-configuration",
        "--client-vpn-endpoint-id",
        endpointId,
        "--region",
        region,
        "--output",
        "text",
        "--no-cli-pager",
      ],
      cwd: workspace,
      env: execEnv,
      timeoutMs: 30_000,
    });
    if (cfg.exitCode === 0) {
      ovpnBase = cfg.stdout;
    }
    if (!ovpnBase && endpointDns) {
      ovpnBase = fallbackOvpn(endpointDns, caCertPem);
    }
    const ovpn = ovpnBase.trimEnd() +
      "\n\n<cert>\n" + userCertPem.trim() + "\n</cert>\n\n<key>\n" + userKeyPem.trim() + "\n</key>\n";

    // ── Package the zip ──────────────────────────────────────────────────
    const stamp = nowStamp();
    const cnSafe = sanitiseName(signedCn);
    const vpnName = sanitiseName(payload.stack.slice("client-vpn-".length));
    const folder = `${cnSafe}-${vpnName}-${stamp}`;
    const zip = new JSZip();
    const root = zip.folder(folder)!;
    root.file(`${cnSafe}.ovpn`, ovpn);
    root.file(`${cnSafe}.crt`, userCertPem.trim() + "\n");
    root.file(`${cnSafe}.key`, userKeyPem.trim() + "\n");
    root.file("ca.crt", caCertPem.trim() + "\n");
    root.file(
      "README.txt",
      [
        `User: ${signedCn}`,
        `VPN:  ${vpnName} (endpoint ${endpointId}, region ${region})`,
        `Cert issued: ${new Date().toISOString()}`,
        `Cert valid:  ${validityDays} days`,
        ``,
        `HOW TO CONNECT`,
        `--------------`,
        `1. Install AWS VPN Client, Tunnelblick, or any OpenVPN client.`,
        `2. Import ${cnSafe}.ovpn — the cert/key/ca are already embedded, no other setup needed.`,
        `3. Connect.`,
        ``,
        `AWS Client VPN's Connection Log will show "${signedCn}" as the Common Name`,
        `for every session made with this cert. That's how you tell users apart.`,
        ``,
        `SECURITY`,
        `--------`,
        `${cnSafe}.key is a private key. Anyone with this file can authenticate as`,
        `${signedCn}. Do NOT share this zip broadly — hand it to ${signedCn} only.`,
        `To revoke: use AWS EC2 → Client VPN → this endpoint → Client certificate`,
        `revocation list → add ${cnSafe}'s serial.`,
        ``,
      ].join("\n"),
    );

    // Persist the cert BEFORE streaming so the record exists even if the
    // response is interrupted mid-download. PEMs + .ovpn base are AES-256-
    // GCM encrypted; only ever returned to the caller through the
    // download endpoints of this project.
    await prisma.vpnUserCert.create({
      data: {
        projectId,
        approvalId,
        userName: signedCn,
        serial: certSerial,
        certPemEnc: encryptSecret(userCertPem),
        privateKeyEnc: encryptSecret(userKeyPem),
        caPemEnc: encryptSecret(caCertPem),
        ovpnBaseEnc: ovpnBase ? encryptSecret(ovpnBase) : null,
        // Endpoint metadata so re-download can rebuild the .ovpn LIVE if
        // the stored ovpnBase turns out to be missing or stale.
        endpointId,
        endpointDns,
        region,
        issuedById: gate.access.session.userId,
        validityDays,
      },
    }).catch((e) => {
      // Non-fatal — the user still gets their zip. But we log so operators
      // notice if persistence is silently broken.
      console.error("[issue-user] failed to persist VpnUserCert:", e);
    });

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
  return s.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

// forge's cert serialNumber wants a positive-value hex string. 16 random bytes
// prefixed with a leading zero (to guarantee positive integer per X.509).
function randomSerialHex(): string {
  const bytes = new Uint8Array(16);
  if (typeof crypto !== "undefined" && crypto.getRandomValues) {
    crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return "00" + hex;
}

function fallbackOvpn(dns: string, caPem: string): string {
  return `client
dev tun
proto udp
remote ${dns} 443
remote-random-hostname
resolv-retry infinite
nobind
remote-cert-tls server
cipher AES-256-GCM
verb 3

<ca>
${caPem.trim()}
</ca>

reneg-sec 0
`;
}
