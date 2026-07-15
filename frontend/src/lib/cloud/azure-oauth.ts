/**
 * Azure "Sign in with Microsoft" (OAuth authorization-code + PKCE) — the TS
 * port of the Python backend's azure_connector OAuth flow. The user signs in
 * interactively; we get a delegated ARM token + a refresh token, store the
 * refresh token encrypted on a CloudProvider row, and mint ARM access tokens
 * on demand from it.
 *
 * Reuses the SAME registered Azure AD app as the Python backend
 * (AZURE_OAUTH_CLIENT_ID / AZURE_OAUTH_CLIENT_SECRET / AZURE_OAUTH_TENANT_ID).
 *
 * NOTE: the redirect URI (AZURE_OAUTH_REDIRECT_URI) must be registered on that
 * app registration in the Azure portal (Authentication → Redirect URIs).
 */
import { createHash, randomBytes } from "node:crypto";

const LOGIN = "https://login.microsoftonline.com";
const ARM = "https://management.azure.com";
/** Scopes shown to the user at CONSENT time. Multi-resource is allowed at
 *  authorize (one consent screen covers everything the app will ever request),
 *  so we include BOTH ARM and Graph here — that lets `autoProvisionSpFromOAuth`
 *  work cross-tenant without a second consent flow (fixes AADSTS65001). */
const AUTHORIZE_SCOPES = `${ARM}/user_impersonation https://graph.microsoft.com/Application.ReadWrite.OwnedBy offline_access openid profile`;
/** ARM-only scope for token requests (code exchange, ARM refresh). Azure v2
 *  token endpoints reject multi-audience requests — a single token cannot
 *  target both ARM and Graph. Graph tokens are minted separately from the
 *  same refresh token via `refreshAzureGraphToken`. */
const OAUTH_SCOPE = `${ARM}/user_impersonation offline_access openid profile`;
/** Delegated Graph scope for creating AD apps + client secrets. Requested from
 *  the refresh token AFTER sign-in, so it only requires the app registration
 *  to declare this permission + admin consent — no scope changes in the
 *  interactive redirect. Set AZURE_OAUTH_GRAPH_ENABLED=true once the portal
 *  side is ready; the callback will try SP auto-provisioning silently and skip
 *  it (falling through to the existing OAuth-only path) if disabled. */
const GRAPH_SCOPE = "https://graph.microsoft.com/Application.ReadWrite.OwnedBy offline_access";

export function azureOAuthGraphEnabled(): boolean {
  return process.env.AZURE_OAUTH_GRAPH_ENABLED === "true";
}

export function azureOAuthConfigured(): boolean {
  return !!(process.env.AZURE_OAUTH_CLIENT_ID && process.env.AZURE_OAUTH_CLIENT_SECRET);
}

function tenant(): string {
  return process.env.AZURE_OAUTH_TENANT_ID?.trim() || "organizations";
}

function redirectUri(): string {
  return (
    process.env.AZURE_OAUTH_REDIRECT_URI?.trim() ||
    "http://localhost:3000/api/v1/cloud-providers/azure/oauth/callback"
  );
}

const b64url = (b: Buffer) =>
  b.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** Fresh PKCE pair + state for one authorization attempt. */
export function newPkce(): { state: string; verifier: string; challenge: string } {
  const state = b64url(randomBytes(24));
  const verifier = b64url(randomBytes(48));
  const challenge = b64url(createHash("sha256").update(verifier).digest());
  return { state, verifier, challenge };
}

/** Build the Microsoft authorize URL (account picker forced via prompt=select_account).
 *  Pass `tenantOverride` when the user provided a specific tenant ID on the connect
 *  UI — needed for personal Microsoft accounts whose subscription lives in a
 *  hidden AAD tenant that /common/ can't disambiguate for the ARM scope. */
export function buildAzureAuthorizeUrl(
  state: string,
  challenge: string,
  tenantOverride?: string,
): string {
  const p = new URLSearchParams({
    client_id: process.env.AZURE_OAUTH_CLIENT_ID ?? "",
    response_type: "code",
    redirect_uri: redirectUri(),
    response_mode: "query",
    // AUTHORIZE_SCOPES = ARM + Graph so ONE consent screen covers everything.
    scope: AUTHORIZE_SCOPES,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    // Force the account picker so Reconnect can choose a DIFFERENT account
    // instead of silently reusing the current Microsoft session.
    prompt: "select_account",
  });
  const t = (tenantOverride?.trim() || tenant()).trim();
  return `${LOGIN}/${t}/oauth2/v2.0/authorize?${p.toString()}`;
}

export type AzureTokenSet = {
  accessToken: string;
  refreshToken: string;
  expiresIn: number;
};

type TokenResult = { ok: true; tokens: AzureTokenSet } | { ok: false; error: string };

async function tokenRequest(body: URLSearchParams, tenantOverride?: string): Promise<TokenResult> {
  let res: Response;
  try {
    res = await fetch(`${LOGIN}/${(tenantOverride || tenant()).trim()}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
      cache: "no-store",
    });
  } catch (err) {
    return {
      ok: false,
      error: `Network error reaching Microsoft: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }
  const j = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !j.access_token) {
    return {
      ok: false,
      error: (j.error_description || j.error || `token request failed (${res.status})`).split(
        "\n",
      )[0],
    };
  }
  return {
    ok: true,
    tokens: {
      accessToken: j.access_token,
      refreshToken: j.refresh_token ?? "",
      expiresIn: j.expires_in ?? 3600,
    },
  };
}

/** Exchange an auth code (+ PKCE verifier) for tokens. `tenantOverride` must
 *  match the tenant used to build the authorize URL — Microsoft rejects the
 *  token exchange otherwise. */
export function exchangeAzureCode(
  code: string,
  verifier: string,
  tenantOverride?: string,
): Promise<TokenResult> {
  return tokenRequest(
    new URLSearchParams({
      client_id: process.env.AZURE_OAUTH_CLIENT_ID ?? "",
      client_secret: process.env.AZURE_OAUTH_CLIENT_SECRET ?? "",
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri(),
      code_verifier: verifier,
      scope: OAUTH_SCOPE,
    }),
    tenantOverride,
  );
}

/** Mint a fresh ARM access token from a stored refresh token (rotates it). */
export function refreshAzureToken(
  refreshToken: string,
  tenantOverride?: string,
): Promise<TokenResult> {
  return tokenRequest(
    new URLSearchParams({
      client_id: process.env.AZURE_OAUTH_CLIENT_ID ?? "",
      client_secret: process.env.AZURE_OAUTH_CLIENT_SECRET ?? "",
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: OAUTH_SCOPE,
    }),
    // Refresh against a SPECIFIC tenant when given one. For a personal Microsoft
    // account that owns a subscription, the generic /organizations/ authority
    // yields a "live.com#…" passthrough token that can't run privileged AKS
    // actions; targeting the subscription's real tenant fixes that.
    tenantOverride,
  );
}

/** Mint a Graph-audience access token from the same refresh token. Used for
 *  SP auto-provisioning right after OAuth sign-in. Returns AADSTS-consent-
 *  needed errors verbatim so the caller can log them and gracefully skip
 *  auto-provisioning (the OAuth flow itself remains successful). */
export function refreshAzureGraphToken(
  refreshToken: string,
  tenantOverride?: string,
): Promise<TokenResult> {
  return tokenRequest(
    new URLSearchParams({
      client_id: process.env.AZURE_OAUTH_CLIENT_ID ?? "",
      client_secret: process.env.AZURE_OAUTH_CLIENT_SECRET ?? "",
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      scope: GRAPH_SCOPE,
    }),
    tenantOverride,
  );
}

export type AzureSub = { id: string; displayName: string; state: string };

/** List ARM subscriptions visible to an access token (validates + resolves a default). */
export async function listAzureSubscriptions(
  accessToken: string,
): Promise<{ ok: true; subs: AzureSub[] } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(`${ARM}/subscriptions?api-version=2020-01-01`, {
      headers: { Authorization: `Bearer ${accessToken}` },
      cache: "no-store",
    });
  } catch (err) {
    return {
      ok: false,
      error: `Network error reaching Azure: ${err instanceof Error ? err.message : "unknown"}`,
    };
  }
  if (!res.ok) return { ok: false, error: `Azure returned ${res.status} listing subscriptions.` };
  const data = (await res.json().catch(() => ({}))) as {
    value?: Array<{ subscriptionId: string; displayName: string; state: string }>;
  };
  const subs = (data.value ?? []).map((s) => ({
    id: s.subscriptionId,
    displayName: s.displayName,
    state: s.state,
  }));
  return { ok: true, subs };
}
