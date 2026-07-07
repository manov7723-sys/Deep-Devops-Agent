/**
 * Poll GitHub Actions workflow runs so the agent can WAIT for the CI build+push
 * workflow to finish before writing/deploying the CD side. Uses the repo's
 * stored token (same access as the other repo tools).
 */
import { resolveAttachedRepo } from "@/lib/automation/repo-analyze";

const GH = "https://api.github.com";

export type WorkflowRun = {
  runId: number;
  name: string;
  status: string; // queued | in_progress | completed
  conclusion: string | null; // success | failure | cancelled | null (still running)
  headSha: string;
  htmlUrl: string;
};

type Res<T> = { ok: true; data: T } | { ok: false; error: string };

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

async function fetchLatestRun(fullName: string, token: string, opts: { workflowFile?: string; branch?: string }): Promise<Res<WorkflowRun | null>> {
  const params = new URLSearchParams({ per_page: "1" });
  if (opts.branch) params.set("branch", opts.branch);
  const path = opts.workflowFile
    ? `/repos/${fullName}/actions/workflows/${encodeURIComponent(opts.workflowFile)}/runs`
    : `/repos/${fullName}/actions/runs`;
  let res: Response;
  try {
    res = await fetch(`${GH}${path}?${params.toString()}`, { headers: headers(token), cache: "no-store" });
  } catch (e) {
    return { ok: false, error: `Network error reaching GitHub: ${e instanceof Error ? e.message : "error"}` };
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    return { ok: false, error: `GitHub API ${res.status}: ${t.slice(0, 200)}` };
  }
  const data = (await res.json().catch(() => ({}))) as {
    workflow_runs?: Array<{ id: number; name?: string; status?: string; conclusion?: string | null; head_sha?: string; html_url?: string }>;
  };
  const r = data.workflow_runs?.[0];
  if (!r) return { ok: true, data: null };
  return {
    ok: true,
    data: { runId: r.id, name: r.name ?? "", status: r.status ?? "unknown", conclusion: r.conclusion ?? null, headSha: r.head_sha ?? "", htmlUrl: r.html_url ?? "" },
  };
}

/**
 * Wait (poll) until the latest matching run finishes, or the timeout elapses.
 * Returns done=false with the current status if it's still running when time
 * runs out — the caller can re-invoke to keep waiting.
 */
export async function waitForWorkflowRun(
  projectId: string,
  repoFullName: string,
  opts: { workflowFile?: string; branch?: string; timeoutMs?: number; pollMs?: number } = {},
): Promise<Res<{ done: boolean; run: WorkflowRun | null }>> {
  const resolved = await resolveAttachedRepo(projectId, repoFullName);
  if (!resolved.ok) return { ok: false, error: resolved.error };
  const token = resolved.repo.accessToken;
  const branch = opts.branch || resolved.repo.ref;

  const timeoutMs = Math.min(Math.max(opts.timeoutMs ?? 240_000, 10_000), 300_000);
  const pollMs = Math.min(Math.max(opts.pollMs ?? 10_000, 3_000), 30_000);
  const deadline = Date.now() + timeoutMs;

  let last: WorkflowRun | null = null;
  // eslint-disable-next-line no-constant-condition
  while (true) {
    const r = await fetchLatestRun(repoFullName, token, { workflowFile: opts.workflowFile, branch });
    if (!r.ok) return r;
    last = r.data;
    if (last && last.status === "completed") return { ok: true, data: { done: true, run: last } };
    if (Date.now() >= deadline) return { ok: true, data: { done: false, run: last } };
    await new Promise((res) => setTimeout(res, pollMs));
  }
}
