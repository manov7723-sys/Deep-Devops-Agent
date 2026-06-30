import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { analyzeRepoForCompose } from "@/lib/automation/compose";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * POST /projects/[slug]/automation/compose
 *
 * "Create docker-compose" automation: detects the repo's stack and returns the
 * generated docker-compose.yml (preview). The client opens a PR via /infra/push.
 * Read-only against the repo — nothing is committed here.
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

  const result = await analyzeRepoForCompose(gate.access.project.id, parsed.data.repoFullName);
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
    metadata: { automation: "compose" },
  });

  return NextResponse.json(result);
}
