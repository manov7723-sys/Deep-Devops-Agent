/**
 * GCP "Sign in with Google" (OAuth authorization-code + PKCE) — the TS port of
 * the Python backend's gcp_connector OAuth flow. The user signs in, we get a
 * delegated cloud-platform token + a refresh token, store the refresh token
 * encrypted on a CloudProvider row, and mint access tokens on demand.
 *
 * Reuses the SAME registered Google OAuth client as the Python backend
 * (GCP_OAUTH_CLIENT_ID / GCP_OAUTH_CLIENT_SECRET). The redirect URI
 * (GCP_OAUTH_REDIRECT_URI) must be registered on that client in the Google
 * Cloud Console (APIs & Services → Credentials → Authorized redirect URIs).
 */
import { newPkce } from "./azure-oauth";

const AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const CRM = "https://cloudresourcemanager.googleapis.com/v1/projects";
const COMPUTE = "https://compute.googleapis.com/compute/v1/projects";
/** Full GCP resource access + identity. offline_access via access_type=offline. */
const SCOPE = "https://www.googleapis.com/auth/cloud-platform openid email";

export function gcpOAuthConfigured(): boolean {
  return !!(process.env.GCP_OAUTH_CLIENT_ID && process.env.GCP_OAUTH_CLIENT_SECRET);
}

function redirectUri(): string {
  return (
    process.env.GCP_OAUTH_REDIRECT_URI?.trim() ||
    "http://localhost:3000/api/v1/cloud-providers/gcp/oauth/callback"
  );
}

export { newPkce };

/** Build the Google authorize URL — account chooser + guaranteed refresh token. */
export function buildGcpAuthorizeUrl(state: string, challenge: string): string {
  const p = new URLSearchParams({
    client_id: process.env.GCP_OAUTH_CLIENT_ID ?? "",
    redirect_uri: redirectUri(),
    response_type: "code",
    scope: SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    access_type: "offline", // get a refresh token
    prompt: "consent select_account", // force refresh token + let the user pick the account
    include_granted_scopes: "true",
  });
  return `${AUTH}?${p.toString()}`;
}

export type GcpTokenSet = { accessToken: string; refreshToken: string; expiresIn: number };
type TokenResult = { ok: true; tokens: GcpTokenSet } | { ok: false; error: string };

async function tokenRequest(body: URLSearchParams): Promise<TokenResult> {
  let res: Response;
  try {
    res = await fetch(TOKEN, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      cache: "no-store",
    });
  } catch (err) {
    return { ok: false, error: `Network error reaching Google: ${err instanceof Error ? err.message : "unknown"}` };
  }
  const j = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !j.access_token) {
    return { ok: false, error: (j.error_description || j.error || `token request failed (${res.status})`).split("\n")[0] };
  }
  return {
    ok: true,
    tokens: { accessToken: j.access_token, refreshToken: j.refresh_token ?? "", expiresIn: j.expires_in ?? 3600 },
  };
}

/** Exchange an auth code (+ PKCE verifier) for tokens. */
export function exchangeGcpCode(code: string, verifier: string): Promise<TokenResult> {
  return tokenRequest(
    new URLSearchParams({
      client_id: process.env.GCP_OAUTH_CLIENT_ID ?? "",
      client_secret: process.env.GCP_OAUTH_CLIENT_SECRET ?? "",
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
      code_verifier: verifier,
    }),
  );
}

/** Mint a fresh access token from a stored refresh token. */
export function refreshGcpToken(refreshToken: string): Promise<TokenResult> {
  return tokenRequest(
    new URLSearchParams({
      client_id: process.env.GCP_OAUTH_CLIENT_ID ?? "",
      client_secret: process.env.GCP_OAUTH_CLIENT_SECRET ?? "",
      grant_type: "refresh_token",
      refresh_token: refreshToken,
    }),
  );
}

export type GcpProject = { projectId: string; name: string; projectNumber: string; lifecycleState: string };

/** List the GCP projects the token can access (validates + resolves a default). */
export async function listGcpProjects(
  accessToken: string,
): Promise<{ ok: true; projects: GcpProject[] } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(CRM, { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" });
  } catch (err) {
    return { ok: false, error: `Network error reaching GCP: ${err instanceof Error ? err.message : "unknown"}` };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, error: `GCP returned ${res.status} listing projects: ${body.slice(0, 200)}` };
  }
  const data = (await res.json().catch(() => ({}))) as {
    projects?: Array<{ projectId: string; name: string; projectNumber: string; lifecycleState: string }>;
  };
  const projects = (data.projects ?? []).map((p) => ({
    projectId: p.projectId,
    name: p.name,
    projectNumber: p.projectNumber,
    lifecycleState: p.lifecycleState,
  }));
  return { ok: true, projects };
}

export type GcpNetwork = { name: string; selfLink: string };
export type GcpSubnetwork = { name: string; network: string; region: string; ipCidrRange: string };

/** Extract the short network name from a Compute selfLink (…/networks/<name>). */
function networkName(selfLink: string): string {
  const i = selfLink.lastIndexOf("/networks/");
  return i >= 0 ? selfLink.slice(i + "/networks/".length) : selfLink;
}

/** List the VPC networks in a GCP project (used by the GKE "reuse network" picker). */
export async function listGcpNetworks(
  accessToken: string,
  project: string,
): Promise<{ ok: true; networks: GcpNetwork[] } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(`${COMPUTE}/${encodeURIComponent(project)}/global/networks`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
  } catch (err) {
    return { ok: false, error: `Network error reaching GCP: ${err instanceof Error ? err.message : "unknown"}` };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, error: `GCP returned ${res.status} listing networks: ${body.slice(0, 200)}` };
  }
  const data = (await res.json().catch(() => ({}))) as { items?: Array<{ name?: string; selfLink?: string }> };
  const networks = (data.items ?? []).map((n) => ({ name: n.name ?? "", selfLink: n.selfLink ?? "" }));
  return { ok: true, networks };
}

/** List the subnetworks in a GCP project + region (filtered client-side by network). */
export async function listGcpSubnetworks(
  accessToken: string,
  project: string,
  region: string,
): Promise<{ ok: true; subnetworks: GcpSubnetwork[] } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(`${COMPUTE}/${encodeURIComponent(project)}/regions/${encodeURIComponent(region)}/subnetworks`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
  } catch (err) {
    return { ok: false, error: `Network error reaching GCP: ${err instanceof Error ? err.message : "unknown"}` };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    return { ok: false, error: `GCP returned ${res.status} listing subnetworks: ${body.slice(0, 200)}` };
  }
  const data = (await res.json().catch(() => ({}))) as {
    items?: Array<{ name?: string; network?: string; ipCidrRange?: string }>;
  };
  const subnetworks = (data.items ?? []).map((s) => ({
    name: s.name ?? "",
    network: networkName(s.network ?? ""),
    region,
    ipCidrRange: s.ipCidrRange ?? "",
  }));
  return { ok: true, subnetworks };
}

const CONTAINER = "https://container.googleapis.com/v1";

/**
 * Fetch a GKE cluster's endpoint + CA via the Container REST API and build a
 * self-contained, token-based kubeconfig — app-managed, NO `gcloud` and no
 * exec/auth plugin. `location` may be a region or a zone. The embedded access
 * token is short-lived (~1h); the runner re-mints one from the stored OAuth
 * refresh token for ongoing kubectl calls.
 */
export async function getGkeKubeconfig(
  accessToken: string,
  project: string,
  location: string,
  clusterName: string,
): Promise<{ ok: true; kubeconfig: string } | { ok: false; error: string }> {
  const path = `${CONTAINER}/projects/${encodeURIComponent(project)}/locations/${encodeURIComponent(location)}/clusters/${encodeURIComponent(clusterName)}`;
  let res: Response;
  try {
    res = await fetch(path, { headers: { Authorization: `Bearer ${accessToken}` }, cache: "no-store" });
  } catch (err) {
    return { ok: false, error: `Network error reaching GCP: ${err instanceof Error ? err.message : "unknown"}` };
  }
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    let msg = `GCP returned ${res.status}`;
    try {
      const j = JSON.parse(body) as { error?: { message?: string } };
      if (j.error?.message) msg = j.error.message;
    } catch {
      if (body) msg = `${msg}: ${body.slice(0, 200)}`;
    }
    return { ok: false, error: msg };
  }
  const data = (await res.json().catch(() => ({}))) as {
    endpoint?: string;
    status?: string;
    masterAuth?: { clusterCaCertificate?: string };
  };
  if (data.status && data.status !== "RUNNING") {
    return { ok: false, error: `Cluster is not ready (status ${data.status}). Wait until it's RUNNING, then connect again.` };
  }
  const endpoint = data.endpoint;
  const ca = data.masterAuth?.clusterCaCertificate;
  if (!endpoint || !ca) {
    return { ok: false, error: "Found the cluster but it didn't return an endpoint/CA (it may be a private cluster without a public endpoint)." };
  }
  const kubeconfig = `apiVersion: v1
kind: Config
clusters:
- cluster:
    certificate-authority-data: ${ca}
    server: https://${endpoint}
  name: gke
contexts:
- context:
    cluster: gke
    user: gke
  name: gke
current-context: gke
users:
- name: gke
  user:
    token: ${accessToken}
`;
  return { ok: true, kubeconfig };
}
