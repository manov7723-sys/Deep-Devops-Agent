import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextResponse } from "next/server";
import JSZip from "jszip";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { resolveAwsExecEnv } from "@/lib/cloud/aws-onboard";
import { runStage } from "@/lib/runner/exec";
import { pickBackendForEnv } from "@/lib/devops/envs";
import { backendOverride, san, stripBackendBlocks } from "@/lib/devops/terraform-run";

/**
 * GET /projects/[slug]/aws/client-vpn/[approvalId]/download
 *
 * Rebuilds the workspace on-disk from the approval's stored Terraform files,
 * runs `terraform init -input=false` + `terraform output -json` against the
 * SAME remote state the apply wrote to, extracts the sensitive certificate
 * PEMs (client cert + key + CA cert) plus the endpoint id, then packages
 * everything the user needs into a zip:
 *
 *   client-vpn-<name>-<UTC-timestamp>/
 *     client.ovpn      (from `aws ec2 export-client-vpn-client-configuration`,
 *                       with <cert> + <key> already spliced in)
 *     client.crt       (raw client cert)
 *     client.key       (raw client private key)
 *     ca.crt           (raw CA cert)
 *     README.txt       (short "how to connect" for humans)
 *
 * The temp workspace is cleaned up regardless of outcome — no PEMs on disk
 * after the response streams. Requires the aws CLI + terraform CLI on the
 * runner host (same requirement as the actual terraform runs).
 */

const EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; approvalId: string }> }) {
  const { slug, approvalId } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const projectId = gate.access.project.id;

  const approval = await prisma.approval.findFirst({
    where: { id: approvalId, projectId, kind: "terraform" },
    select: {
      id: true,
      title: true,
      payloadJson: true,
      env: {
        select: {
          id: true,
          key: true,
          // These are exactly what pickBackendForEnv needs — same shape as the
          // env-select `apply-repo-terraform.ts` uses when kicking off runs.
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
    return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
  }
  const payload = (approval.payloadJson ?? {}) as {
    envKey?: string;
    stack?: string;
    files?: Array<{ path: string; content: string }>;
  };
  if (!payload.files?.length || !payload.stack) {
    return NextResponse.json(
      { ok: false, code: "no_payload", message: "This approval has no Terraform payload — cannot recover certs." },
      { status: 409 },
    );
  }
  if (!payload.stack.startsWith("client-vpn-")) {
    return NextResponse.json(
      { ok: false, code: "not_client_vpn", message: "Only Client VPN approvals are downloadable via this endpoint." },
      { status: 400 },
    );
  }

  // Resolve the SAME S3 backend the apply used — without this, `terraform init`
  // sets up local (empty) state and `terraform output` returns nothing.
  const backend = approval.env ? pickBackendForEnv(approval.env) : null;
  if (!backend) {
    return NextResponse.json(
      {
        ok: false,
        code: "no_backend",
        message: "This env has no remote Terraform backend configured. Certs live in state — with no backend, we can't fetch them.",
      },
      { status: 409 },
    );
  }
  if (backend.kind !== "s3") {
    return NextResponse.json(
      { ok: false, code: "unsupported_backend", message: `Backend kind '${backend.kind}' isn't supported yet for cert download.` },
      { status: 409 },
    );
  }

  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId, kind: "aws" },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  });
  if (!cp) {
    return NextResponse.json({ ok: false, code: "no_aws_provider" }, { status: 409 });
  }
  const resolved = await resolveAwsExecEnv(cp.id);
  if (!resolved.ok) {
    return NextResponse.json({ ok: false, code: "aws_creds", message: resolved.message }, { status: 502 });
  }

  const workspace = await mkdtemp(join(tmpdir(), "dda-cvpn-dl-"));
  try {
    // 1. Write the stored Terraform files back onto disk exactly as the runner
    //    would have — same content minus inline backend blocks (the runner
    //    also strips those), so `terraform init` points at OUR override, not
    //    a leftover backend the generator emitted.
    for (const f of payload.files) {
      const filePath = join(workspace, f.path.split("/").pop() ?? "unnamed.tf");
      await writeFile(filePath, stripBackendBlocks(f.content), "utf8");
    }

    // 2. Emit the SAME backend override file the runner uses (`backend_override.tf`)
    //    with the SAME state key layout: `<san(projectId)>/<san(envKey)>/<stack>`.
    //    If this doesn't match byte-for-byte, terraform init sets up a fresh
    //    empty state and `terraform output` returns nothing.
    const envKey = approval.env?.key ?? payload.envKey ?? "default";
    const stateKey = `${san(projectId)}/${san(envKey)}/${payload.stack}`;
    await writeFile(join(workspace, "backend_override.tf"), backendOverride(backend, stateKey), "utf8");

    const execEnv = {
      ...process.env,
      ...resolved.env,
      PATH: [...EXTRA_PATH, process.env.PATH ?? ""].filter(Boolean).join(":"),
    };

    // 2. terraform init — points at the same S3 backend the apply used.
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

    // 3. terraform output -json — sensitive values come through in JSON mode
    //    (unlike the human-readable `terraform output`, which redacts them).
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

    type OutputEntry = { value: unknown; sensitive?: boolean; type?: unknown };
    let outputs: Record<string, OutputEntry>;
    try {
      outputs = JSON.parse(out.stdout) as Record<string, OutputEntry>;
    } catch {
      return NextResponse.json(
        { ok: false, code: "output_parse", message: "terraform output returned non-JSON." },
        { status: 502 },
      );
    }

    const pick = (key: string): string | null => {
      const v = outputs[key]?.value;
      return typeof v === "string" ? v : null;
    };
    const clientCert = pick("client_certificate_pem");
    const clientKey = pick("client_private_key_pem");
    const caCert = pick("ca_certificate_pem");
    const endpointId = pick("client_vpn_endpoint_id");
    const endpointDns = pick("client_vpn_dns_name");
    const region = pick("region");

    if (!clientCert || !clientKey || !caCert || !endpointId) {
      return NextResponse.json(
        {
          ok: false,
          code: "missing_outputs",
          message:
            "One of client_certificate_pem / client_private_key_pem / ca_certificate_pem / client_vpn_endpoint_id " +
            "is missing from state. Was this stack created with certMode='auto'? Manual-cert stacks store certs " +
            "outside the state and can't be downloaded this way.",
        },
        { status: 409 },
      );
    }

    // 4. Grab the AWS-issued .ovpn base config for the endpoint (contains the
    //    endpoint DNS + CA already, plus AWS's recommended openvpn params).
    let ovpnBase = "";
    if (region) {
      const cfgRes = await runStage({
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
      if (cfgRes.exitCode === 0) {
        ovpnBase = cfgRes.stdout;
      }
    }

    // Splice <cert> + <key> into the AWS config so the resulting .ovpn is
    // self-contained — one file, ready to import into any OpenVPN client.
    const ovpn = (ovpnBase || fallbackOvpn(endpointDns ?? "", caCert)).trimEnd() +
      "\n\n<cert>\n" + clientCert.trim() + "\n</cert>\n\n<key>\n" + clientKey.trim() + "\n</key>\n";

    // 5. Build the zip. Everything nested under one folder so unzip creates
    //    a tidy directory matching the archive name.
    const stamp = nowStamp();
    const folder = `client-vpn-${sanitiseName(payload.stack.slice("client-vpn-".length))}-${stamp}`;
    const zip = new JSZip();
    const root = zip.folder(folder)!;
    root.file("client.ovpn", ovpn);
    root.file("client.crt", clientCert.trim() + "\n");
    root.file("client.key", clientKey.trim() + "\n");
    root.file("ca.crt", caCert.trim() + "\n");
    root.file(
      "README.txt",
      [
        `Client VPN credentials — generated ${new Date().toISOString()}`,
        ``,
        `Endpoint: ${endpointDns ?? "(unknown — check AWS console)"}`,
        `Region:   ${region ?? "(unknown)"}`,
        ``,
        `HOW TO CONNECT`,
        `--------------`,
        `1. Install AWS VPN Client (recommended), Tunnelblick, or any OpenVPN client.`,
        `2. Import client.ovpn into it. That single file already contains the CA,`,
        `   the client cert, and the client key — no other setup needed.`,
        `3. Click Connect.`,
        ``,
        `The raw client.crt / client.key / ca.crt files are provided in case you`,
        `need to build the .ovpn yourself or feed them into another tool.`,
        ``,
        `SECURITY`,
        `--------`,
        `client.key is a private key. Anyone with this file can authenticate as`,
        `a VPN client. Store it somewhere safe (password manager, secure vault)`,
        `and delete this zip after you've imported the .ovpn.`,
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
  // "2026-07-20T15-04-05Z" — filesystem-safe timestamp for filenames.
  return new Date().toISOString().replace(/:/g, "-").replace(/\..*/, "Z");
}

function sanitiseName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

/**
 * Fallback minimal .ovpn if AWS's export call fails (e.g. runner lacks the
 * IAM perm). Only used as a last resort — the AWS-issued config is preferred
 * because it embeds AWS-specific hostname/DNS options.
 */
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
