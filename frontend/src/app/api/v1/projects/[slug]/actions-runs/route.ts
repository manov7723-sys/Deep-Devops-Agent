import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { resolveTokenForRepo } from "@/lib/oauth/repo-token";

/**
 * GET /projects/[slug]/actions-runs
 *
 * Live GitHub Actions runs across every repo attached to the project — the
 * data behind the "GitHub Actions" tab. Fetched straight from GitHub each
 * call (no rows of our own), so runs show up regardless of who started them:
 * the app's Run button, the chat agent, a git push, or someone clicking
 * re-run in the GitHub UI. The client polls this; keep it cheap (one runs
 * call per repo, capped).
 */
const GH = "https://api.github.com";
const PER_REPO = 15;
const MAX_TOTAL = 40;

export type ActionsRunRow = {
  repoFullName: string;
  runId: number;
  runNumber: number;
  workflowName: string;
  workflowPath: string;
  branch: string;
  event: string;
  status: string; // queued | in_progress | completed
  conclusion: string | null; // success | failure | cancelled | skipped | null
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
};

export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const repos = await prisma.repo.findMany({
    where: { deletedAt: null, projectRepos: { some: { projectId: gate.access.project.id } } },
    select: { id: true, fullName: true },
  });
  if (repos.length === 0) return NextResponse.json({ ok: true, runs: [] });

  const runs: ActionsRunRow[] = [];
  const errors: string[] = [];
  await Promise.all(
    repos.map(async (repo) => {
      const tok = await resolveTokenForRepo(repo.id);
      if (!tok.ok) {
        errors.push(`${repo.fullName}: ${tok.message}`);
        return;
      }
      let res: Response;
      try {
        res = await fetch(`${GH}/repos/${repo.fullName}/actions/runs?per_page=${PER_REPO}`, {
          headers: {
            Authorization: `Bearer ${tok.accessToken}`,
            Accept: "application/vnd.github+json",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          cache: "no-store",
        });
      } catch {
        errors.push(`${repo.fullName}: network error reaching GitHub`);
        return;
      }
      if (!res.ok) {
        errors.push(`${repo.fullName}: GitHub API ${res.status}`);
        return;
      }
      const data = (await res.json().catch(() => ({}))) as {
        workflow_runs?: Array<{
          id: number;
          run_number: number;
          name?: string;
          path?: string;
          head_branch?: string;
          event?: string;
          status?: string;
          conclusion?: string | null;
          html_url?: string;
          created_at?: string;
          updated_at?: string;
        }>;
      };
      for (const r of data.workflow_runs ?? []) {
        runs.push({
          repoFullName: repo.fullName,
          runId: r.id,
          runNumber: r.run_number,
          workflowName: r.name ?? r.path ?? "workflow",
          workflowPath: r.path ?? "",
          branch: r.head_branch ?? "",
          event: r.event ?? "",
          status: r.status ?? "unknown",
          conclusion: r.conclusion ?? null,
          htmlUrl: r.html_url ?? "",
          createdAt: r.created_at ?? "",
          updatedAt: r.updated_at ?? "",
        });
      }
    }),
  );

  runs.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
  return NextResponse.json({
    ok: true,
    runs: runs.slice(0, MAX_TOTAL),
    ...(errors.length ? { warnings: errors } : {}),
  });
}
