import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { writeRepoFileTool } from "@/lib/agent/tools/write-repo-file";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * POST /projects/[slug]/manifests/commit
 *
 * Commit a generated Kubernetes manifest to a project repo on a feature branch
 * and open a PR. Reuses the agent's write_repo_file implementation (same repo
 * scoping, branch creation, and default-branch protection).
 */
const Body = z.object({
  repoFullName: z.string().trim().min(3),
  path: z.string().trim().min(1).max(300),
  content: z
    .string()
    .min(1)
    .max(256 * 1024),
  branch: z.string().trim().min(1).max(200),
  message: z.string().trim().min(1).max(200),
  pullRequestBody: z.string().trim().max(4000).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const { repoFullName, path, content, branch, message, pullRequestBody } = parsed.data;

  const result = await writeRepoFileTool.execute(
    {
      repoFullName,
      path,
      content,
      branch,
      message,
      openPullRequest: true,
      pullRequestBody,
    },
    { projectId: gate.access.project.id, userId: gate.access.session.userId },
  );

  if (!result.ok) {
    return NextResponse.json(
      { ok: false, code: "commit_failed", message: result.error },
      { status: 400 },
    );
  }

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "repo.file_committed",
    targetType: "repo",
    targetId: repoFullName,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { path, branch },
  });

  return NextResponse.json({ ok: true, ...result.output });
}
