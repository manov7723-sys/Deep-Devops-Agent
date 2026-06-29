import { NextResponse } from "next/server";
import { z } from "zod";
import { getActiveSession } from "@/lib/auth/session";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { createProvider } from "@/lib/cloud/providers";
import {
  accountIdFromRoleArn,
  getUserExternalId,
  verifyAssumeRole,
} from "@/lib/cloud/aws-onboard";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * POST /onboard/aws/connect
 *
 * Connect a customer AWS account via cross-account STS AssumeRole. The user
 * only supplies the role ARN (+ region + a friendly alias); the ExternalId is
 * derived server-side from the session — NEVER taken from the client.
 *
 * Port of the original backend's `POST /onboard/connect-aws`, but persists a
 * CloudProvider row instead of stuffing temp creds into process env.
 */
const Body = z.object({
  roleArn: z
    .string()
    .trim()
    .regex(/^arn:aws:iam::\d{12}:role\/.+/, "Role ARN must look like arn:aws:iam::<account>:role/<name>."),
  region: z.string().trim().min(1).max(40).default("us-east-1"),
  accountRef: z.string().trim().max(120).optional(),
  projectSlug: z.string().trim().optional(),
});

export async function POST(req: Request) {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const { roleArn, region } = parsed.data;
  const externalId = getUserExternalId(sess.userId);
  const customerAccountId = accountIdFromRoleArn(roleArn);

  // ISOLATION: bind the provider to the project it's connected in.
  let projectId: string | undefined;
  if (parsed.data.projectSlug) {
    const g = await requireProjectAccess(parsed.data.projectSlug, "developer");
    if (!g.ok) return NextResponse.json({ ok: false, code: "project_access" }, { status: g.status });
    projectId = g.access.project.id;
  }

  // Live check we can actually assume the role with our ExternalId. Best-effort:
  // if the aws CLI or the platform's own creds are missing, we still save the
  // provider (unverified) so the user isn't blocked — same tolerance as the
  // cluster-connect flow with kubectl.
  const verify = await verifyAssumeRole({ roleArn, externalId, region });
  if (!verify.ok && verify.code === "assume_failed") {
    // A genuine rejection (bad ARN / trust policy) — surface it, don't persist.
    return NextResponse.json(
      { ok: false, code: verify.code, message: verify.message, stderr: verify.stderr },
      { status: 400 },
    );
  }

  const accountRef =
    parsed.data.accountRef?.trim() ||
    (customerAccountId ? `aws-${customerAccountId}` : "AWS account");

  const provider = await createProvider({
    userId: sess.userId,
    projectId,
    kind: "aws",
    name: accountRef,
    accountRef,
    accountId: customerAccountId ?? undefined,
    region,
    roleArn,
    externalId,
  });

  const meta = extractRequestMeta(req);
  await audit({
    userId: sess.userId,
    action: "cloud_provider.created",
    targetType: "cloud_provider",
    targetId: provider.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { kind: "aws", region, roleArn, verified: verify.ok },
  });

  return NextResponse.json({
    ok: true,
    provider,
    verified: verify.ok,
    // When unverified, tell the client why so it can nudge the user.
    ...(verify.ok ? {} : { verifyCode: verify.code, verifyMessage: verify.message }),
  });
}
