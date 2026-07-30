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
