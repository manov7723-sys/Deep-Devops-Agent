import { NextResponse } from "next/server";
import { getActiveSession } from "@/lib/auth/session";
import { buildTrustPolicy, getPlatformAccountId, getUserExternalId } from "@/lib/cloud/aws-onboard";

/**
 * GET /onboard/aws/external-id
 *
 * Returns the caller's app-dictated ExternalId, the platform's AWS account ID,
 * and a ready-to-paste IAM trust policy. The user copies the policy into a role
 * in THEIR account, then hands us back only the role ARN (see /onboard/aws/connect).
 *
 * Port of the original backend's `GET /onboard/external-id`.
 */
export async function GET() {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });

  const externalId = getUserExternalId(sess.userId);
  const accountId = getPlatformAccountId();
  const trustPolicy = buildTrustPolicy(externalId, accountId);

  return NextResponse.json({
    ok: true,
    externalId,
    accountId,
    // Whether the platform account id is actually configured (vs. placeholder).
    accountConfigured: accountId !== "YOUR_AWS_ACCOUNT_ID",
    trustPolicy,
  });
}
