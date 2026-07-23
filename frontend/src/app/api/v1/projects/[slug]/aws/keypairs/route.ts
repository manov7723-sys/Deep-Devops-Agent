import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { resolveAwsExecEnv } from "@/lib/cloud/aws-onboard";
import { runStage } from "@/lib/runner/exec";

/**
 * GET /projects/[slug]/aws/keypairs?region=us-east-1
 *
 * Lists EC2 key pair names in the region. Powers the Jenkins wizard's SSH
 * key pair dropdown so users pick an EXISTING key pair (the one they already
 * downloaded the .pem for) instead of typing the name from memory.
 *
 * Read-only — shells `aws ec2 describe-key-pairs`. Same pattern as
 * /aws/vpcs and /aws/subnets.
 */
type KeyPair = { name: string; type: string; fingerprint: string | null };

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId: gate.access.project.id, kind: "aws" },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  });
  if (!cp) {
    return NextResponse.json({ ok: true, connected: false, keyPairs: [] as KeyPair[], note: "No AWS account connected." });
  }
  const resolved = await resolveAwsExecEnv(cp.id);
  if (!resolved.ok) {
    return NextResponse.json({ ok: true, connected: false, keyPairs: [] as KeyPair[], note: resolved.message });
  }

  const url = new URL(req.url);
  const region = (url.searchParams.get("region")?.trim() || resolved.region).trim();

  const res = await runStage({
    command: "aws",
    args: [
      "ec2",
      "describe-key-pairs",
      "--region",
      region,
      "--output",
      "json",
      "--no-cli-pager",
    ],
    cwd: process.cwd(),
    env: { ...resolved.env, AWS_REGION: region, AWS_DEFAULT_REGION: region },
    timeoutMs: 30_000,
  });

  if (res.exitCode !== 0) {
    return NextResponse.json({
      ok: true,
      connected: true,
      region,
      keyPairs: [],
      note: res.stderr.slice(-400) || "aws ec2 describe-key-pairs failed.",
    });
  }

  let parsed: { KeyPairs?: Array<{ KeyName?: string; KeyType?: string; KeyFingerprint?: string }> } = {};
  try {
    parsed = JSON.parse(res.stdout);
  } catch {
    return NextResponse.json({ ok: true, connected: true, region, keyPairs: [], note: "aws returned non-JSON." });
  }

  const keyPairs: KeyPair[] = (parsed.KeyPairs ?? []).map((k) => ({
    name: k.KeyName ?? "(unnamed)",
    type: k.KeyType ?? "rsa",
    fingerprint: k.KeyFingerprint ?? null,
  }));

  return NextResponse.json({ ok: true, connected: true, region, keyPairs });
}
