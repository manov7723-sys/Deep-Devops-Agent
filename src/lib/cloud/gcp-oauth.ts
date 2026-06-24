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
