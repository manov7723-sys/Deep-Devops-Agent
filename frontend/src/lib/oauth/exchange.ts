/**
 * Provider code-exchange + profile fetch. In mock mode (DDA_OAUTH_MOCK=1) the
 * `code` is treated as base64url(JSON) of the mock profile so E2E tests can
 * drive the callback without contacting GitHub/Google.
 */
import { callbackUrl, isMockMode, type ProviderConfig } from "./providers";

export type ProviderProfile = {
  providerAccountId: string;
  email: string;
  emailVerified: boolean;
  name: string;
  /**
   * Provider-side handle (GitHub `login`, Google email local-part). Stored
   * denormalized on OAuthAccount so multi-account UIs can render "alice"
   * instead of an opaque providerAccountId.
   */
  login: string;
  /** GitHub HTTPS avatar URL (when provided) — surfaced in UI. */
  avatarUrl?: string;
  accessToken: string;
  refreshToken?: string;
  expiresAt?: Date;
  scope?: string;
};

/**
 * Granular exchange failure codes. These are normalized across providers so
 * the login banner can render a specific actionable message:
 *
 *   incorrect_client_credentials — the admin's client_id/secret is wrong
 *   redirect_uri_mismatch        — provider's callback URL doesn't match
 *   bad_verification_code        — code is single-use & already spent / expired
 *   unsupported_grant_type       — token endpoint configured wrong (rare)
 *   exchange_http                — non-2xx HTTP with no parsable provider error
 *   exchange_failed              — generic catch-all for unknown failures
 */
export type ExchangeError =
  | { ok: false; code: "incorrect_client_credentials"; message: string }
  | { ok: false; code: "redirect_uri_mismatch"; message: string }
  | { ok: false; code: "bad_verification_code"; message: string }
  | { ok: false; code: "unsupported_grant_type"; message: string }
  | { ok: false; code: "exchange_http"; message: string }
  | { ok: false; code: "exchange_failed"; message: string }
  | { ok: false; code: "userinfo_failed"; message: string }
  | { ok: false; code: "no_email"; message: string }
  | { ok: false; code: "mock_invalid"; message: string };

export type ExchangeResult = { ok: true; profile: ProviderProfile } | ExchangeError;

/**
 * Map a provider-side error string (GitHub or Google) to one of our
 * normalized exchange codes. GitHub uses these constants:
 *   bad_verification_code, incorrect_client_credentials,
 *   redirect_uri_mismatch, unsupported_grant_type, unverified_user_email
 * Google uses RFC 6749 codes:
 *   invalid_grant, invalid_client, redirect_uri_mismatch,
 *   unsupported_grant_type
 */
function normalizeExchangeCode(raw: string | undefined | null):
  | "incorrect_client_credentials"
  | "redirect_uri_mismatch"
  | "bad_verification_code"
  | "unsupported_grant_type"
  | null {
  if (!raw) return null;
  const s = raw.toLowerCase();
  if (s === "incorrect_client_credentials" || s === "invalid_client") {
    return "incorrect_client_credentials";
  }
  if (s === "redirect_uri_mismatch") return "redirect_uri_mismatch";
  if (s === "bad_verification_code" || s === "invalid_grant") {
    return "bad_verification_code";
  }
  if (s === "unsupported_grant_type") return "unsupported_grant_type";
  return null;
}

export async function exchange(
  provider: ProviderConfig,
  code: string,
  origin: string,
): Promise<ExchangeResult> {
  if (isMockMode()) return mockExchange(provider, code);

  const tokenRes = await fetch(provider.tokenUrl, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      client_id: provider.clientId,
      client_secret: provider.clientSecret,
      code,
      redirect_uri: callbackUrl(origin, provider.id),
      grant_type: "authorization_code",
    }).toString(),
  });

  // Most providers return 200 with `{error, error_description}` on failure
  // (GitHub does this), but some return 4xx. Try to parse JSON in both cases.
  let token: {
    access_token?: string;
    refresh_token?: string;
    expires_in?: number;
    scope?: string;
    error?: string;
    error_description?: string;
  };
  try {
    token = await tokenRes.json();
  } catch {
    token = {};
  }

  if (!tokenRes.ok && !token.error) {
    // HTTP failure with no body we can parse — fall back to status code.
    return {
      ok: false,
      code: "exchange_http",
      message: `${tokenRes.status} ${tokenRes.statusText}`,
    };
  }

  if (token.error || !token.access_token) {
    const mapped = normalizeExchangeCode(token.error);
    if (mapped) {
      return {
        ok: false,
        code: mapped,
        message:
          token.error_description ?? token.error ?? "Provider rejected the code exchange.",
      };
    }
    return {
      ok: false,
      code: "exchange_failed",
      message:
        token.error_description ??
        token.error ??
        (token.access_token ? "missing fields" : "no access_token"),
    };
  }

  const userRes = await fetch(provider.userinfoUrl, {
    headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" },
  });
  if (!userRes.ok) {
    return { ok: false, code: "userinfo_failed", message: `${userRes.status}` };
  }
  const raw = (await userRes.json()) as Record<string, unknown>;

  const profile = normaliseProfile(provider.id, raw, token.access_token);

  if (provider.id === "github" && !profile.email) {
    // GitHub may not surface email on /user; hit /user/emails.
    const emailsRes = await fetch("https://api.github.com/user/emails", {
      headers: { Authorization: `Bearer ${token.access_token}`, Accept: "application/json" },
    });
    if (emailsRes.ok) {
      const list = (await emailsRes.json()) as Array<{
        email: string;
        primary?: boolean;
        verified?: boolean;
      }>;
      const primary = list.find((e) => e.primary && e.verified) ?? list.find((e) => e.verified);
      if (primary) {
        profile.email = primary.email;
        profile.emailVerified = !!primary.verified;
      }
    }
  }

  if (!profile.email) {
    return {
      ok: false,
      code: "no_email",
      message: "Provider did not return an email address.",
    };
  }

  profile.accessToken = token.access_token;
  profile.refreshToken = token.refresh_token;
  if (token.expires_in) profile.expiresAt = new Date(Date.now() + token.expires_in * 1000);
  profile.scope = token.scope;

  return { ok: true, profile };
}

function normaliseProfile(
  providerId: ProviderConfig["id"],
  raw: Record<string, unknown>,
  accessToken: string,
): ProviderProfile {
  if (providerId === "github") {
    const login = typeof raw.login === "string" ? raw.login : "";
    return {
      providerAccountId: String(raw.id ?? raw.node_id ?? ""),
      email: typeof raw.email === "string" ? raw.email : "",
      emailVerified: false, // verified flag is on /user/emails, set later
      name: (typeof raw.name === "string" && raw.name) || login,
      login,
      avatarUrl: typeof raw.avatar_url === "string" ? raw.avatar_url : undefined,
      accessToken,
    };
  }
  // google
  const email = typeof raw.email === "string" ? raw.email : "";
  return {
    providerAccountId: String(raw.sub ?? ""),
    email,
    emailVerified: raw.email_verified === true,
    name: (typeof raw.name === "string" && raw.name) || email,
    login: email.split("@")[0] ?? "",
    avatarUrl: typeof raw.picture === "string" ? raw.picture : undefined,
    accessToken,
  };
}

// ──────────────────────────────────────────────────────────────────
// Mock mode — the `code` is base64url(JSON({providerAccountId,email,name,emailVerified}))
// ──────────────────────────────────────────────────────────────────
function mockExchange(provider: ProviderConfig, code: string): ExchangeResult {
  try {
    const raw = Buffer.from(code, "base64url").toString("utf8");
    const obj = JSON.parse(raw) as {
      providerAccountId?: string;
      email?: string;
      emailVerified?: boolean;
      name?: string;
      login?: string;
    };
    if (!obj.providerAccountId || !obj.email) {
      return { ok: false, code: "mock_invalid", message: "providerAccountId + email required" };
    }
    return {
      ok: true,
      profile: {
        providerAccountId: obj.providerAccountId,
        email: obj.email.trim().toLowerCase(),
        emailVerified: obj.emailVerified ?? true,
        name: obj.name ?? obj.email,
        login: obj.login ?? obj.email.split("@")[0] ?? "",
        accessToken: `mock-token-${provider.id}-${Date.now()}`,
      },
    };
  } catch (err) {
    return {
      ok: false,
      code: "mock_invalid",
      message: err instanceof Error ? err.message : "could not decode mock code",
    };
  }
}
