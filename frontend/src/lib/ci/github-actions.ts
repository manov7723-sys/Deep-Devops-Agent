/**
 * Thin helpers over the GitHub REST API for the "Run pipeline" flow:
 *   - commit the pipeline files to the repo's default branch in ONE commit
 *   - find / poll the resulting GitHub Actions run (status, jobs, steps, error)
 *
 * All calls use the OAuth token resolved for the repo (resolveTokenForRepo).
 * Committing `.github/workflows/*` requires the `workflow` OAuth scope.
 */

type GH = { token: string; repoFullName: string };
type FileEntry = { path: string; content: string };

const API = "https://api.github.com";

function headers(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

export type CommitResult = { ok: true; sha: string } | { ok: false; error: string };

/**
 * Commit all `files` to `branch` as a single commit via the git data API
 * (blobs → tree → commit → move ref). One clean commit instead of N.
 */
export async function commitFiles(
  gh: GH,
  branch: string,
  files: FileEntry[],
  message: string,
): Promise<CommitResult> {
  const h = headers(gh.token);
  const base = `${API}/repos/${gh.repoFullName}`;
  try {
    // 1 — current branch head + its tree.
    const refRes = await fetch(`${base}/git/refs/heads/${encodeURIComponent(branch)}`, { headers: h, cache: "no-store" });
    if (!refRes.ok) return { ok: false, error: `Could not read branch ${branch}: ${refRes.status} ${(await refRes.text()).slice(0, 160)}` };
    const baseSha = ((await refRes.json()) as { object: { sha: string } }).object.sha;
    const commitRes = await fetch(`${base}/git/commits/${baseSha}`, { headers: h, cache: "no-store" });
    if (!commitRes.ok) return { ok: false, error: `Could not read base commit: ${commitRes.status}` };
    const baseTreeSha = ((await commitRes.json()) as { tree: { sha: string } }).tree.sha;

    // 2 — blob per file.
    const tree: Array<{ path: string; mode: "100644"; type: "blob"; sha: string }> = [];
    for (const f of files) {
      const blobRes = await fetch(`${base}/git/blobs`, {
        method: "POST",
        headers: h,
        body: JSON.stringify({ content: Buffer.from(f.content, "utf8").toString("base64"), encoding: "base64" }),
      });
      if (!blobRes.ok) return { ok: false, error: `Blob create failed for ${f.path}: ${blobRes.status}` };
      const blobSha = ((await blobRes.json()) as { sha: string }).sha;
      tree.push({ path: f.path.replace(/^\/+/, ""), mode: "100644", type: "blob", sha: blobSha });
    }

    // 3 — tree, 4 — commit, 5 — move ref.
    const treeRes = await fetch(`${base}/git/trees`, {
      method: "POST", headers: h,
      body: JSON.stringify({ base_tree: baseTreeSha, tree }),
    });
    if (!treeRes.ok) return { ok: false, error: `Tree create failed: ${treeRes.status}` };
    const newTreeSha = ((await treeRes.json()) as { sha: string }).sha;

    const newCommitRes = await fetch(`${base}/git/commits`, {
      method: "POST", headers: h,
      body: JSON.stringify({ message, tree: newTreeSha, parents: [baseSha] }),
    });
    if (!newCommitRes.ok) return { ok: false, error: `Commit create failed: ${newCommitRes.status}` };
    const newCommitSha = ((await newCommitRes.json()) as { sha: string }).sha;

    const moveRes = await fetch(`${base}/git/refs/heads/${encodeURIComponent(branch)}`, {
      method: "PATCH", headers: h,
      body: JSON.stringify({ sha: newCommitSha, force: false }),
    });
    if (!moveRes.ok) {
      const body = await moveRes.text();
      // 422 with "workflow" in the message = missing `workflow` OAuth scope.
      if (body.includes("workflow")) {
        return { ok: false, error: "GitHub rejected the workflow file — the connection is missing the `workflow` scope. Reconnect GitHub to grant it." };
      }
      return { ok: false, error: `Could not update ${branch}: ${moveRes.status} ${body.slice(0, 160)}` };
    }
    return { ok: true, sha: newCommitSha };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "Commit failed." };
  }
}

/** Fire workflow_dispatch (best-effort; ignored if the workflow lacks the trigger). */
export async function dispatchWorkflow(gh: GH, workflowFileName: string, ref: string): Promise<void> {
  try {
    await fetch(`${API}/repos/${gh.repoFullName}/actions/workflows/${encodeURIComponent(workflowFileName)}/dispatches`, {
      method: "POST",
      headers: headers(gh.token),
      body: JSON.stringify({ ref }),
    });
  } catch {
    /* best-effort — the push trigger usually starts the run anyway */
  }
}

export type RunRef = { id: number; url: string; status: string; conclusion: string | null };

/** Find the most recent Actions run for a workflow on a branch (optionally matching a commit sha). */
export async function findRun(gh: GH, workflowFileName: string, branch: string, headSha?: string): Promise<RunRef | null> {
  try {
    const url = `${API}/repos/${gh.repoFullName}/actions/workflows/${encodeURIComponent(workflowFileName)}/runs?branch=${encodeURIComponent(branch)}&per_page=10`;
    const res = await fetch(url, { headers: headers(gh.token), cache: "no-store" });
    if (!res.ok) return null;
    const runs = ((await res.json()) as { workflow_runs?: Array<{ id: number; html_url: string; status: string; conclusion: string | null; head_sha: string }> }).workflow_runs ?? [];
    const match = headSha ? runs.find((r) => r.head_sha === headSha) ?? runs[0] : runs[0];
    if (!match) return null;
    return { id: match.id, url: match.html_url, status: match.status, conclusion: match.conclusion };
  } catch {
    return null;
  }
}

export type StageStatus = {
  name: string;
  status: string; // queued | in_progress | completed
  conclusion: string | null; // success | failure | skipped | null
  steps: Array<{ name: string; status: string; conclusion: string | null }>;
};

export type RunStatus = {
  status: string; // queued | in_progress | completed
  conclusion: string | null;
  url: string;
  stages: StageStatus[];
};

/** Full status of a run: its jobs + steps. */
export async function getRunStatus(gh: GH, runId: string | number): Promise<RunStatus | null> {
  try {
    const h = headers(gh.token);
    const base = `${API}/repos/${gh.repoFullName}`;
    const runRes = await fetch(`${base}/actions/runs/${runId}`, { headers: h, cache: "no-store" });
    if (!runRes.ok) return null;
    const run = (await runRes.json()) as { status: string; conclusion: string | null; html_url: string };
    const jobsRes = await fetch(`${base}/actions/runs/${runId}/jobs`, { headers: h, cache: "no-store" });
    const jobs = jobsRes.ok
      ? ((await jobsRes.json()) as { jobs?: Array<{ name: string; status: string; conclusion: string | null; steps?: Array<{ name: string; status: string; conclusion: string | null }> }> }).jobs ?? []
      : [];
    const stages: StageStatus[] = jobs.map((j) => ({
      name: j.name,
      status: j.status,
      conclusion: j.conclusion,
      steps: (j.steps ?? []).map((s) => ({ name: s.name, status: s.status, conclusion: s.conclusion })),
    }));
    return { status: run.status, conclusion: run.conclusion, url: run.html_url, stages };
  } catch {
    return null;
  }
}

/** Fetch the plain-text log for the first failed job (for the agent reviewer / UI error). */
export async function getFailedJobLog(gh: GH, runId: string | number): Promise<string | null> {
  try {
    const h = headers(gh.token);
    const base = `${API}/repos/${gh.repoFullName}`;
    const jobsRes = await fetch(`${base}/actions/runs/${runId}/jobs`, { headers: h, cache: "no-store" });
    if (!jobsRes.ok) return null;
    const jobs = ((await jobsRes.json()) as { jobs?: Array<{ id: number; conclusion: string | null }> }).jobs ?? [];
    const failed = jobs.find((j) => j.conclusion === "failure");
    if (!failed) return null;
    const logRes = await fetch(`${base}/actions/jobs/${failed.id}/logs`, { headers: h, redirect: "follow", cache: "no-store" });
    if (!logRes.ok) return null;
    const text = await logRes.text();
    // Keep the tail — that's where the error is.
    return text.slice(-6000);
  } catch {
    return null;
  }
}

/** "owner/repo" + ".github/workflows/x.yml" → "x.yml" (the dispatch/runs identifier). */
export function workflowFileName(workflowPath: string | null): string | null {
  if (!workflowPath) return null;
  const m = workflowPath.replace(/^\/+/, "").match(/([^/]+\.ya?ml)$/);
  return m ? m[1] : null;
}
