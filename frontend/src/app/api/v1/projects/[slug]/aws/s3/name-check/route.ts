import { NextResponse } from "next/server";
import { tmpdir } from "node:os";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { validateBucketName } from "@/lib/devops/s3";
import { resolveAwsExecEnv } from "@/lib/cloud/aws-onboard";
import { runStage } from "@/lib/runner/exec";

/**
 * GET /projects/[slug]/aws/s3/name-check?name=<bucket>
 *
 * Answers "is this S3 bucket name available globally right now?" for the
 * S3-create wizard's live availability badge. Uses the AWS CLI's head-bucket
 * probe under the project's connected AWS credentials:
 *
 *   HTTP 200 → bucket exists AND we own it → name is TAKEN (by us)
 *   HTTP 403 → bucket exists but not owned by us → name is TAKEN globally
 *   HTTP 404 → no such bucket → name is AVAILABLE
 *
 * Format validation (charset / length / IP-shape) runs before any AWS call
 * so an obviously-bad name returns instantly without spending an API call.
 * Fail-open on transient CLI errors: return `unknown` so the UI shows a
 * neutral state instead of scaring the user with a false "taken" badge.
 *
 * Response: { ok: true, status: "available" | "taken" | "invalid" | "unknown", message: string }
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const name = (new URL(req.url).searchParams.get("name") ?? "").trim();
  if (!name) {
    return NextResponse.json({
      ok: true,
      status: "invalid",
      message: "Enter a bucket name.",
    });
  }

  // Cheap client-side-mirror validation first — obvious rejects avoid a
  // pointless AWS round trip.
  const fmt = validateBucketName(name);
  if (!fmt.ok) {
    return NextResponse.json({ ok: true, status: "invalid", message: fmt.error });
  }

  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId: gate.access.project.id, kind: "aws" },
    select: { id: true },
  });
  if (!cp) {
    return NextResponse.json({
      ok: true,
      status: "unknown",
      message: "No AWS account connected — can't check availability. Format looks valid.",
    });
  }
  const creds = await resolveAwsExecEnv(cp.id);
  if (!creds.ok) {
    return NextResponse.json({
      ok: true,
      status: "unknown",
      message: `Couldn't reach AWS to check availability (${creds.message}). Format looks valid.`,
    });
  }

  const res = await runStage({
    command: "aws",
    args: ["s3api", "head-bucket", "--bucket", name, "--no-cli-pager"],
    cwd: tmpdir(),
    env: { ...creds.env },
    timeoutMs: 10000,
    maxBufferBytes: 128 * 1024,
  });

  // Exit 0 → head-bucket succeeded → bucket exists in the caller's account.
  if (res.exitCode === 0) {
    return NextResponse.json({
      ok: true,
      status: "taken",
      message: `"${name}" already exists in your AWS account.`,
    });
  }
  const stderr = res.stderr ?? "";
  // The AWS CLI reports the underlying HTTP status in stderr as e.g.
  // "An error occurred (404) when calling the HeadBucket operation".
  // Match on the numeric status because AWS re-worded the human message
  // across CLI versions ("Not Found" vs "NotFound", "Forbidden" vs "Access Denied").
  if (/\(404\)|Not\s*Found/i.test(stderr)) {
    return NextResponse.json({
      ok: true,
      status: "available",
      message: `"${name}" is available globally.`,
    });
  }
  if (/\(403\)|Forbidden|Access\s*Denied/i.test(stderr)) {
    return NextResponse.json({
      ok: true,
      status: "taken",
      message: `"${name}" already exists in a DIFFERENT AWS account.`,
    });
  }
  if (/\(301\)|Moved\s*Permanently/i.test(stderr)) {
    // 301 means the bucket exists but in a different region than the CLI's
    // default. That still counts as "name is taken globally".
    return NextResponse.json({
      ok: true,
      status: "taken",
      message: `"${name}" already exists (in a different region).`,
    });
  }
  return NextResponse.json({
    ok: true,
    status: "unknown",
    message: `Couldn't determine availability (aws exit ${res.exitCode}): ${stderr.slice(-160)}. Format looks valid.`,
  });
}
