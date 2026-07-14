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
  /**
   * Machine-diagnosable classification of a failed run, so the agent can
   * self-heal without asking the user. Populated only on conclusion="failure";
   * null otherwise. "acr_secrets_missing" matches our own preflight marker
   * (DEEPAGENT_ACR_SECRETS_MISSING) AND the raw docker/login-action error
   * message ("Username and password required"). See classifyFailure below.
   */
  failureKind?: "acr_secrets_missing" | "cd_no_aws_creds" | "cd_no_gcp_creds" | "ci_wif_binding_missing" | "unknown" | null;
  /** A short excerpt of the failing job's error annotations, for the agent's report. */
  failureHint?: string | null;
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
  const run: WorkflowRun = {
    runId: r.id,
    name: r.name ?? "",
    status: r.status ?? "unknown",
    conclusion: r.conclusion ?? null,
    headSha: r.head_sha ?? "",
    htmlUrl: r.html_url ?? "",
    failureKind: null,
    failureHint: null,
  };
  if (run.conclusion === "failure") {
    const cls = await classifyFailure(fullName, token, r.id);
    run.failureKind = cls.kind;
    run.failureHint = cls.hint;
  }
  return { ok: true, data: run };
}

/**
 * Peek at the failing run's job step logs (small, plain text) and match known
 * self-healable failure patterns. Right now we only care about the ACR secret-
 * mode docker-login failure — but the classifier is designed so future kinds
 * (missing kubeconfig, expired GCP WIF, etc.) drop in the same way.
 *
 * Fetches `/actions/runs/{id}/jobs` (JSON, cheap) and reads the step names +
 * `annotations` on the failing job's step. Falls back to fetching that step's
 * log tail if the annotations are empty. Never throws — a classifier failure
 * just downgrades to failureKind="unknown".
 */
async function classifyFailure(
  fullName: string,
  token: string,
  runId: number,
): Promise<{ kind: WorkflowRun["failureKind"]; hint: string | null }> {
  try {
    const jobsRes = await fetch(`${GH}/repos/${fullName}/actions/runs/${runId}/jobs`, { headers: headers(token), cache: "no-store" });
    if (!jobsRes.ok) return { kind: "unknown", hint: null };
    const jobs = (await jobsRes.json().catch(() => ({}))) as {
      jobs?: Array<{ id: number; name?: string; conclusion?: string | null; steps?: Array<{ name?: string; conclusion?: string | null; number?: number }> }>;
    };
    for (const job of jobs.jobs ?? []) {
      if (job.conclusion !== "failure") continue;
      const failingStep = (job.steps ?? []).find((s) => s.conclusion === "failure");

      // Fast path: our own preflight step names the marker. It's always the
      // first thing to break when secrets are missing because it runs BEFORE
      // docker/login-action.
      if (failingStep?.name && /Verify ACR push secrets/i.test(failingStep.name)) {
        return { kind: "acr_secrets_missing", hint: "Preflight found missing ACR admin secrets on the repo." };
      }

      // Fallback: read the failing step's log. Older workflow files (pre-fix)
      // don't have the preflight step; they'll fail directly at docker-login.
      if (failingStep?.number) {
        const stepLogUrl = `${GH}/repos/${fullName}/actions/jobs/${job.id}/logs`;
        const logRes = await fetch(stepLogUrl, { headers: headers(token), cache: "no-store", redirect: "follow" });
        if (logRes.ok) {
          const text = await logRes.text().catch(() => "");
          if (/DEEPAGENT_ACR_SECRETS_MISSING/.test(text)) {
            return { kind: "acr_secrets_missing", hint: "Preflight marker DEEPAGENT_ACR_SECRETS_MISSING found in job log." };
          }
          if (/Username and password required/i.test(text) && /docker\/login-action/i.test(text)) {
            return { kind: "acr_secrets_missing", hint: "docker/login-action failed with 'Username and password required' — repo secrets are missing or empty." };
          }
          // EKS CD workflow trying to call kubectl without AWS creds in the runner.
          // Root cause is the env's kubeconfig is an EKS exec-plugin config but
          // no AWS provider is connected on the project, so no configure-aws-
          // credentials step was generated. The agent's remedy: connect AWS,
          // then re-run deploy_my_app so the workflow is regenerated.
          if (/aws.*NoCredentials|Unable to locate credentials|aws.*exit code 253/i.test(text) && /kubectl|eks\.amazonaws\.com/i.test(text)) {
            return {
              kind: "cd_no_aws_creds",
              hint:
                "CD workflow's kubectl can't authenticate to EKS: no AWS credentials in the runner. " +
                "Root cause: the env's kubeconfig is EKS but no AWS cloud provider is connected on the project. " +
                "Connect AWS on the Cloud providers page, set the env's cloud provider to it, then re-run deploy_my_app to regenerate the workflow with the OIDC auth step.",
            };
          }
          // Same shape but for GKE — gcloud auth missing in the CD runner.
          if (/gke_gcloud_auth_plugin|cannot execute binary file|google.*credentials/i.test(text) && /kubectl|container\.googleapis\.com/i.test(text)) {
            return {
              kind: "cd_no_gcp_creds",
              hint:
                "CD workflow's kubectl can't authenticate to GKE: no GCP credentials in the runner. " +
                "Connect GCP on the Cloud providers page, set the env's cloud provider to it, then re-run deploy_my_app.",
            };
          }
          // GCP CI docker-push fails when the WIF SA impersonation binding is
          // missing for the current repo OR IAM hasn't propagated yet. Two
          // signatures:
          //   - gcloud.auth.docker-helper: 'iam.serviceAccounts.getAccessToken' denied
          //   - denied: Unauthenticated request... artifactregistry.repositories.uploadArtifacts
          if (
            /iam\.serviceAccounts\.getAccessToken|serviceAccountTokenCreator|workloadIdentityUser/i.test(text) ||
            (/artifactregistry\.repositories\.uploadArtifacts/i.test(text) && /Unauthenticated request/i.test(text))
          ) {
            return {
              kind: "ci_wif_binding_missing",
              hint:
                "CI docker-push can't impersonate the GCP service account: the WIF binding for this repo is missing " +
                "or IAM hasn't propagated. Call repair_gcp_wif_binding to re-run the WIF setup, wait for IAM, and rerun CI.",
            };
          }
        }
      }
    }
  } catch {
    // ignore — classifier is best-effort
  }
  return { kind: "unknown", hint: null };
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
