import { NextResponse } from "next/server";
import { CreateApprovalRequest } from "@/lib/api/schemas/devops-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { createApproval, listApprovals } from "@/lib/devops/approvals";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const status = new URL(req.url).searchParams.get("status");
  const filter: { status: "pending" | "approved" | "rejected" } | undefined =
    status === "pending" || status === "approved" || status === "rejected" ? { status } : undefined;
  const approvals = await listApprovals(gate.access.project.id, filter);
  return NextResponse.json(approvals);
}

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const parsed = CreateApprovalRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const env = await envBySlugAndKey(gate.access.project.id, parsed.data.envKey);
  if (!env) return NextResponse.json({ ok: false, code: "env_not_found" }, { status: 404 });

  const approval = await createApproval({
    projectId: gate.access.project.id,
    envId: env.id,
    title: parsed.data.title,
    summary: parsed.data.summary,
    changesSummary: parsed.data.changesSummary,
    risk: parsed.data.risk,
    repoId: parsed.data.repoId,
    diff: parsed.data.diff,
  });
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "approval.created",
    targetType: "approval",
    targetId: approval.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { envKey: parsed.data.envKey, risk: parsed.data.risk },
  });
  return NextResponse.json({ ok: true, approval });
}
