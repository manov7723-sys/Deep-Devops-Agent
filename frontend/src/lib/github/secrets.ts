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
export async function setRepoActionsSecret(token: string, fullName: string, name: string, value: string): Promise<Res> {
  let pk: Response;
  try {
    pk = await fetch(`${GH}/repos/${fullName}/actions/secrets/public-key`, { headers: headers(token), cache: "no-store" });
  } catch (e) {
    return { ok: false, error: `Network error reaching GitHub: ${e instanceof Error ? e.message : "error"}` };
  }
  if (!pk.ok) {
    const t = await pk.text().catch(() => "");
    return { ok: false, error: `Couldn't read the repo public key (HTTP ${pk.status}). ${t.slice(0, 160)}` };
  }
  const { key, key_id } = (await pk.json()) as { key?: string; key_id?: string };
  if (!key || !key_id) return { ok: false, error: "GitHub did not return a public key for this repo." };

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
    return { ok: false, error: `Network error writing the secret: ${e instanceof Error ? e.message : "error"}` };
  }
  if (put.status !== 201 && put.status !== 204) {
    const t = await put.text().catch(() => "");
    return { ok: false, error: `Couldn't set the secret (HTTP ${put.status}). ${t.slice(0, 160)}` };
  }
  return { ok: true };
}
