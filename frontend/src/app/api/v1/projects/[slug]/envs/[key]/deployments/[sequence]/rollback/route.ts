import { NextResponse } from "next/server";
import { RollbackRequest } from "@/lib/api/schemas/devops-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { rollbackTo } from "@/lib/devops/deployments";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string; key: string; sequence: string }> },
) {
  const { slug, key, sequence: seqStr } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const sequence = Number(seqStr);
  if (!Number.isInteger(sequence) || sequence < 1) {
    return NextResponse.json({ ok: false, code: "invalid_sequence" }, { status: 400 });
  }
  const env = await envBySlugAndKey(gate.access.project.id, key);
  if (!env) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });

  const parsed = RollbackRequest.safeParse(await req.json().catch(() => ({})));
  const note = parsed.success ? parsed.data.note : undefined;

  const res = await rollbackTo(env.id, gate.access.project.id, gate.access.session.userId, sequence, note);
  if (!res.ok) {
    const status = res.code === "target_not_found" ? 404 : 400;
    return NextResponse.json({ ok: false, code: res.code }, { status });
  }
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "deployment.rolled_back",
    targetType: "deployment",
    targetId: res.deploymentId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { envKey: key, toSequence: sequence, newSequence: res.sequence, pipelineId: res.pipelineId },
  });
  return NextResponse.json({
    ok: true,
    deploymentId: res.deploymentId,
    pipelineId: res.pipelineId,
    sequence: res.sequence,
  });
}
