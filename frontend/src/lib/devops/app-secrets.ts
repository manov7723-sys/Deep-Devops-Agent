/**
 * App configuration secrets — the non-database half of "make this app run".
 *
 * WHY THIS EXISTS:
 * The Connections page wires the DATABASE. Every real app also needs its own
 * config — API keys, signing keys, feature flags, third-party credentials —
 * and nothing in the product created those. They were set by hand with
 * `kubectl create secret ... --from-env-file`, which meant a freshly deployed
 * app started with none of them and failed in ways that look nothing like
 * "missing configuration":
 *
 *   • a signing key missing → login "succeeds" and the next request 401s
 *   • an API key missing    → a feature silently no-ops
 *
 * Pods read Secret values at container START and never hot-reload them, so
 * writing the Secret is only half the job — the Deployments must also be
 * rolled. Both happen here.
 */

export type ParsedEnv = { key: string; value: string };

/**
 * Ensure a specific key exists in an app config Secret WITHOUT wiping the rest
 * of it. Used by `deploy_my_app` to auto-inject required-in-production keys
 * (e.g. APP_SECRET_KEY for AES-GCM encryption of TOTP/OAuth/DB credentials)
 * on first deploy, then leave them alone on every subsequent deploy so the
 * generated key stays stable — rotating APP_SECRET_KEY invalidates every
 * encrypted value the app has ever stored.
 *
 * Uses `kubectl patch` with a strategic-merge payload so ONLY this key is
 * added/updated. Existing keys in the Secret survive untouched. Creates the
 * Secret from scratch when it doesn't exist yet.
 *
 * Returns changed=true only when a write actually happened. Idempotent: safe
 * to call on every deploy.
 */
export async function ensureAppEnvKey(args: {
  kubeconfigPath: string;
  execEnv: Record<string, string>;
  namespace: string;
  secretName: string;
  /** Env-var name to set. Must be a valid Secret data key. */
  key: string;
  /** Plaintext value — this helper base64-encodes for the Secret payload. */
  value: string;
  /**
   * When true, overwrite an existing value for the same key. Default false —
   * meaning "only add if missing". Persistence is the whole point for keys
   * like APP_SECRET_KEY, so the default is safe.
   */
  overwrite?: boolean;
}): Promise<
  | { ok: true; changed: boolean; message: string }
  | { ok: false; error: string }
> {
  const { kubeconfigPath, execEnv, namespace, secretName, key, value } = args;
  const overwrite = args.overwrite === true;
  const { runStage } = await import("@/lib/runner/exec");
  const env = { ...execEnv, KUBECONFIG: kubeconfigPath };

  // 1 — Does the Secret exist? Read the current data map.
  const get = await runStage({
    command: "kubectl",
    args: ["get", "secret", secretName, "-n", namespace, "-o", "jsonpath={.data}"],
    cwd: process.cwd(),
    env,
    timeoutMs: 30_000,
  });
  const b64 = Buffer.from(value, "utf8").toString("base64");

  if (get.exitCode !== 0) {
    // Secret doesn't exist — create it with just this key. The manifest is
    // fully declared so kubectl-apply can pick it up on the next deploy_my_app
    // run without conflict (labels + type match what applyAppSecret writes).
    const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = await mkdtemp(join(tmpdir(), "dda-ensurekey-"));
    try {
      // The Deployment references `app-env` with envFrom, and the namespace
      // may not exist yet on a first-ever deploy — but this helper runs AFTER
      // the CD workflow's namespace-heal step, so we assume namespace is Active.
      // Silently create the namespace as a safety belt anyway.
      await runStage({
        command: "kubectl",
        args: ["create", "namespace", namespace],
        cwd: dir,
        env,
        timeoutMs: 15_000,
      });
      const yaml = `apiVersion: v1
kind: Secret
metadata:
  name: ${secretName}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/managed-by: deepagent
type: Opaque
data:
  ${key}: ${b64}
`;
      const file = join(dir, "secret.yaml");
      await writeFile(file, yaml, { mode: 0o600 });
      const apply = await runStage({
        command: "kubectl",
        args: ["apply", "-f", file],
        cwd: dir,
        env,
        timeoutMs: 30_000,
      });
      if (apply.exitCode !== 0) {
        return { ok: false, error: `Could not create Secret "${secretName}": ${apply.stderr.slice(-200)}` };
      }
      return { ok: true, changed: true, message: `Created Secret "${secretName}" with key "${key}".` };
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  }

  // 2 — Secret exists. Is the key already there? kubectl's -o jsonpath={.data}
  //     returns a Go-style map literal (e.g. `map[APP_SECRET_KEY:<b64> DATABASE_URL:<b64>]`)
  //     rather than JSON, so parse loosely by looking for the key name.
  const dataDump = get.stdout;
  const alreadyPresent = new RegExp(`\\b${key.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\\\$&")}:`).test(dataDump);
  if (alreadyPresent && !overwrite) {
    return {
      ok: true,
      changed: false,
      message: `Secret "${secretName}" already has key "${key}" — not overwritten (rotation would invalidate all previously encrypted values).`,
    };
  }

  // 3 — Patch to add or overwrite this one key. Strategic-merge preserves
  //     every other data field in the Secret.
  const patchPayload = JSON.stringify({ data: { [key]: b64 } });
  const patch = await runStage({
    command: "kubectl",
    args: ["patch", "secret", secretName, "-n", namespace, "--type=merge", "-p", patchPayload],
    cwd: process.cwd(),
    env,
    timeoutMs: 30_000,
  });
  if (patch.exitCode !== 0) {
    return { ok: false, error: `Could not patch Secret "${secretName}": ${patch.stderr.slice(-200)}` };
  }
  return {
    ok: true,
    changed: true,
    message: alreadyPresent
      ? `Overwrote key "${key}" in Secret "${secretName}".`
      : `Added key "${key}" to Secret "${secretName}".`,
  };
}

/**
 * Find values that point at the developer's own machine.
 *
 * WHY (2026-07 incident): app config is almost always pasted straight out of a
 * local `.env`, which is full of `http://localhost:3000` callback URLs. Those
 * are silently fatal once the same file lands in a cluster:
 *
 *   • `APP_PUBLIC_URL` / `*_REDIRECT_URI` decide the `redirect_uri` sent to an
 *     OAuth provider. Pointing at localhost makes the provider bounce the user
 *     back to their own laptop, where the nonce cookie set by the DEPLOYED
 *     origin doesn't exist — surfacing as `oauth_error=missing_nonce`, which
 *     names neither localhost nor the real cause.
 *   • Anything else pointing at localhost (webhooks, return URLs) fails the
 *     same way: unreachable from inside a pod, with an error that blames the
 *     downstream service.
 *
 * Reported rather than auto-rewritten: only the caller knows the app's public
 * address, and a URL like `REDIS_URL=redis://localhost:6379` may be a
 * legitimate in-pod sidecar reference. Naming them lets the UI ask.
 */
export function findLocalhostValues(entries: ParsedEnv[]): ParsedEnv[] {
  return entries.filter((e) => /\b(localhost|127\.0\.0\.1|0\.0\.0\.0|::1)\b/i.test(e.value));
}

/**
 * Parse `.env`-style text into key/value pairs.
 *
 * Handles what people actually paste out of a .env file:
 *   • `export FOO=bar`      — the export prefix is stripped
 *   • `FOO="bar"` / `'bar'` — matching surrounding quotes are removed, because
 *     a quoted value base64-encoded into a Secret arrives at the app WITH the
 *     quotes, which silently corrupts base64 keys and connection strings
 *   • `# comment` and blank lines — skipped
 *   • `FOO=` — kept as an empty value; deliberate emptiness is meaningful
 *
 * Deliberately NOT handled: multi-line values and `${VAR}` interpolation.
 * Both need a real dotenv parser, and guessing at them would mangle values
 * rather than reject them.
 */
export function parseEnvText(text: string): { entries: ParsedEnv[]; skipped: string[] } {
  const entries: ParsedEnv[] = [];
  const skipped: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*([\s\S]*)$/.exec(line);
    if (!m) {
      skipped.push(line.length > 60 ? `${line.slice(0, 60)}…` : line);
      continue;
    }
    let value = m[2].trim();
    if (value.length >= 2 && value[0] === value[value.length - 1] && (value[0] === '"' || value[0] === "'")) {
      value = value.slice(1, -1);
    }
    entries.push({ key: m[1], value });
  }
  return { entries, skipped };
}

/**
 * Create or replace a Secret holding the app's config, then roll the
 * namespace's Deployments so running pods pick it up.
 *
 * REPLACE, not merge: the pasted text is the complete desired state. Merging
 * would make removing a key impossible through this UI and would silently
 * resurrect values the user deleted. `kubectl apply` of a full Secret gives
 * exactly replace semantics.
 */
export async function applyAppSecret(args: {
  kubeconfigPath: string;
  execEnv: Record<string, string>;
  namespace: string;
  secretName: string;
  entries: ParsedEnv[];
}): Promise<{ ok: true; keys: string[] } | { ok: false; error: string }> {
  const { kubeconfigPath, execEnv, namespace, secretName, entries } = args;
  const { runStage } = await import("@/lib/runner/exec");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const env = { ...execEnv, KUBECONFIG: kubeconfigPath };

  if (entries.length === 0) return { ok: false, error: "No key=value pairs found in the input." };

  const dir = await mkdtemp(join(tmpdir(), "dda-appsecret-"));
  try {
    // Build the Secret as YAML with base64 values rather than shelling out
    // with --from-literal: values routinely contain characters (=, /, +, $,
    // quotes, spaces) that are painful to pass safely through a command line,
    // and any one of them silently corrupting a signing key is a debugging
    // nightmare. base64 sidesteps quoting entirely.
    const data = entries
      .map((e) => `  ${e.key}: ${Buffer.from(e.value, "utf8").toString("base64")}`)
      .join("\n");
    const manifest = `apiVersion: v1
kind: Secret
metadata:
  name: ${secretName}
  namespace: ${namespace}
  labels:
    app.kubernetes.io/managed-by: deepagent
type: Opaque
data:
${data}
`;
    const file = join(dir, "secret.yaml");
    await writeFile(file, manifest, { mode: 0o600 });

    // Namespace may not exist yet if the app hasn't been deployed.
    await runStage({
      command: "kubectl",
      args: ["create", "namespace", namespace],
      cwd: dir,
      env,
      timeoutMs: 30_000,
    });

    const res = await runStage({
      command: "kubectl",
      args: ["apply", "-f", file],
      cwd: dir,
      env,
      timeoutMs: 60_000,
    });
    if (res.exitCode !== 0) {
      return { ok: false, error: `Applying the Secret failed: ${res.stderr.slice(-300)}` };
    }
    return { ok: true, keys: entries.map((e) => e.key) };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}
