/**
 * GCP Artifact Registry + keyless GitHub auth (Workload Identity Federation).
 * All server-side via the GCP REST APIs with the stored OAuth token (no
 * `gcloud`, no service-account key). Mirrors the AWS github-oidc.ts feature.
 *
 * The keyless chain we build so GitHub Actions can push WITHOUT any secret:
 *   1. Artifact Registry repo (docker)               — holds the images
 *   2. Workload Identity Pool + OIDC provider          — trusts GitHub's OIDC,
 *      scoped to ONE repo via an attribute condition
 *   3. A service account with roles/artifactregistry.writer
 *   4. Bind the pool's repo-principal to impersonate that SA
 * The workflow then uses google-github-actions/auth with the provider + SA.
 */
import { prisma } from "@/lib/db/prisma";
import { getGcpAccessToken } from "./gcp";

const POOL_ID = "github-pool";
const PROVIDER_ID = "github-provider";

type GcpResult<T> = { ok: true; data: T } | { ok: false; error: string };

async function resolveGcp(cloudProviderId: string): Promise<GcpResult<{ token: string; project: string }>> {
  const cp = await prisma.cloudProvider.findUnique({ where: { id: cloudProviderId }, select: { kind: true, accountRef: true } });
  if (cp?.kind !== "gcp") return { ok: false, error: "Not a GCP provider." };
  const project = cp.accountRef?.trim();
  if (!project) return { ok: false, error: "GCP provider has no project id." };
  const tok = await getGcpAccessToken(cloudProviderId);
  if (!tok.ok) return { ok: false, error: tok.error };
  return { ok: true, data: { token: tok.accessToken, project } };
}

async function gapi<T = Record<string, unknown>>(
  token: string,
  url: string,
  method = "GET",
  body?: unknown,
): Promise<GcpResult<T>> {
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { ok: false, error: `Network error reaching GCP: ${e instanceof Error ? e.message : "error"}` };
  }
  const text = await res.text();
  let data: T & { error?: { message?: string; status?: string } };
  try {
    data = (text ? JSON.parse(text) : {}) as T & { error?: { message?: string; status?: string } };
  } catch {
    // Non-JSON body (proxy/HTML error page) used to throw here and surface as a
    // bogus "unexpected response from the GCP API". Return the raw text instead.
    if (!res.ok) return { ok: false, error: `GCP HTTP ${res.status}: ${text.slice(0, 200) || "no body"}` };
    return { ok: true, data: {} as T };
  }
  if (!res.ok) {
    const msg = data?.error?.message || text.slice(0, 300) || `HTTP ${res.status}`;
    return { ok: false, error: hintGcpError(res.status, data?.error?.status, msg) };
  }
  return { ok: true, data };
}

/** Turn a raw GCP API error into an actionable message for a non-DevOps user. */
function hintGcpError(httpStatus: number, apiStatus: string | undefined, message: string): string {
  const m = message.toLowerCase();
  if (apiStatus === "PERMISSION_DENIED" || httpStatus === 403) {
    return (
      `${message}\n\nThe Google account you connected doesn't have permission to do this. ` +
      "Keyless CI setup needs the connected identity to have the roles Workload Identity Pool Admin, Service Account Admin, and Project IAM Admin (or Owner). " +
      "Ask your GCP admin to grant those, or reconnect with an owner account on the Cloud providers tab."
    );
  }
  if (/api .*not been used|service_disabled|it is disabled/i.test(m) || apiStatus === "FAILED_PRECONDITION") {
    return (
      `${message}\n\nA required Google API is disabled. Enable these in the GCP project, then retry: ` +
      "IAM (iam.googleapis.com), Security Token Service (sts.googleapis.com), IAM Credentials (iamcredentials.googleapis.com), Cloud Resource Manager (cloudresourcemanager.googleapis.com), and Artifact Registry (artifactregistry.googleapis.com)."
    );
  }
  return message;
}

/** Poll a long-running operation until done (pools/providers are LROs). */
async function awaitLro(token: string, opName: string): Promise<GcpResult<true>> {
  for (let i = 0; i < 30; i++) {
    const op = await gapi<{ done?: boolean; error?: { message?: string } }>(token, `https://iam.googleapis.com/v1/${opName}`);
    if (!op.ok) return op;
    if (op.data.done) return op.data.error ? { ok: false, error: op.data.error.message ?? "operation failed" } : { ok: true, data: true };
    await new Promise((r) => setTimeout(r, 2000));
  }
  return { ok: false, error: "GCP operation timed out." };
}

export type ArtifactRepo = { name: string; format: string; location: string };

/** List docker Artifact Registry repositories in a location. */
export async function listArtifactRegistries(cloudProviderId: string, location: string): Promise<GcpResult<ArtifactRepo[]>> {
  const r = await resolveGcp(cloudProviderId);
  if (!r.ok) return r;
  const { token, project } = r.data;
  const res = await gapi<{ repositories?: Array<{ name?: string; format?: string }> }>(
    token,
    `https://artifactregistry.googleapis.com/v1/projects/${project}/locations/${location}/repositories`,
  );
  if (!res.ok) return res;
  const repos = (res.data.repositories ?? []).map((x) => ({
    name: (x.name ?? "").split("/").pop() ?? "",
    format: x.format ?? "",
    location,
  }));
  return { ok: true, data: repos.filter((x) => x.format === "DOCKER") };
}

/** Create a docker Artifact Registry repository (idempotent-ish: ALREADY_EXISTS is treated as success). */
export async function createArtifactRegistry(cloudProviderId: string, location: string, repository: string): Promise<GcpResult<ArtifactRepo>> {
  const r = await resolveGcp(cloudProviderId);
  if (!r.ok) return r;
  const { token, project } = r.data;
  const res = await gapi(
    token,
    `https://artifactregistry.googleapis.com/v1/projects/${project}/locations/${location}/repositories?repositoryId=${encodeURIComponent(repository)}`,
    "POST",
    { format: "DOCKER", description: "Created by DeepAgent CI automation." },
  );
  if (!res.ok && !/already exists/i.test(res.error)) return res;
  return { ok: true, data: { name: repository, format: "DOCKER", location } };
}

export type WifResult = { workloadIdentityProvider: string; serviceAccount: string; projectNumber: string };

/**
 * Set up keyless GitHub→GCP auth for ONE repo. Idempotent: re-running reuses the
 * pool/provider/SA. Returns the provider resource name + SA email for the
 * workflow. The connected GCP identity needs IAM admin + Artifact Registry admin.
 */
export async function setupGithubWif(cloudProviderId: string, repoFullName: string): Promise<GcpResult<WifResult>> {
  const r = await resolveGcp(cloudProviderId);
  if (!r.ok) return r;
  const { token, project } = r.data;

  // 0 — project number (needed in the provider resource path).
  const proj = await gapi<{ projectNumber?: string }>(token, `https://cloudresourcemanager.googleapis.com/v1/projects/${project}`);
  if (!proj.ok) return proj;
  const projectNumber = proj.data.projectNumber;
  if (!projectNumber) return { ok: false, error: "Couldn't read the GCP project number." };

  // 1 — Workload Identity Pool (ignore ALREADY_EXISTS).
  const poolBase = `https://iam.googleapis.com/v1/projects/${project}/locations/global/workloadIdentityPools`;
  const poolCreate = await gapi<{ name?: string }>(token, `${poolBase}?workloadIdentityPoolId=${POOL_ID}`, "POST", {
    displayName: "GitHub Actions",
    description: "Keyless GitHub OIDC (DeepAgent).",
  });
  if (!poolCreate.ok && !/already exists/i.test(poolCreate.error)) return { ok: false, error: `Creating the workload identity pool failed. ${poolCreate.error}` };
  if (poolCreate.ok && poolCreate.data.name) await awaitLro(token, poolCreate.data.name);

  // 2 — OIDC provider in the pool, scoped to this GitHub repo.
  const provBase = `${poolBase}/${POOL_ID}/providers`;
  const provCreate = await gapi<{ name?: string }>(token, `${provBase}?workloadIdentityPoolProviderId=${PROVIDER_ID}`, "POST", {
    displayName: "GitHub",
    oidc: { issuerUri: "https://token.actions.githubusercontent.com" },
    attributeMapping: { "google.subject": "assertion.sub", "attribute.repository": "assertion.repository" },
    attributeCondition: `assertion.repository == "${repoFullName}"`,
  });
  if (!provCreate.ok && !/already exists/i.test(provCreate.error)) return { ok: false, error: `Creating the OIDC provider failed. ${provCreate.error}` };
  if (provCreate.ok && provCreate.data.name) await awaitLro(token, provCreate.data.name);

  // 3 — Service account (ignore ALREADY_EXISTS).
  const saId = "deepagent-gha";
  const saEmail = `${saId}@${project}.iam.gserviceaccount.com`;
  const saCreate = await gapi(token, `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts`, "POST", {
    accountId: saId,
    serviceAccount: { displayName: "DeepAgent GitHub Actions" },
  });
  if (!saCreate.ok && !/already exists/i.test(saCreate.error)) return { ok: false, error: `Creating the service account failed. ${saCreate.error}` };

  // 4 — Grant the SA push access at the project level (read-modify-write IAM policy).
  const grant = await addProjectBinding(token, project, `serviceAccount:${saEmail}`, "roles/artifactregistry.writer");
  if (!grant.ok) return { ok: false, error: `Granting Artifact Registry Writer to the service account failed. ${grant.error}` };

  // 5 — Let the GitHub repo principal impersonate the SA.
  const principal = `principalSet://iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${POOL_ID}/attribute.repository/${repoFullName}`;
  const impersonate = await addServiceAccountBinding(token, project, saEmail, principal, "roles/iam.workloadIdentityUser");
  if (!impersonate.ok) return { ok: false, error: `Binding the GitHub repo to the service account failed. ${impersonate.error}` };

  return {
    ok: true,
    data: {
      workloadIdentityProvider: `projects/${projectNumber}/locations/global/workloadIdentityPools/${POOL_ID}/providers/${PROVIDER_ID}`,
      serviceAccount: saEmail,
      projectNumber,
    },
  };
}

/** Parse a GKE kubeconfig's `gke_<project>_<location>_<cluster>` context. */
export function parseGkeClusterRef(kubeconfig: string): { projectId: string; location: string; clusterName: string } | null {
  const tok = kubeconfig.match(/gke_[a-z0-9-]+_[a-z0-9-]+_[A-Za-z0-9-]+/)?.[0];
  if (!tok) return null;
  const parts = tok.split("_"); // [gke, project, location, cluster]
  if (parts.length < 4) return null;
  return { projectId: parts[1], location: parts[2], clusterName: parts.slice(3).join("_") };
}

export type GcpDeployRegistry = {
  location: string;
  projectId: string;
  repository: string;
  workloadIdentityProvider: string;
  serviceAccount: string;
};

/**
 * Full GCP setup for the one-shot deploy flow, for ONE service: ensure the
 * Artifact Registry repo, set up keyless WIF, and grant the CI service account
 * BOTH Artifact Registry Writer (push) and Container Developer (so the CD
 * workflow can deploy to GKE). Idempotent. Returns everything the CI + CD
 * workflows need.
 */
export async function setupGcpDeployRegistry(
  cloudProviderId: string,
  repoFullName: string,
  location: string,
  repository: string,
): Promise<GcpResult<GcpDeployRegistry>> {
  const r = await resolveGcp(cloudProviderId);
  if (!r.ok) return r;
  const { token, project } = r.data;

  const reg = await createArtifactRegistry(cloudProviderId, location, repository);
  if (!reg.ok) return reg;

  const wif = await setupGithubWif(cloudProviderId, repoFullName);
  if (!wif.ok) return wif;

  // The CD workflow deploys to GKE as this SA — needs container.developer.
  const grant = await addProjectBinding(token, project, `serviceAccount:${wif.data.serviceAccount}`, "roles/container.developer");
  if (!grant.ok) return { ok: false, error: `Granting GKE deploy access to the service account failed. ${grant.error}` };

  return {
    ok: true,
    data: {
      location,
      projectId: project,
      repository,
      workloadIdentityProvider: wif.data.workloadIdentityProvider,
      serviceAccount: wif.data.serviceAccount,
    },
  };
}

/** Add a member→role binding on the PROJECT IAM policy (read-modify-write). */
async function addProjectBinding(token: string, project: string, member: string, role: string): Promise<GcpResult<true>> {
  const url = `https://cloudresourcemanager.googleapis.com/v1/projects/${project}`;
  const get = await gapi<{ bindings?: Array<{ role: string; members: string[] }> }>(token, `${url}:getIamPolicy`, "POST", {});
  if (!get.ok) return get;
  const policy = get.data;
  const bindings = policy.bindings ?? [];
  const existing = bindings.find((b) => b.role === role);
  if (existing) {
    if (existing.members.includes(member)) return { ok: true, data: true };
    existing.members.push(member);
  } else {
    bindings.push({ role, members: [member] });
  }
  const set = await gapi(token, `${url}:setIamPolicy`, "POST", { policy: { ...policy, bindings } });
  return set.ok ? { ok: true, data: true } : set;
}

/** Add a member→role binding on a SERVICE ACCOUNT's IAM policy. */
async function addServiceAccountBinding(token: string, project: string, saEmail: string, member: string, role: string): Promise<GcpResult<true>> {
  const url = `https://iam.googleapis.com/v1/projects/${project}/serviceAccounts/${saEmail}`;
  // getIamPolicy on a service account is a POST endpoint (GET returns a 404 HTML page).
  const get = await gapi<{ bindings?: Array<{ role: string; members: string[] }> }>(token, `${url}:getIamPolicy`, "POST", {});
  if (!get.ok) return get;
  const policy = get.data;
  const bindings = policy.bindings ?? [];
  const existing = bindings.find((b) => b.role === role);
  if (existing) {
    if (existing.members.includes(member)) return { ok: true, data: true };
    existing.members.push(member);
  } else {
    bindings.push({ role, members: [member] });
  }
  const set = await gapi(token, `${url}:setIamPolicy`, "POST", { policy: { ...policy, bindings } });
  return set.ok ? { ok: true, data: true } : set;
}
