import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { resolveAwsExecEnv } from "@/lib/cloud/aws-onboard";
import { listEksClusters } from "@/lib/cloud/eks";

/**
 * GET /projects/[slug]/aws/clusters?region=us-east-1
 *
 * Lists the connected AWS account's EKS clusters in a region so the Clusters
 * page can offer "pick a region → pick a cluster" instead of typing a name.
 * App-managed: stored AWS creds + `aws eks list-clusters`, no host login.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const region = (new URL(req.url).searchParams.get("region") || "").trim();
  if (!region) return NextResponse.json({ ok: true, connected: false, clusters: [], note: "Pick a region first." });

  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId: gate.access.project.id, kind: "aws" },
    select: { id: true },
  });
  if (!cp) return NextResponse.json({ ok: true, connected: false, clusters: [], note: "Connect an AWS account on the Cloud providers page first." });

  // resolveAwsExecEnv (not raw getDecryptedCloudCreds): a role-based
  // connection needs its STS AssumeRole exchange to yield usable temp keys —
  // the raw resolver returns role METADATA only, which `aws eks
  // list-clusters` can't authenticate with, so role-connected accounts
  // always listed zero clusters.
  const creds = await resolveAwsExecEnv(cp.id);
  if (!creds.ok) return NextResponse.json({ ok: true, connected: false, clusters: [], note: creds.message });

  const res = await listEksClusters(creds.env, region);
  if (!res.ok) return NextResponse.json({ ok: true, connected: true, clusters: [], note: res.error });
  return NextResponse.json({ ok: true, connected: true, clusters: res.clusters });
}
