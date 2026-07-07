/**
 * OAuth provider configs (GitHub + GitLab + Google). Credentials are resolved
 * at call time from:
 *   1. the OAuthProviderConfig DB row (admin-managed, encrypted),
 *   2. the legacy env vars `<PROVIDER>_OAUTH_CLIENT_ID` / `_SECRET`
 *      (bootstrap fallback so a fresh install still works without DB write).
 *
 * Mock mode (DDA_OAUTH_MOCK=1):
 *   - `start` returns the authorize URL as JSON instead of redirecting.
 *   - `callback` accepts a `_mock_profile=<base64-json>` query param that
 *     stands in for the provider's token+userinfo response.
 */
import type { OAuthProvider } from "@prisma/client";
import { getOAuthCredentials } from "@/lib/admin/oauth-config";

export type ProviderId = OAuthProvider; // "github" | "google" | "gitlab"

export type ProviderConfig = {
  id: ProviderId;
  authorizeUrl: string;
  tokenUrl: string;
  userinfoUrl: string;
  scope: string;
  clientId: string;
  clientSecret: string;
  /** Instance base URL for host-bound providers (GitLab self-hosted). */
  baseUrl?: string;
  /** REST API root, e.g. "https://api.github.com" or "{base}/api/v4". */
  apiBaseUrl?: string;
};

function readEnv(key: string, required = true): string {
  const v = process.env[key];
  if (!v && required && !isMockMode()) {
    throw new Error(`Missing required env var: ${key}`);
  }
  return v ?? "";
}

export function isMockMode(): boolean {
  return process.env.DDA_OAUTH_MOCK === "1";
}

type ProviderMeta = Omit<ProviderConfig, "clientId" | "clientSecret">;

/**
 * Base URL of the GitLab instance this deployment talks to. gitlab.com by
 * default; set GITLAB_BASE_URL for self-hosted/enterprise. Read lazily (not
 * at module load) so the gitlab meta always reflects the running env.
 */
export function gitlabBaseUrl(): string {
  return (process.env.GITLAB_BASE_URL || "https://gitlab.com").replace(/\/+$/, "");
}

function gitlabMeta(): ProviderMeta {
  const base = gitlabBaseUrl();
  return {
    id: "gitlab",
    authorizeUrl: `${base}/oauth/authorize`,
    tokenUrl: `${base}/oauth/token`,
    userinfoUrl: `${base}/api/v4/user`,
    // `api` is required: no narrower scope covers repo write + CI/CD variables
    // + pipelines together. `read_user` gives the /user identity call.
    scope: "read_user api",
    baseUrl: base,
    apiBaseUrl: `${base}/api/v4`,
  };
}

const PROVIDER_META: Record<Exclude<ProviderId, "gitlab">, ProviderMeta> = {
  github: {
    id: "github",
    authorizeUrl: "https://github.com/login/oauth/authorize",
    tokenUrl: "https://github.com/login/oauth/access_token",
    userinfoUrl: "https://api.github.com/user",
    // `repo` includes read access to private repositories (for listing them
    // in the project-create wizard). Drop to `public_repo` if you want to
    // restrict the OAuth grant to public repos only.
    // `workflow` is REQUIRED to create/update files under .github/workflows/ —
    // a `repo`-only token writes every other path fine but GitHub rejects
    // workflow files (surfaces as a 404/422) without this extra scope.
    scope: "read:user user:email repo workflow",
    apiBaseUrl: "https://api.github.com",
  },
  google: {
    id: "google",
    authorizeUrl: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenUrl: "https://oauth2.googleapis.com/token",
    userinfoUrl: "https://openidconnect.googleapis.com/v1/userinfo",
    scope: "openid email profile",
  },
};

const ENV_KEYS: Record<ProviderId, { id: string; secret: string }> = {
  github: { id: "GITHUB_OAUTH_CLIENT_ID", secret: "GITHUB_OAUTH_CLIENT_SECRET" },
  google: { id: "GOOGLE_OAUTH_CLIENT_ID", secret: "GOOGLE_OAUTH_CLIENT_SECRET" },
  gitlab: { id: "GITLAB_OAUTH_CLIENT_ID", secret: "GITLAB_OAUTH_CLIENT_SECRET" },
};

function providerMeta(id: string): ProviderMeta | null {
  if (id === "gitlab") return gitlabMeta();
  return PROVIDER_META[id as Exclude<ProviderId, "gitlab">] ?? null;
}

/**
 * @deprecated Synchronous accessor reads from env only. Use `getProviderAsync()`
 * so admin-managed DB credentials take precedence. Kept for callers in mock-mode
 * paths that can't await.
 */
export function getProvider(id: string): ProviderConfig | null {
  const meta = providerMeta(id);
  if (!meta) return null;
  const env = ENV_KEYS[id as ProviderId];
  return {
    ...meta,
    clientId: readEnv(env.id),
    clientSecret: readEnv(env.secret),
  };
}

/**
 * Resolve a provider's full config (metadata + creds). DB row wins; env vars
 * are the fallback. Returns null when the provider isn't known, the DB row is
 * disabled, or no credentials are available anywhere.
 */
export async function getProviderAsync(id: string): Promise<ProviderConfig | null> {
  const meta = providerMeta(id);
  if (!meta) return null;

  const fromDb = await getOAuthCredentials(id as ProviderId);
  if (fromDb) {
    if (!fromDb.enabled) return null;
    return { ...meta, clientId: fromDb.clientId, clientSecret: fromDb.clientSecret };
  }

  const env = ENV_KEYS[id as ProviderId];
  const clientId = process.env[env.id] ?? "";
  const clientSecret = process.env[env.secret] ?? "";
  if (!clientId || !clientSecret) {
    if (isMockMode()) return { ...meta, clientId, clientSecret };
    return null;
  }
  return { ...meta, clientId, clientSecret };
}

export function callbackUrl(origin: string, providerId: ProviderId): string {
  return `${origin}/api/v1/auth/oauth/${providerId}/callback`;
}

export function buildAuthorizeUrl(args: {
  provider: ProviderConfig;
  origin: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: args.provider.clientId,
    redirect_uri: callbackUrl(args.origin, args.provider.id),
    response_type: "code",
    scope: args.provider.scope,
    state: args.state,
  });
  if (args.provider.id === "google") {
    // Google requires these for stable refresh-token behaviour.
    params.set("access_type", "offline");
    params.set("prompt", "consent");
  }
  if (args.provider.id === "github") {
    // Force GitHub's account picker / login every time instead of silently
    // reusing whatever account is already signed into github.com in this
    // browser. Without this, reconnecting grabs the existing session's
    // account (e.g. a shared/lead account) with no chance to switch. GitHub
    // added `prompt=select_account` support in June 2024.
    params.set("prompt", "select_account");
  }
  return `${args.provider.authorizeUrl}?${params.toString()}`;
}
