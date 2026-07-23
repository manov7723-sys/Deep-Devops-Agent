import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { resolveAwsExecEnv } from "@/lib/cloud/aws-onboard";
import { runStage } from "@/lib/runner/exec";
import { pickBackendForEnv } from "@/lib/devops/envs";
import { backendOverride, san, stripBackendBlocks } from "@/lib/devops/terraform-run";

/**
 * GET /projects/[slug]/aws/jenkins/[approvalId]/outputs
 *
 * Rebuilds the workspace from the approval's stored Terraform files, points
 * it at the same S3 state the apply wrote to, and runs `terraform output
 * -json`. Returns the values the sidebar Jenkins page needs to render a
 * ready-to-copy SSH command (with the actual key pair name, not AWS Console's
 * misleading `id_rsa` boilerplate), plus URL + admin credentials.
 *
 * Same infrastructure as /aws/client-vpn/[approvalId]/download but returns
 * JSON instead of streaming a zip.
 */

const EXTRA_PATH = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"];

type Outputs = {
  jenkinsUrl?: string;
  jenkinsPublicIp?: string;
  jenkinsAdminUsername?: string;
  jenkinsAdminPassword?: string;
  keyName?: string | null;
  instanceId?: string;
  shellCommand?: string;
  region?: string;
};

export async function GET(
  req: Request,
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
  if (!payload.files?.length || !payload.stack || !payload.stack.startsWith("jenkins-")) {
    return NextResponse.json(
      { ok: false, code: "not_jenkins", message: "This approval isn't a Jenkins stack." },
      { status: 400 },
    );
  }

  const backend = approval.env ? pickBackendForEnv(approval.env) : null;
  if (!backend || backend.kind !== "s3") {
    return NextResponse.json(
      {
        ok: false,
        code: "no_backend",
        message: "This env has no S3 backend configured — can't read Terraform outputs.",
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

  // Query params — allow ?includeSecret=1 to include the admin password.
  // Default OFF: the sidebar shows a "Reveal" button that flips this on
  // (audit trail: each reveal is a distinct GET the user consented to).
  const url = new URL(req.url);
  const includeSecret = url.searchParams.get("includeSecret") === "1";

  const workspace = await mkdtemp(join(tmpdir(), "dda-jk-outputs-"));
  try {
    for (const f of payload.files) {
      const filePath = join(workspace, f.path.split("/").pop() ?? "unnamed.tf");
      await writeFile(filePath, stripBackendBlocks(f.content), "utf8");
    }
    const envKey = approval.env?.key ?? payload.envKey ?? "default";
    const stateKey = `${san(projectId)}/${san(envKey)}/${payload.stack}`;
    await writeFile(
      join(workspace, "backend_override.tf"),
      backendOverride(backend, stateKey),
      "utf8",
    );

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

    type Entry = { value: unknown; sensitive?: boolean };
    let parsed: Record<string, Entry>;
    try {
      parsed = JSON.parse(out.stdout) as Record<string, Entry>;
    } catch {
      return NextResponse.json(
        { ok: false, code: "output_parse", message: "terraform output returned non-JSON." },
        { status: 502 },
      );
    }
    const pick = (k: string): string | undefined => {
      const v = parsed[k]?.value;
      return typeof v === "string" ? v : undefined;
    };

    // Peek at the source .tf to see whether a key pair was actually attached
    // — the generator only emits `key_name = "…"` when the wizard picked one.
    // We report this so the UI can render the exact SSH command (with the
    // key pair name), not AWS Console's misleading `id_rsa` boilerplate.
    let keyName: string | null = null;
    const mainTf = payload.files.find((f) => f.path.endsWith("main.tf"))?.content ?? "";
    const keyMatch = mainTf.match(/^\s*key_name\s*=\s*"([^"]+)"/m);
    if (keyMatch) keyName = keyMatch[1] ?? null;

    // Compose a copy-paste-ready shell command that reflects reality:
    //   - key pair picked + port 22 opened → ssh with the real .pem name
    //   - key pair picked, port 22 closed  → hint that SG blocks it
    //   - no key                            → SSM (works regardless of SG)
    const publicIp = pick("jenkins_public_ip");
    const instanceId = pick("instance_id");
    const region = pick("region") ?? backend.region;
    const sgOpensSsh = /from_port\s*=\s*22/.test(mainTf);

    let shellCommand = "";
    if (keyName && publicIp && sgOpensSsh) {
      shellCommand = `ssh -i ~/.ssh/${keyName}.pem ec2-user@${publicIp}`;
    } else if (keyName && publicIp) {
      shellCommand = `# SSH key pair "${keyName}" is attached but port 22 is closed. Re-provision with a CIDR in "Allow SSH from CIDR" to enable SSH, or use SSM:\naws ssm start-session --target ${instanceId ?? "<instance-id>"} --region ${region}`;
    } else if (instanceId) {
      shellCommand = `aws ssm start-session --target ${instanceId} --region ${region}`;
    }

    const outputs: Outputs = {
      jenkinsUrl: pick("jenkins_url"),
      jenkinsPublicIp: publicIp,
      jenkinsAdminUsername: pick("jenkins_admin_username"),
      jenkinsAdminPassword: includeSecret ? pick("jenkins_admin_password") : undefined,
      keyName,
      instanceId,
      shellCommand,
      region,
    };

    return NextResponse.json({ ok: true, outputs, includedSecret: includeSecret });
  } finally {
    await rm(workspace, { recursive: true, force: true }).catch(() => {});
  }
}
