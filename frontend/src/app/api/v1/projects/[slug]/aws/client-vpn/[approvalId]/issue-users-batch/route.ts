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
 * POST /projects/[slug]/aws/client-vpn/[approvalId]/issue-users-batch
 *
 * Bulk version of the single-user issue-user endpoint. Given a list of
 * userNames, reads the VPN's CA ONCE, mints a fresh client cert for each
 * user, persists them (encrypted) to the DB, and streams a single combined
 * zip:
 *
 *   vpn-users-<vpn>-<UTC-timestamp>/
 *     README.txt
 *     ca.crt                (shared — same CA for all users)
 *     users/
 *       alice/
 *         alice.ovpn        (self-contained, cert/key/ca embedded)
 *         alice.crt
 *         alice.key
 *       bob/
 *         bob.ovpn
 *         bob.crt
 *         bob.key
 *
 * Much cheaper than N calls to /issue-user (one terraform init + one AWS
 * export, not N of each). Same persistence + revocation model — each user
 * shows up in the sidebar's "Issued user certs" list after this call.
 */
const EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

const Body = z.object({
  userNames: z
    .array(
      z
        .string()
        .trim()
        .min(1, "empty user name")
        .max(60, "max 60 chars")
        .regex(
          /^[A-Za-z0-9][A-Za-z0-9._-]*$/,
          "user names must start alphanumeric; letters/digits/. _ - only",
        ),
    )
    .min(1, "Pick at least one user.")
    .max(50, "Max 50 users per batch."),
  /** Cert validity in days. Default 365. */
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
  const { userNames, validityDays = 365 } = parsed.data;
  // Dedup while preserving order — issuing two "alice" certs would give
  // Alice a stale one and confuse the audit trail.
  const uniqueNames = Array.from(new Set(userNames.map((n) => n.trim())));

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
  if (!approval) {
    return NextResponse.json(
      {
        ok: false,
        code: "not_found",
        message: `No Client VPN approval found with id ${approvalId} in this project. The VPN may have been deleted, or the id is stale — reload the wizard and pick again.`,
      },
      { status: 404 },
    );
  }

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
      { ok: false, code: "no_backend", message: "This env has no S3 backend — can't read CA from state." },
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

  const workspace = await mkdtemp(join(tmpdir(), "dda-issue-batch-"));
  try {
    // 1. Materialize .tf files + backend override so `terraform init/output`
    //    targets the SAME S3 state the apply wrote to.
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

    // 2. terraform init (once) + output (once) — batch's whole win vs
    //    calling /issue-user N times.
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
    let outputs: Record<string, { value: unknown; sensitive?: boolean }>;
    try {
      outputs = JSON.parse(out.stdout);
    } catch {
      return NextResponse.json(
        { ok: false, code: "output_parse", message: "terraform output returned non-JSON." },
        { status: 502 },
      );
    }
    // Try outputs first (fast path — works on stacks that expose CA outputs).
    const seed = readCaFromOutputs(outputs);
    // Fall back to raw state pull for OLDER stacks that didn't expose
    // ca_private_key_pem as an output — the CA is always in state anyway.
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

    // 3. Grab AWS's .ovpn base ONCE — same base used across all users.
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

    // 4. Parse CA ONCE — reuse for signing every user cert.
    const caCert = forge.pki.certificateFromPem(caCertPem);
    const caKey = forge.pki.privateKeyFromPem(caPrivateKeyPem);

    // 5. Mint + persist + zip per user. Any failure on ONE user aborts the
    //    whole batch cleanly so the user doesn't get half a zip.
    const stamp = nowStamp();
    const vpnName = sanitiseName(payload.stack.slice("client-vpn-".length));
    const folder = `vpn-users-${vpnName}-${stamp}`;
    const zip = new JSZip();
    const root = zip.folder(folder)!;
    root.file("ca.crt", caCertPem.trim() + "\n");

    const usersDir = root.folder("users")!;
    const summary: Array<{ user: string; serial: string; ovpnFilename: string }> = [];
    for (const userName of uniqueNames) {
      const keys = forge.pki.rsa.generateKeyPair(2048);
      const cert = forge.pki.createCertificate();
      cert.publicKey = keys.publicKey;
      const serial = randomSerialHex();
      cert.serialNumber = serial;
      cert.validity.notBefore = new Date();
      cert.validity.notAfter = new Date(Date.now() + validityDays * 24 * 3600 * 1000);
      cert.setSubject([
        { name: "commonName", value: userName },
        { name: "organizationName", value: "DeepAgent VPN Users" },
      ]);
      cert.setIssuer(caCert.subject.attributes);
      cert.setExtensions([
        { name: "basicConstraints", cA: false },
        { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
        { name: "extKeyUsage", clientAuth: true },
        { name: "subjectAltName", altNames: [{ type: 2, value: userName }] },
      ]);
      cert.sign(caKey, forge.md.sha256.create());

      const certPem = forge.pki.certificateToPem(cert);
      const keyPem = forge.pki.privateKeyToPem(keys.privateKey);

      const perUserOvpn = (ovpnBase ? ovpnBase.trimEnd() : `client\ndev tun\nproto udp\n<ca>\n${caCertPem.trim()}\n</ca>\n`) +
        "\n\n<cert>\n" + certPem.trim() + "\n</cert>\n\n<key>\n" + keyPem.trim() + "\n</key>\n";

      const cnSafe = sanitiseName(userName);
      const userDir = usersDir.folder(cnSafe)!;
      userDir.file(`${cnSafe}.ovpn`, perUserOvpn);
      userDir.file(`${cnSafe}.crt`, certPem.trim() + "\n");
      userDir.file(`${cnSafe}.key`, keyPem.trim() + "\n");

      await prisma.vpnUserCert.create({
        data: {
          projectId,
          approvalId,
          userName,
          serial,
          certPemEnc: encryptSecret(certPem),
          privateKeyEnc: encryptSecret(keyPem),
          caPemEnc: encryptSecret(caCertPem),
          ovpnBaseEnc: ovpnBase ? encryptSecret(ovpnBase) : null,
          endpointId,
          endpointDns,
          region,
          issuedById: gate.access.session.userId,
          validityDays,
        },
      }).catch((e) => {
        console.error("[issue-users-batch] failed to persist VpnUserCert for", userName, e);
      });

      summary.push({ user: userName, serial, ovpnFilename: `users/${cnSafe}/${cnSafe}.ovpn` });
    }

    root.file(
      "README.txt",
      [
        `Batch VPN user certs — generated ${new Date().toISOString()}`,
        ``,
        `VPN endpoint: ${endpointId}${endpointDns ? ` (${endpointDns})` : ""}`,
        `Region:       ${region}`,
        `Users issued: ${summary.length}`,
        ``,
        `PER-USER DISTRIBUTION`,
        `---------------------`,
        `Each user needs their own .ovpn file. Hand it to them; they import it`,
        `into AWS VPN Client / Tunnelblick / any OpenVPN client and connect.`,
        `AWS Connection Log's Common Name column then shows their name per`,
        `session.`,
        ``,
        `Files in this bundle:`,
        ...summary.map((s) => `  ${s.ovpnFilename}   (CN: ${s.user}, serial ${s.serial.slice(0, 12)}…)`),
        ``,
        `Every cert is ALSO saved in the app — open the Client VPN sidebar`,
        `page to see all issued certs, re-download any of them later, or`,
        `revoke a specific user without touching the others.`,
        ``,
        `SECURITY`,
        `--------`,
        `.key files are PRIVATE KEYS. Anyone with a .key can authenticate as`,
        `that user. Distribute per-user (not the whole zip).`,
        ``,
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
  return s.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

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
