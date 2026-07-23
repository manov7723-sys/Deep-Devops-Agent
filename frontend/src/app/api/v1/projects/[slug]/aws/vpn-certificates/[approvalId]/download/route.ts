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
 * GET /projects/[slug]/aws/vpn-certificates/[approvalId]/download
 *
 * Rebuilds the workspace from the approval's stored Terraform files, runs
 * `terraform init` + `terraform output -json` against the SAME remote state
 * the apply wrote to, then packages a distributable zip:
 *
 *   vpn-certs-<name>-<UTC-timestamp>/
 *     README.txt
 *     server-arn.txt          (ACM ARN for Server certificate)
 *     client-ca-arn.txt       (ACM ARN for Client root CA)
 *     ca.crt                  (shared CA cert — every client needs this)
 *     clients/
 *       client-0-<cn>.crt     (per-user cert)
 *       client-0-<cn>.key     (per-user private key)
 *       client-1-<cn>.crt
 *       client-1-<cn>.key
 *       ...
 *
 * Same infrastructure as /aws/client-vpn/[approvalId]/download.
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
  if (!payload.files?.length || !payload.stack) {
    return NextResponse.json(
      { ok: false, code: "no_payload", message: "This approval has no Terraform payload — cannot recover certs." },
      { status: 409 },
    );
  }
  if (!payload.stack.startsWith("vpn-certs-")) {
    return NextResponse.json(
      { ok: false, code: "not_vpn_certificates", message: "Only VPN certificate approvals are downloadable via this endpoint." },
      { status: 400 },
    );
  }

  const backend = approval.env ? pickBackendForEnv(approval.env) : null;
  if (!backend || backend.kind !== "s3") {
    return NextResponse.json(
      {
        ok: false,
        code: "no_backend",
        message: "This env has no S3 backend configured — cert PEMs live in Terraform state, so we can't fetch them.",
      },
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

  const workspace = await mkdtemp(join(tmpdir(), "dda-vpncerts-dl-"));
  try {
    // 1. Materialize the stored .tf files (backend blocks stripped — runner
    //    does the same, and we inject our own override next).
    for (const f of payload.files) {
      const filePath = join(workspace, f.path.split("/").pop() ?? "unnamed.tf");
      await writeFile(filePath, stripBackendBlocks(f.content), "utf8");
    }

    // 2. Emit the SAME backend override the runner used (same state key
    //    layout: <san(projectId)>/<san(envKey)>/<stack>).
    const envKey = approval.env?.key ?? payload.envKey ?? "default";
    const stateKey = `${san(projectId)}/${san(envKey)}/${payload.stack}`;
    await writeFile(join(workspace, "backend_override.tf"), backendOverride(backend, stateKey), "utf8");

    const execEnv = {
      ...process.env,
      ...resolved.env,
      PATH: [...EXTRA_PATH, process.env.PATH ?? ""].filter(Boolean).join(":"),
    };

    // 3. terraform init → S3 backend
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

    // 4. terraform output -json (sensitive values come through in JSON mode)
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

    type OutputEntry = { value: unknown; sensitive?: boolean };
    let outputs: Record<string, OutputEntry>;
    try {
      outputs = JSON.parse(out.stdout) as Record<string, OutputEntry>;
    } catch {
      return NextResponse.json(
        { ok: false, code: "output_parse", message: "terraform output returned non-JSON." },
        { status: 502 },
      );
    }

    const pick = (k: string): string | null => {
      const v = outputs[k]?.value;
      return typeof v === "string" ? v : null;
    };
    const pickNum = (k: string): number | null => {
      const v = outputs[k]?.value;
      return typeof v === "number" ? v : null;
    };

    const serverArn = pick("server_certificate_arn");
    const clientCaArn = pick("client_ca_certificate_arn");
    const caPem = pick("ca_certificate_pem");
    const region = pick("region");
    const count = pickNum("client_certificate_count") ?? 0;

    if (!serverArn || !clientCaArn || !caPem) {
      return NextResponse.json(
        {
          ok: false,
          code: "missing_outputs",
          message:
            "One of server_certificate_arn / client_ca_certificate_arn / ca_certificate_pem is missing from state. " +
            "Was this stack applied successfully? Re-run the apply and try again.",
        },
        { status: 409 },
      );
    }

    // 5. Build the zip. Per-client folder with distinct CN in the filename
    //    so team members can grab their pair without confusion.
    const stamp = nowStamp();
    const setName = sanitiseName(payload.stack.slice("vpn-certs-".length));
    const folder = `vpn-certs-${setName}-${stamp}`;
    const zip = new JSZip();
    const root = zip.folder(folder)!;

    root.file("ca.crt", caPem.trim() + "\n");
    root.file("server-arn.txt", `${serverArn}\n`);
    root.file("client-ca-arn.txt", `${clientCaArn}\n`);

    const clientsDir = root.folder("clients")!;
    const clientEntries: string[] = [];
    for (let i = 0; i < count; i++) {
      const cn = pick(`client_${i}_common_name`) ?? `client-${i + 1}`;
      const cert = pick(`client_${i}_certificate_pem`);
      const key = pick(`client_${i}_private_key_pem`);
      if (!cert || !key) continue;
      const cnSafe = sanitiseName(cn);
      const crtFile = `client-${i}-${cnSafe}.crt`;
      const keyFile = `client-${i}-${cnSafe}.key`;
      clientsDir.file(crtFile, cert.trim() + "\n");
      clientsDir.file(keyFile, key.trim() + "\n");
      clientEntries.push(`  clients/${crtFile}   + clients/${keyFile}   (CN: ${cn})`);
    }

    root.file(
      "README.txt",
      [
        `VPN certificate set — generated ${new Date().toISOString()}`,
        ``,
        `Set name: ${setName}`,
        `Region:   ${region ?? "(unknown)"}`,
        `Clients:  ${count}`,
        ``,
        `ARNS FOR CLIENT VPN ENDPOINT`,
        `----------------------------`,
        `When creating a Client VPN endpoint in "manual" cert mode, paste these:`,
        ``,
        `  Server certificate ARN`,
        `    ${serverArn}`,
        ``,
        `  Client root CA ARN`,
        `    ${clientCaArn}`,
        ``,
        `PER-USER DISTRIBUTION`,
        `---------------------`,
        `Each team member needs THREE files to connect:`,
        `  1. ca.crt                     (shared — same for everyone)`,
        `  2. clients/client-N-<name>.crt (their personal cert)`,
        `  3. clients/client-N-<name>.key (their personal private key)`,
        ``,
        `Client cert / key pairs in this set:`,
        ...clientEntries,
        ``,
        `HOW TO USE`,
        `----------`,
        `Option A — assemble into a .ovpn file:`,
        `  1. Download the .ovpn from the Client VPN endpoint (Download button on the Client VPN sidebar page)`,
        `  2. Append at the end of the file:`,
        `       <ca>`,
        `       <paste contents of ca.crt>`,
        `       </ca>`,
        `       <cert>`,
        `       <paste contents of your client-N-<name>.crt>`,
        `       </cert>`,
        `       <key>`,
        `       <paste contents of your client-N-<name>.key>`,
        `       </key>`,
        `  3. Import the .ovpn into AWS VPN Client / Tunnelblick / any OpenVPN client`,
        ``,
        `SECURITY`,
        `--------`,
        `.key files are PRIVATE KEYS. Anyone with a .key can authenticate as that user.`,
        `Store them in a password manager / secure vault. Delete this zip after`,
        `distributing the individual per-user files.`,
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
