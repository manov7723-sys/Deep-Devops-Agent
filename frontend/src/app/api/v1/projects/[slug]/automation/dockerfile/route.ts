import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { analyzeRepoForDockerfile } from "@/lib/automation/dockerfile";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * POST /projects/[slug]/automation/dockerfile
 *
 * "Create Dockerfile" automation: the agent analyzes the chosen repo and returns
 * a generated Dockerfile set (preview). The client then opens a PR via
 * /infra/push. Read-only against the repo — nothing is committed here.
 */
const Body = z.object({ repoFullName: z.string().trim().min(3) });

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false, code: `status_${gate.status}` }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: "invalid_request", message: "repoFullName is required." }, { status: 400 });
  }

  const result = await analyzeRepoForDockerfile(gate.access.project.id, parsed.data.repoFullName);
  if (!result.ok) {
    return NextResponse.json({ ok: false, code: "analysis_failed", message: result.error }, { status: 400 });
  }

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "repo.file_committed",
    targetType: "repo",
    targetId: parsed.data.repoFullName,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { automation: "dockerfile", stack: result.stack },
  });

  return NextResponse.json(result);
}
