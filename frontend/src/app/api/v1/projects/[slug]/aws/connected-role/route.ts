import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";

/**
 * GET /projects/[slug]/aws/connected-role?env=<envKey>
 *
 * Identifies the AWS identity that will automatically get cluster-admin on a
 * NEWLY CREATED EKS cluster (enable_cluster_creator_admin_permissions grants
 * whoever applies the Terraform — i.e. this project's connected AWS provider
 * for the given env). Purely informational, shown on the cluster-creation
 * wizard's Access page so the user knows they don't need to re-add it.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const envKey = new URL(req.url).searchParams.get("env")?.trim();
  const env = envKey ? await envBySlugAndKey(gate.access.project.id, envKey) : null;

  const cp = await prisma.cloudProvider.findFirst({
    where: env?.cloudProviderId
      ? { id: env.cloudProviderId, kind: "aws" }
      : { projectId: gate.access.project.id, kind: "aws" },
    select: { name: true, roleArn: true, awsAccessKeyIdEnc: true },
    orderBy: env?.cloudProviderId ? undefined : { createdAt: "desc" },
  });

  if (!cp)
    return NextResponse.json({
      ok: true,
      connected: false,
      roleArn: null,
      providerName: null,
      source: "none",
    });
  return NextResponse.json({
    ok: true,
    connected: true,
    roleArn: cp.roleArn ?? null,
    providerName: cp.name,
    source: cp.roleArn ? "role" : cp.awsAccessKeyIdEnc ? "stored_keys" : "unknown",
  });
}
