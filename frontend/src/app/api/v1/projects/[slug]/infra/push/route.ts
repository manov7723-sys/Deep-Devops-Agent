import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { writeRepoFileTool } from "@/lib/agent/tools/write-repo-file";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * POST /projects/[slug]/infra/push
 *
 * Commit a set of generated infra files (e.g. an EKS Terraform tree) to a repo
 * directly on its DEFAULT branch (main/master). No feature branch, no PR.
 *
 * The route used to accept a branch + open a PR on the first file. That
 * violated INFRA_PLAYBOOK's explicit rule ("Push = write_repo_file committed
 * DIRECTLY to the repo's default branch — NEVER pass openPullRequest, NEVER
 * invent a feature/infra branch") and forced every user to hand-merge a PR
 * before an apply could see the file (heal_terraform_state / apply both read
 * the default branch). It also mismatched the agent's own behaviour — the
 * agent commits terraform to main; only the wizard-fence path landed on a
 * feature branch. Now both paths land the same place.
 *
 * The caller may still pass `branch` for backwards compat, but we ignore it.
 */
const Body = z.object({
  repoFullName: z.string().trim().min(3),
  /** Folder the files go under, e.g. "terraform/eks/prod". Filenames are kept. */
  basePath: z.string().trim().max(280),
  files: z
    .record(z.string(), z.string())
    .refine((f) => Object.keys(f).length > 0, "No files to push."),
  /** Accepted but ignored — commits always land on the repo's default branch. */
  branch: z.string().trim().min(1).max(200).optional(),
  message: z.string().trim().min(1).max(200),
  /** Accepted but ignored — no PR is opened. */
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
  const { repoFullName, basePath, files, message } = parsed.data;
  const base = basePath.replace(/^\/+|\/+$/g, "");
  const toolCtx = { projectId: gate.access.project.id, userId: gate.access.session.userId };

  // Resolve the repo's default branch — that's where every file lands.
  // Fallback to "main" only if the repo row is somehow missing that field
  // (shouldn't happen in practice; the projectRepo attach flow captures it).
  const repo = await prisma.repo.findFirst({
    where: { fullName: repoFullName, deletedAt: null },
    select: { defaultBranch: true },
  });
  const defaultBranch = repo?.defaultBranch?.trim() || "main";

  const committed: string[] = [];

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
        branch: defaultBranch,
        message,
        // openPullRequest omitted — direct-commit to default branch.
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
    metadata: { basePath: base, branch: defaultBranch, fileCount: committed.length, direct: true },
  });

  return NextResponse.json({
    ok: true,
    repoFullName,
    branch: defaultBranch,
    basePath: base,
    committed,
  });
}
