/**
 * Set GitHub Actions repo secrets from the server. GitHub requires the value to
 * be encrypted with the repo's public key using a libsodium sealed box, then
 * PUT to the secrets API. Used to push the cluster kubeconfig (KUBECONFIG_B64)
 * so the generated CD workflow can reach the cluster with zero manual setup.
 */
import sealedbox from "tweetnacl-sealedbox-js";

const GH = "https://api.github.com";

type Res = { ok: true } | { ok: false; error: string };

function headers(token: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "Content-Type": "application/json",
  };
}

/** Encrypt a value with the repo's public key (libsodium sealed box → base64). */
function sealedBox(publicKeyB64: string, value: string): string {
  const key = new Uint8Array(Buffer.from(publicKeyB64, "base64"));
  const bytes = new Uint8Array(Buffer.from(value, "utf8"));
  const enc = sealedbox.seal(bytes, key);
  return Buffer.from(enc).toString("base64");
}

/** Create or update a repository Actions secret. */
export async function setRepoActionsSecret(
  token: string,
  fullName: string,
  name: string,
  value: string,
): Promise<Res> {
  if (!value)
    return { ok: false, error: `Refusing to write empty value to GitHub secret "${name}".` };
  let pk: Response;
  try {
    pk = await fetch(`${GH}/repos/${fullName}/actions/secrets/public-key`, {
      headers: headers(token),
      cache: "no-store",
    });
  } catch (e) {
    return {
      ok: false,
      error: `Network error reaching GitHub: ${e instanceof Error ? e.message : "error"}`,
    };
  }
  if (!pk.ok) {
    const t = await pk.text().catch(() => "");
    return {
      ok: false,
      error: `Couldn't read the repo public key (HTTP ${pk.status}). ${t.slice(0, 160)}`,
    };
  }
  const { key, key_id } = (await pk.json()) as { key?: string; key_id?: string };
  if (!key || !key_id)
    return { ok: false, error: "GitHub did not return a public key for this repo." };

  let encrypted_value: string;
  try {
    encrypted_value = sealedBox(key, value);
  } catch (e) {
    return { ok: false, error: `Encryption failed: ${e instanceof Error ? e.message : "error"}` };
  }

  let put: Response;
  try {
    put = await fetch(`${GH}/repos/${fullName}/actions/secrets/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: headers(token),
      body: JSON.stringify({ encrypted_value, key_id }),
    });
  } catch (e) {
    return {
      ok: false,
      error: `Network error writing the secret: ${e instanceof Error ? e.message : "error"}`,
    };
  }
  if (put.status !== 201 && put.status !== 204) {
    const t = await put.text().catch(() => "");
    return { ok: false, error: `Couldn't set the secret (HTTP ${put.status}). ${t.slice(0, 160)}` };
  }

  // Read-back verification — GitHub's PUT returns 204 even when secrets writes
  // race and end up missing. The GET returns the secret's metadata (no value)
  // if it exists, 404 otherwise. Fail loudly if the write didn't stick, so a
  // downstream CI docker/login-action doesn't hit "Username and password required".
  const exists = await repoActionsSecretExists(token, fullName, name);
  if (!exists.ok) return exists;
  if (!exists.data) {
    return {
      ok: false,
      error: `Secret "${name}" was written but doesn't appear on the repo — retry.`,
    };
  }
  return { ok: true };
}

/**
 * Check whether a repo Actions secret exists. GitHub does not expose the value,
 * but the metadata endpoint returns 200 if the name is present, 404 otherwise.
 * Used to verify a write actually landed and to preflight CI auth before a
 * generated workflow runs against missing secrets.
 */
export async function repoActionsSecretExists(
  token: string,
  fullName: string,
  name: string,
): Promise<{ ok: true; data: boolean } | { ok: false; error: string }> {
  let res: Response;
  try {
    res = await fetch(`${GH}/repos/${fullName}/actions/secrets/${encodeURIComponent(name)}`, {
      headers: headers(token),
      cache: "no-store",
    });
  } catch (e) {
    return {
      ok: false,
      error: `Network error reading the secret: ${e instanceof Error ? e.message : "error"}`,
    };
  }
  if (res.status === 200) return { ok: true, data: true };
  if (res.status === 404) return { ok: true, data: false };
  const t = await res.text().catch(() => "");
  return { ok: false, error: `Couldn't check the secret (HTTP ${res.status}). ${t.slice(0, 160)}` };
}

/**
 * Ensure a GitHub Actions deployment ENVIRONMENT exists on the repo
 * (dev/staging/prod). PUT is idempotent — creates the environment or leaves an
 * existing one (and its protection rules) untouched. Environment secrets and
 * variables both 404 until the environment itself exists, so every env-scoped
 * write goes through here first.
 */
export async function ensureRepoEnvironment(
  token: string,
  fullName: string,
  envName: string,
): Promise<Res> {
  let res: Response;
  try {
    res = await fetch(`${GH}/repos/${fullName}/environments/${encodeURIComponent(envName)}`, {
      method: "PUT",
      headers: headers(token),
      // Empty body = create with no protection rules; an existing environment
      // keeps whatever reviewers/timers the user configured.
      body: JSON.stringify({}),
    });
  } catch (e) {
    return {
      ok: false,
      error: `Network error creating the environment: ${e instanceof Error ? e.message : "error"}`,
    };
  }
  if (res.status === 200) return { ok: true };
  const t = await res.text().catch(() => "");
  return {
    ok: false,
    error: `Couldn't ensure environment "${envName}" (HTTP ${res.status}). ${t.slice(0, 160)}`,
  };
}

/**
 * Create or update an ENVIRONMENT-scoped Actions secret — what the generated
 * CD workflow reads as `${{ secrets.NAME }}` under `environment: <envName>`.
 * Same sealed-box dance as the repo-level variant, but against the
 * environment's own public key (environment secrets are encrypted separately).
 */
export async function setEnvActionsSecret(
  token: string,
  fullName: string,
  envName: string,
  name: string,
  value: string,
): Promise<Res> {
  if (!value)
    return { ok: false, error: `Refusing to write empty value to GitHub secret "${name}".` };
  const base = `${GH}/repos/${fullName}/environments/${encodeURIComponent(envName)}`;
  let pk: Response;
  try {
    pk = await fetch(`${base}/secrets/public-key`, { headers: headers(token), cache: "no-store" });
  } catch (e) {
    return {
      ok: false,
      error: `Network error reaching GitHub: ${e instanceof Error ? e.message : "error"}`,
    };
  }
  if (!pk.ok) {
    const t = await pk.text().catch(() => "");
    return {
      ok: false,
      error: `Couldn't read the environment public key (HTTP ${pk.status}). ${t.slice(0, 160)}`,
    };
  }
  const { key, key_id } = (await pk.json()) as { key?: string; key_id?: string };
  if (!key || !key_id)
    return { ok: false, error: "GitHub did not return a public key for this environment." };

  let encrypted_value: string;
  try {
    encrypted_value = sealedBox(key, value);
  } catch (e) {
    return { ok: false, error: `Encryption failed: ${e instanceof Error ? e.message : "error"}` };
  }

  let put: Response;
  try {
    put = await fetch(`${base}/secrets/${encodeURIComponent(name)}`, {
      method: "PUT",
      headers: headers(token),
      body: JSON.stringify({ encrypted_value, key_id }),
    });
  } catch (e) {
    return {
      ok: false,
      error: `Network error writing the secret: ${e instanceof Error ? e.message : "error"}`,
    };
  }
  if (put.status !== 201 && put.status !== 204) {
    const t = await put.text().catch(() => "");
    return {
      ok: false,
      error: `Couldn't set environment secret "${name}" (HTTP ${put.status}). ${t.slice(0, 160)}`,
    };
  }
  return { ok: true };
}

/**
 * Create or update an ENVIRONMENT-scoped Actions variable (`vars.NAME` under
 * `environment: <envName>`). Plain config — no encryption. PATCH-then-POST,
 * mirroring the repo-level variant.
 */
export async function setEnvActionsVariable(
  token: string,
  fullName: string,
  envName: string,
  name: string,
  value: string,
): Promise<Res> {
  const base = `${GH}/repos/${fullName}/environments/${encodeURIComponent(envName)}`;
  let res: Response;
  try {
    res = await fetch(`${base}/variables/${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: headers(token),
      body: JSON.stringify({ name, value }),
    });
  } catch (e) {
    return {
      ok: false,
      error: `Network error writing the variable: ${e instanceof Error ? e.message : "error"}`,
    };
  }
  if (res.status === 204) return { ok: true };
  if (res.status === 404) {
    let create: Response;
    try {
      create = await fetch(`${base}/variables`, {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify({ name, value }),
      });
    } catch (e) {
      return {
        ok: false,
        error: `Network error creating the variable: ${e instanceof Error ? e.message : "error"}`,
      };
    }
    if (create.status === 201) return { ok: true };
    const t = await create.text().catch(() => "");
    return {
      ok: false,
      error: `Couldn't create environment variable "${name}" (HTTP ${create.status}). ${t.slice(0, 160)}`,
    };
  }
  const t = await res.text().catch(() => "");
  return {
    ok: false,
    error: `Couldn't set environment variable "${name}" (HTTP ${res.status}). ${t.slice(0, 160)}`,
  };
}

/**
 * List the NAMES of an environment's Actions secrets. GitHub never returns
 * secret VALUES through the API — names + timestamps only, which is exactly
 * what an assignment UI needs (you pick which service gets a value you
 * already stored, you don't re-read it).
 */
export async function listEnvActionsSecrets(
  token: string,
  fullName: string,
  envName: string,
): Promise<{ ok: true; names: string[] } | { ok: false; error: string }> {
  const url = `${GH}/repos/${fullName}/environments/${encodeURIComponent(envName)}/secrets?per_page=100`;
  try {
    const res = await fetch(url, { headers: headers(token), cache: "no-store" });
    // No environment yet → no secrets. Not an error for a first-time deploy.
    if (res.status === 404) return { ok: true, names: [] };
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { ok: false, error: `Couldn't list environment secrets (HTTP ${res.status}). ${t.slice(0, 160)}` };
    }
    const j = (await res.json()) as { secrets?: Array<{ name?: string }> };
    return { ok: true, names: (j.secrets ?? []).map((s) => s.name ?? "").filter(Boolean) };
  } catch (e) {
    return { ok: false, error: `Network error: ${e instanceof Error ? e.message : "error"}` };
  }
}

/** List an environment's Actions variables (names AND values — vars aren't secret). */
export async function listEnvActionsVariables(
  token: string,
  fullName: string,
  envName: string,
): Promise<{ ok: true; vars: { name: string; value: string }[] } | { ok: false; error: string }> {
  const url = `${GH}/repos/${fullName}/environments/${encodeURIComponent(envName)}/variables?per_page=100`;
  try {
    const res = await fetch(url, { headers: headers(token), cache: "no-store" });
    if (res.status === 404) return { ok: true, vars: [] };
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { ok: false, error: `Couldn't list environment variables (HTTP ${res.status}). ${t.slice(0, 160)}` };
    }
    const j = (await res.json()) as { variables?: Array<{ name?: string; value?: string }> };
    return {
      ok: true,
      vars: (j.variables ?? [])
        .filter((v) => v.name)
        .map((v) => ({ name: v.name!, value: v.value ?? "" })),
    };
  } catch (e) {
    return { ok: false, error: `Network error: ${e instanceof Error ? e.message : "error"}` };
  }
}

/** Repo-level secret names — the fallback pool when an env has none of its own. */
export async function listRepoActionsSecrets(
  token: string,
  fullName: string,
): Promise<{ ok: true; names: string[] } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${GH}/repos/${fullName}/actions/secrets?per_page=100`, {
      headers: headers(token),
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, error: `Couldn't list repo secrets (HTTP ${res.status}).` };
    const j = (await res.json()) as { secrets?: Array<{ name?: string }> };
    return { ok: true, names: (j.secrets ?? []).map((s) => s.name ?? "").filter(Boolean) };
  } catch (e) {
    return { ok: false, error: `Network error: ${e instanceof Error ? e.message : "error"}` };
  }
}

/** Repo-level variables — same fallback role as listRepoActionsSecrets. */
export async function listRepoActionsVariables(
  token: string,
  fullName: string,
): Promise<{ ok: true; vars: { name: string; value: string }[] } | { ok: false; error: string }> {
  try {
    const res = await fetch(`${GH}/repos/${fullName}/actions/variables?per_page=100`, {
      headers: headers(token),
      cache: "no-store",
    });
    if (!res.ok) return { ok: false, error: `Couldn't list repo variables (HTTP ${res.status}).` };
    const j = (await res.json()) as { variables?: Array<{ name?: string; value?: string }> };
    return {
      ok: true,
      vars: (j.variables ?? []).filter((v) => v.name).map((v) => ({ name: v.name!, value: v.value ?? "" })),
    };
  } catch (e) {
    return { ok: false, error: `Network error: ${e instanceof Error ? e.message : "error"}` };
  }
}

/**
 * Create or update a repository Actions VARIABLE (`vars.NAME`). Variables are
 * plain config (NOT secrets) — no encryption — the right home for non-sensitive
 * pipeline config like the OIDC role ARN, region and ECR URI so workflows stay
 * generic instead of hardcoding values.
 */
export async function setRepoActionsVariable(
  token: string,
  fullName: string,
  name: string,
  value: string,
): Promise<Res> {
  // Try update first; create if it doesn't exist yet.
  let res: Response;
  try {
    res = await fetch(`${GH}/repos/${fullName}/actions/variables/${encodeURIComponent(name)}`, {
      method: "PATCH",
      headers: headers(token),
      body: JSON.stringify({ name, value }),
    });
  } catch (e) {
    return {
      ok: false,
      error: `Network error writing the variable: ${e instanceof Error ? e.message : "error"}`,
    };
  }
  if (res.status === 204) return { ok: true };
  if (res.status === 404) {
    let create: Response;
    try {
      create = await fetch(`${GH}/repos/${fullName}/actions/variables`, {
        method: "POST",
        headers: headers(token),
        body: JSON.stringify({ name, value }),
      });
    } catch (e) {
      return {
        ok: false,
        error: `Network error creating the variable: ${e instanceof Error ? e.message : "error"}`,
      };
    }
    if (create.status === 201) return { ok: true };
    const t = await create.text().catch(() => "");
    return {
      ok: false,
      error: `Couldn't create the variable (HTTP ${create.status}). ${t.slice(0, 160)}`,
    };
  }
  const t = await res.text().catch(() => "");
  return { ok: false, error: `Couldn't set the variable (HTTP ${res.status}). ${t.slice(0, 160)}` };
}
