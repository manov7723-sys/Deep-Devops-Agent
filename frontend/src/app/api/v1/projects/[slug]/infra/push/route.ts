import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { writeRepoFileTool } from "@/lib/agent/tools/write-repo-file";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * POST /projects/[slug]/infra/push
 *
 * Commit a set of generated infra files (e.g. an EKS Terraform tree) to a repo
 * under a custom base path, on a feature branch, and open ONE PR. Each file is
 * committed via the existing write_repo_file flow (same repo scoping + branch
 * creation); the PR is opened on the first file and the rest land on the branch.
 */
const Body = z.object({
  repoFullName: z.string().trim().min(3),
  /** Folder the files go under, e.g. "terraform/eks/prod". Filenames are kept. */
  basePath: z.string().trim().max(280),
  files: z.record(z.string(), z.string()).refine((f) => Object.keys(f).length > 0, "No files to push."),
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
  const { repoFullName, basePath, files, branch, message, pullRequestBody } = parsed.data;
  const base = basePath.replace(/^\/+|\/+$/g, "");
  const toolCtx = { projectId: gate.access.project.id, userId: gate.access.session.userId };

  const committed: string[] = [];
  let pullRequest: { number: number; url: string } | undefined;
  let first = true;

  for (const [rel, content] of Object.entries(files)) {
    // Preserve the file's relative path (e.g. "templates/deployment.yaml") so
    // nested trees like Helm charts keep their structure. Flat files (EKS .tf)
    // have no slashes, so this is identical to keeping just the filename.
    const relPath = rel.replace(/^\/+/, "");
    const path = base ? `${base}/${relPath}` : relPath;
    const res = await writeRepoFileTool.execute(
      {
        repoFullName,
        path,
        content,
        branch,
        message,
        openPullRequest: first, // open the PR once; later files land on the branch
        pullRequestBody,
      },
      toolCtx,
    );
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, code: "commit_failed", message: `Failed on ${path}: ${res.error}`, committed },
        { status: 400 },
      );
    }
    committed.push(path);
    if (first && res.output.pullRequest) pullRequest = res.output.pullRequest;
    first = false;
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
    metadata: { basePath: base, branch, fileCount: committed.length },
  });

  return NextResponse.json({ ok: true, repoFullName, branch, basePath: base, committed, pullRequest });
}
