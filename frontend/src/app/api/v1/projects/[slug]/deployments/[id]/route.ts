import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { getDeploymentRecord, specFromRecord, recordDeployment } from "@/lib/devops/deploy-history";
import { listDeployTargets } from "@/lib/devops/deploy";
import { createDeployApproval } from "@/lib/devops/deploy-approval";
import { rollbackDeployment } from "@/lib/devops/rollback";

const Body = z.object({ action: z.enum(["rollback", "redeploy"]) });

/**
 * Act on a past deployment:
 *   POST { action: "rollback" }  → kubectl rollout undo (revert to previous revision)
 *   POST { action: "redeploy" }  → re-apply the same image/spec
 */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ ok: false, message: "action must be 'rollback' or 'redeploy'." }, { status: 400 });

  const projectId = gate.access.project.id;
  const userId = gate.access.session.userId;
  const rec = await getDeploymentRecord(projectId, id);
  if (!rec) return NextResponse.json({ ok: false, message: "Deployment not found." }, { status: 404 });

  if (parsed.data.action === "rollback") {
    const res = await rollbackDeployment(projectId, rec.envKey, rec.appName, { namespace: rec.namespace });
    if (!res.ok) return NextResponse.json({ ok: false, message: res.error }, { status: 400 });
    await recordDeployment(projectId, userId, { envKey: rec.envKey }, specFromRecord(rec), "rolled_back", "Manual rollback to previous version.", "manual");
    return NextResponse.json({ ok: true, message: `Rolled back ${res.app} in ${rec.envKey}.` });
  }

  // redeploy — re-apply the same image/spec, but through the APPROVAL GATE.
  const targets = await listDeployTargets(projectId);
  const target = targets.find((t) => t.envKey === rec.envKey);
  if (!target) return NextResponse.json({ ok: false, message: `No deployable env "${rec.envKey}" (cluster disconnected?).` }, { status: 400 });

  const { approvalId } = await createDeployApproval(
    projectId,
    { envKey: target.envKey, envId: target.envId, namespace: rec.namespace, isProduction: target.isProduction },
    specFromRecord(rec),
    "manual",
  );
  return NextResponse.json({ ok: true, pendingApproval: true, approvalId, message: `Redeploy of ${rec.appName} submitted for approval — approve it on the Approvals page.` });
}
