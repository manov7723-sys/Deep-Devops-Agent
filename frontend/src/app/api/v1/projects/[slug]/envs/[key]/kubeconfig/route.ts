import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * DELETE /projects/[slug]/envs/[key]/kubeconfig
 *
 * Clear the env's stored kubeconfig, so the UI can move on cleanly after the
 * underlying cluster was deleted out from under it. Without this the row still
 * had `kubeconfigRef` set and every page tried (and failed) to reach a cluster
 * that no longer resolves — the fix on the read side is honest about the
 * failure, but the user still needs a way to REMOVE the stale pointer without
 * hand-editing the database.
 *
 * developer-role gate: same as any other env-config change.
 */
export async function DELETE(
  req: Request,
  ctx: { params: Promise<{ slug: string; key: string }> },
) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const env = await envBySlugAndKey(gate.access.project.id, key);
  if (!env) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
  if (!env.kubeconfigRef) {
    // Nothing to do — treat as success so retries are idempotent.
    return NextResponse.json({ ok: true, cleared: false });
  }

  await prisma.env.update({ where: { id: env.id }, data: { kubeconfigRef: null } });

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "env.updated",
    targetType: "env",
    targetId: env.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { fields: ["kubeconfigRef"], reason: "cleared_stale_kubeconfig" },
  });
  return NextResponse.json({ ok: true, cleared: true });
}
