import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { scanRepoWithTrivy } from "@/lib/automation/trivy";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * POST /projects/[slug]/automation/trivy/scan
 *
 * Runs Trivy server-side against the connected repo and returns parsed
 * vulnerability findings for in-app display. Can take ~30s+ for large repos.
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

  const result = await scanRepoWithTrivy(gate.access.project.id, parsed.data.repoFullName);
  if (!result.ok) {
    return NextResponse.json({ ok: false, code: "scan_failed", message: result.error }, { status: 400 });
  }

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "repo.scanned",
    targetType: "repo",
    targetId: parsed.data.repoFullName,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { automation: "trivy", total: result.total, counts: result.counts },
  });

  return NextResponse.json(result);
}
