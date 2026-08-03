import { prisma } from "@/lib/db/prisma";
import { getKubeconfigForEnv, kubeExecEnv } from "@/lib/runner/creds";
import { runStage } from "@/lib/runner/exec";
import type { Tool } from "./types";

/**
 * Read a running pod's actual environment variables. The tool the agent
 * reaches for whenever a user asks "what is X env var set to on the
 * deployed pod?" — replaces the whole "please run kubectl exec" back-and-
 * forth that historically forced non-DevOps users to open a terminal.
 *
 * Secret-safe by default: values that look like credentials/URLs with
 * passwords are masked in the response. The caller can pass
 * `revealSecrets: true` to see raw values (e.g. when actively debugging a
 * suspected mismatch), but the flag is documented so an over-eager LLM
 * doesn't paste plaintext DB passwords into chat.
 *
 * Works by executing `env` inside the first container of the first Ready
 * pod matching the deployment's selector. Failure modes reported cleanly:
 * no pods → empty result; pod not Ready → warning; exec disabled → clear
 * error pointing at the RBAC fix.
 */
type Input = {
  envKey: string;
  namespace: string;
  /** Deployment name whose pods to inspect. */
  deployment: string;
  /**
   * Only return env vars whose names match this list (case-sensitive). Empty
   * / omitted → all env vars. Use `["DATABASE_URL","SESSION_COOKIE_SECURE"]`
   * to answer targeted questions without dumping the entire container env.
   */
  keys?: string[];
  /**
   * Reveal secret values verbatim. Defaults to false — passwords/URLs are
   * masked. Only pass `true` when the agent is actively debugging a
   * suspected mismatch and the user explicitly asked for full values.
   */
  revealSecrets?: boolean;
};

type Output = {
  namespace: string;
  deployment: string;
  podName: string;
  ready: boolean;
  env: Array<{ key: string; value: string; masked: boolean; source: "envFrom" | "inline" | "unknown" }>;
  message: string;
};

/**
 * Names that ALWAYS get masked unless `revealSecrets` is set. Extend as new
 * conventional secret names appear.
 */
const SECRET_KEY_PATTERNS: RegExp[] = [
  /PASSWORD/i,
  /SECRET/i,
  /TOKEN/i,
  /_KEY$/i,
  /^SESSION_/i,
  /_URL$/i, // catches DATABASE_URL, REDIS_URL, etc — often carry embedded credentials
  /_DSN$/i,
];

function isSecretKey(key: string): boolean {
  return SECRET_KEY_PATTERNS.some((re) => re.test(key));
}

/**
 * For URL-shaped secrets, keep the scheme+host visible and only mask the
 * user:password portion — the host is diagnostically valuable ("which DB
 * host is the pod pointing at?") and doesn't reveal credentials.
 */
function maskValue(key: string, value: string): string {
  if (/^\s*postgres(?:ql)?:\/\//i.test(value) || /^\s*mysql:\/\//i.test(value) || /^\s*redis:\/\//i.test(value)) {
    return value.replace(/(:\/\/)([^:@\s]+):([^@\s]+)@/, "$1$2:***@");
  }
  if (value.length <= 6) return "***";
  return `${value.slice(0, 2)}***${value.slice(-2)} (${value.length} chars)`;
}

export const inspectPodEnvTool: Tool<Input, Output> = {
  name: "inspect_pod_env",
  description:
    "Read a running pod's actual environment variables — the answer to 'what is DATABASE_URL / SESSION_COOKIE_SECURE / any env var set to on the deployed pod?'. Use this INSTEAD of asking the user to run 'kubectl exec ... env'. Executes `env` inside the first Ready pod of the given deployment; secret-looking keys (PASSWORD, SECRET, TOKEN, *_KEY, *_URL, SESSION_*) are masked in the response unless revealSecrets=true. Pass a `keys` array to filter to just the vars you care about — cheaper AND less risk of surfacing a value that shouldn't be shown. Fails cleanly when no pods exist / exec is RBAC-disabled.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: { type: "string", description: "Env whose cluster the deployment lives on." },
      namespace: { type: "string", description: "Kubernetes namespace." },
      deployment: {
        type: "string",
        description: "Deployment name (e.g. 'deep-devops-agent-frontend'). Inspect the first Ready pod matching this deployment's selector.",
      },
      keys: {
        type: "array",
        items: { type: "string" },
        description:
          "Only return env vars whose names appear in this list. Case-sensitive. Empty / omitted → all env vars (can be dozens; prefer filtering).",
      },
      revealSecrets: {
        type: "boolean",
        description:
          "Return secret values verbatim (default false — passwords and URL-embedded credentials are masked). Only set true when the user explicitly asked to see the raw value AND the diagnostic really needs it.",
      },
    },
    required: ["envKey", "namespace", "deployment"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const env = await prisma.env.findFirst({
      where: { projectId: ctx.projectId, key: input.envKey },
      select: { id: true, cloudProviderId: true },
    });
    if (!env) return { ok: false, error: `Env "${input.envKey}" not found on this project.` };

    const kcfg = await getKubeconfigForEnv(env.id);
    if (!kcfg.ok) {
      return {
        ok: false,
        error: `${kcfg.message} Connect a cluster to env "${input.envKey}" first.`,
      };
    }
    try {
      const execEnv = await kubeExecEnv(kcfg.handle.path, env.cloudProviderId);
      const kubectl = async (args: string[]) =>
        runStage({
          command: "kubectl",
          args: ["--kubeconfig", kcfg.handle.path, ...args],
          cwd: process.cwd(),
          env: execEnv,
          timeoutMs: 30_000,
          maxBufferBytes: 4 * 1024 * 1024,
        });

      // 1 — Find a Ready pod for the deployment.
      const podList = await kubectl([
        "get",
        "pods",
        "-n",
        input.namespace,
        "-l",
        `app.kubernetes.io/name=${input.deployment}`,
        "-o",
        "jsonpath={range .items[*]}{.metadata.name} {.status.phase} {.status.conditions[?(@.type=='Ready')].status}{'\\n'}{end}",
      ]);
      if (podList.exitCode !== 0) {
        return {
          ok: false,
          error: `Could not list pods for deployment "${input.deployment}" in namespace "${input.namespace}": ${podList.stderr.slice(-200)}`,
        };
      }
      const rows = podList.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
          const [name, phase, ready] = l.split(/\s+/);
          return { name, phase, ready };
        });
      if (rows.length === 0) {
        return {
          ok: false,
          error: `No pods found matching deployment "${input.deployment}" in namespace "${input.namespace}". Selector used: app.kubernetes.io/name=${input.deployment}.`,
        };
      }
      const target =
        rows.find((r) => r.ready === "True") ??
        rows.find((r) => r.phase === "Running") ??
        rows[0];

      // 2 — exec env inside the pod. `env` is present in every reasonable
      //     base image (busybox, alpine, debian, distroless-based images
      //     with the shell layer may skip it; try without shell first).
      const envExec = await kubectl([
        "exec",
        "-n",
        input.namespace,
        target.name,
        "--",
        "env",
      ]);
      if (envExec.exitCode !== 0) {
        // Distroless / no shell → fallback via /proc/1/environ (null-separated).
        const procExec = await kubectl([
          "exec",
          "-n",
          input.namespace,
          target.name,
          "--",
          "sh",
          "-c",
          "cat /proc/1/environ | tr '\\0' '\\n'",
        ]);
        if (procExec.exitCode !== 0) {
          return {
            ok: false,
            error:
              `kubectl exec into pod "${target.name}" failed. ` +
              `Most likely: the pod's image is distroless (no shell), OR the CD role lacks pods/exec on this namespace. ` +
              `Original error: ${envExec.stderr.slice(-200)}`,
          };
        }
        envExec.stdout = procExec.stdout;
      }

      // 3 — Parse KEY=VALUE lines; VALUE can contain '=' so split on the FIRST '=' only.
      const parsed: Array<{ key: string; value: string }> = [];
      for (const line of envExec.stdout.split("\n")) {
        const eq = line.indexOf("=");
        if (eq <= 0) continue;
        parsed.push({ key: line.slice(0, eq), value: line.slice(eq + 1) });
      }

      // 4 — Filter to requested keys (if any), mask secrets, tag source.
      //     Source tagging is best-effort: cross-ref against the Deployment's
      //     spec.template.spec.containers[].env to see which keys are declared
      //     INLINE (envFrom-sourced keys aren't listed there).
      const inlineKeys = new Set<string>();
      const depSpec = await kubectl([
        "get",
        "deployment",
        input.deployment,
        "-n",
        input.namespace,
        "-o",
        "jsonpath={.spec.template.spec.containers[0].env[*].name}",
      ]);
      if (depSpec.exitCode === 0) {
        for (const n of depSpec.stdout.split(/\s+/)) if (n) inlineKeys.add(n);
      }

      const wanted = input.keys?.length ? new Set(input.keys) : null;
      const filtered = parsed
        .filter((e) => !wanted || wanted.has(e.key))
        .map((e) => {
          const shouldMask = !input.revealSecrets && isSecretKey(e.key);
          return {
            key: e.key,
            value: shouldMask ? maskValue(e.key, e.value) : e.value,
            masked: shouldMask,
            source: inlineKeys.has(e.key)
              ? ("inline" as const)
              : /^(PATH|HOSTNAME|HOME|TERM|KUBERNETES_|SHLVL|PWD|_)$/i.test(e.key)
                ? ("unknown" as const)
                : ("envFrom" as const),
          };
        });

      return {
        ok: true,
        output: {
          namespace: input.namespace,
          deployment: input.deployment,
          podName: target.name,
          ready: target.ready === "True",
          env: filtered,
          message:
            wanted && filtered.length === 0
              ? `None of the requested keys (${input.keys!.join(", ")}) are set on pod "${target.name}". Neither the Deployment's inline env nor its envFrom Secrets provide them.`
              : `Read ${filtered.length} env var(s) from pod "${target.name}"${wanted ? ` (filtered to: ${input.keys!.join(", ")})` : ""}. ${input.revealSecrets ? "Secret values shown verbatim as requested." : "Secret-looking values are masked; pass revealSecrets=true only when actively debugging."}`,
        },
      };
    } finally {
      await kcfg.handle.cleanup().catch(() => {});
    }
  },
};
