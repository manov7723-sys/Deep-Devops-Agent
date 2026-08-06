import { prisma } from "@/lib/db/prisma";
import { getKubeconfigForEnv, kubeExecEnv } from "@/lib/runner/creds";
import { runStage } from "@/lib/runner/exec";
import type { Tool } from "./types";

/**
 * Show the application env for a Kubernetes namespace as a set of readable
 * `.env` FILES — one per ConfigMap, one per Secret, and one per workload
 * container holding that container's fully-resolved env.
 *
 * The .env shape is deliberate: users asked "show me the env like VS Code
 * shows a .env file". A grouped table of ConfigMaps/Secrets/workloads was
 * accurate but nobody could read it. `KEY=value` lines with `#` comments for
 * provenance is the format every developer already knows.
 *
 * Secret VALUES are never returned — only keys and a byte count. Unlike
 * inspect_pod_env (one deployment, opt-in reveal), this dumps a whole
 * namespace, so a reveal flag would leak every credential the app touches.
 *
 * Container files resolve `envFrom` imports against the ConfigMaps/Secrets in
 * the same namespace and list them in Kubernetes precedence order (envFrom
 * sources in declaration order, then inline `env`, which wins).
 */

type Input = {
  envKey: string;
  namespace: string;
  /** Optional case-insensitive substring filter on the .env file names. */
  nameFilter?: string;
  /**
   * Decode Secret values instead of masking them.
   *
   * DELIBERATELY ABSENT FROM `inputSchema` — Anthropic validates tool input
   * against that schema with `additionalProperties: false`, so the agent
   * CANNOT set this no matter what it decides. Only server-side callers that
   * invoke `execute()` directly (the Env viewer route, which role-gates and
   * audits the request) can pass it. An LLM pasting a namespace's worth of
   * credentials into a chat transcript is not a risk worth taking for
   * convenience.
   */
  revealSecrets?: boolean;
};

/** One rendered `.env` document, ready to drop into a syntax-highlighted pane. */
type EnvFile = {
  /** Stable id for UI selection, e.g. "secret/app-env". */
  id: string;
  /** File name shown in the picker, e.g. "app-env.env". */
  name: string;
  /** Where it came from, e.g. "Secret · Opaque" or "Deployment deep-agent-backend". */
  origin: string;
  kind: "ConfigMap" | "Secret" | "Container";
  keyCount: number;
  /** The full `.env` text, including `#` provenance comments. */
  content: string;
};

type Output = {
  namespace: string;
  envKey: string;
  files: EnvFile[];
  counts: { configMaps: number; secrets: number; containers: number };
  markdown: string;
  message: string;
};

const WORKLOAD_KINDS = ["deployments", "statefulsets", "daemonsets", "cronjobs", "jobs"] as const;

/** Values longer than this are cut in the .env body — certs and CA bundles are
 *  otherwise thousands of characters and drown every other key. */
const MAX_VALUE_CHARS = 220;

export const showNamespaceEnvTool: Tool<Input, Output> = {
  name: "show_namespace_env",
  description:
    "Show the application env for a Kubernetes namespace as readable .env FILES: one per ConfigMap, one per Secret (values ALWAYS masked as ***, no reveal option), and one per workload container with its fully-resolved env (envFrom imports expanded + inline env, in Kubernetes precedence order, each line commented with where it came from). Use this whenever the user asks 'what env does my app use / show the env for namespace X / show me the .env / what config is my app reading'. Do NOT use inspect_pod_env for this — that one is for one pod's runtime env with an opt-in reveal; this is the safe namespace-wide view. Both `envKey` and `namespace` are required — if the user hasn't named a namespace, call list_kubernetes_resources(envKey, kind:'namespaces') first and offer choices via an options-form. The `markdown` field is ready to paste verbatim into chat.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: { type: "string", description: "Project env whose cluster the namespace lives on." },
      namespace: { type: "string", description: "Kubernetes namespace to enumerate." },
      nameFilter: {
        type: "string",
        description:
          "Case-insensitive substring; only include .env files whose name contains this. Empty/omitted → everything in the namespace. Note: envFrom references still resolve against ALL ConfigMaps/Secrets, so a filtered container file stays complete.",
      },
    },
    required: ["envKey", "namespace"],
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
      const kubectl = (args: string[]) =>
        runStage({
          command: "kubectl",
          args: ["--kubeconfig", kcfg.handle.path, ...args],
          cwd: process.cwd(),
          env: execEnv,
          timeoutMs: 30_000,
          maxBufferBytes: 8 * 1024 * 1024,
        });

      const kinds = ["configmaps", "secrets", ...WORKLOAD_KINDS].join(",");
      let res = await kubectl(["get", kinds, "-n", input.namespace, "-o", "json"]);

      // AAD RBAC self-heal — identical shape to list-kubernetes-resources.ts.
      // Idempotent grant → wait 30s for ARM propagation → retry once. Users who
      // just connected an AKS cluster shouldn't be blocked on a manual role
      // assignment for a read-only call.
      const aadRbacMissing =
        res.exitCode !== 0 &&
        /does not have access to the resource in Azure/i.test(res.stderr) &&
        !!env.cloudProviderId;
      if (aadRbacMissing) {
        try {
          const { grantAksAccessTool } = await import("./grant-aks-access");
          const failingOid = res.stderr.match(
            /User\s+"?([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})"?/i,
          )?.[1];
          const grant = await grantAksAccessTool.execute(
            failingOid
              ? { envKey: input.envKey, principalObjectId: failingOid }
              : { envKey: input.envKey },
            ctx,
          );
          if (grant.ok && !grant.output.candidates) {
            await new Promise((r) => setTimeout(r, 30_000));
            res = await kubectl(["get", kinds, "-n", input.namespace, "-o", "json"]);
          }
        } catch {
          // Fall through — original error surfaces below.
        }
      }

      if (res.exitCode !== 0) {
        return {
          ok: false,
          error: `kubectl get ${kinds} -n ${input.namespace} failed: ${res.stderr.slice(-500)}`,
        };
      }

      let parsed: { items?: Array<Record<string, unknown>> };
      try {
        parsed = JSON.parse(res.stdout) as { items?: Array<Record<string, unknown>> };
      } catch {
        return { ok: false, error: "kubectl returned non-JSON output." };
      }

      // ── Pass 1: index EVERY ConfigMap/Secret, unfiltered. envFrom lookups
      //    must resolve even when the user filtered the file list down to one
      //    workload — otherwise a filtered container file would be missing the
      //    very keys the user is looking for.
      const configMaps = new Map<string, { data: Record<string, string> }>();
      const secrets = new Map<string, { type: string; data: Record<string, string> }>();
      const workloads: Array<{ kind: string; name: string; podSpec: Record<string, unknown> }> = [];

      for (const item of parsed.items ?? []) {
        const kind = String(item.kind ?? "");
        const name = ((item.metadata ?? {}) as { name?: string }).name ?? "(unknown)";

        if (kind === "ConfigMap") {
          configMaps.set(name, { data: (item.data ?? {}) as Record<string, string> });
        } else if (kind === "Secret") {
          const type = String(item.type ?? "Opaque");
          // Service-account tokens are infra noise, never app config.
          if (type === "kubernetes.io/service-account-token") continue;
          secrets.set(name, { type, data: (item.data ?? {}) as Record<string, string> });
        } else if (kind === "CronJob") {
          const podSpec =
            (item.spec as { jobTemplate?: { spec?: { template?: { spec?: unknown } } } })?.jobTemplate
              ?.spec?.template?.spec ?? {};
          workloads.push({ kind, name, podSpec: podSpec as Record<string, unknown> });
        } else if (["Deployment", "StatefulSet", "DaemonSet", "Job"].includes(kind)) {
          const podSpec =
            (item.spec as { template?: { spec?: unknown } })?.template?.spec ?? {};
          workloads.push({ kind, name, podSpec: podSpec as Record<string, unknown> });
        }
      }

      // ── Pass 2: render one .env file per source.
      const files: EnvFile[] = [];

      const reveal = input.revealSecrets === true;
      for (const [name, cm] of configMaps) {
        files.push(renderConfigMapFile(name, cm.data, input.namespace));
      }
      for (const [name, sec] of secrets) {
        files.push(renderSecretFile(name, sec.type, sec.data, input.namespace, reveal));
      }
      for (const w of workloads) {
        const refs = { configMaps, secrets, namespace: input.namespace, reveal };
        const main = (w.podSpec.containers as Array<Record<string, unknown>> | undefined) ?? [];
        // initContainers carry env too (migrations, config bootstrappers), and
        // a var "missing" from the app container is often sitting on one of
        // these. Cheap to include, and leaving them out makes the view lie.
        const init = (w.podSpec.initContainers as Array<Record<string, unknown>> | undefined) ?? [];
        for (const c of main) files.push(renderContainerFile(w, c, refs));
        for (const c of init) files.push(renderContainerFile(w, c, refs, true));
      }

      // ── Pass 3: apply the display filter (resolution above already used the
      //    complete picture, so filtered container files stay accurate).
      const filter = input.nameFilter?.trim().toLowerCase() ?? "";
      const shown = filter ? files.filter((f) => f.name.toLowerCase().includes(filter)) : files;

      const counts = {
        configMaps: shown.filter((f) => f.kind === "ConfigMap").length,
        secrets: shown.filter((f) => f.kind === "Secret").length,
        containers: shown.filter((f) => f.kind === "Container").length,
      };

      const message =
        shown.length === 0
          ? `No ConfigMaps, Secrets, or workload containers in "${input.namespace}"${filter ? ` matching "${input.nameFilter}"` : ""}.`
          : `${shown.length} .env file(s) in "${input.namespace}" — ${counts.containers} container, ${counts.configMaps} ConfigMap, ${counts.secrets} Secret${filter ? ` (filtered by "${input.nameFilter}")` : ""}. ${
              reveal
                ? "Secret values are REVEALED — treat this response as credential material."
                : "Secret values are masked."
            }`;

      return {
        ok: true,
        output: {
          namespace: input.namespace,
          envKey: input.envKey,
          files: shown,
          counts,
          markdown: renderMarkdown(input.namespace, shown, filter),
          message,
        },
      };
    } finally {
      await kcfg.handle.cleanup().catch(() => {});
    }
  },
};

// ── .env rendering ────────────────────────────────────────────────────────

function renderConfigMapFile(
  name: string,
  data: Record<string, string>,
  namespace: string,
): EnvFile {
  const keys = Object.keys(data);
  const lines = [
    `# ConfigMap · ${name}`,
    `# namespace ${namespace} · ${keys.length} key(s)`,
    "",
    ...(keys.length === 0
      ? ["# (no data keys)"]
      : keys.map((k) => `${k}=${dotenvValue(data[k] ?? "")}`)),
  ];
  return {
    id: `configmap/${name}`,
    name: `${name}.env`,
    origin: "ConfigMap",
    kind: "ConfigMap",
    keyCount: keys.length,
    content: lines.join("\n"),
  };
}

function renderSecretFile(
  name: string,
  type: string,
  data: Record<string, string>,
  namespace: string,
  reveal = false,
): EnvFile {
  const keys = Object.keys(data);
  const lines = [
    `# Secret · ${name} (${type})`,
    `# namespace ${namespace} · ${keys.length} key(s)`,
    reveal
      ? "# Values REVEALED — treat this output as credential material."
      : "# Values are MASKED — secret contents are never read into this view.",
    "",
    ...(keys.length === 0
      ? ["# (no data keys)"]
      : keys.map((k) => secretLine(k, data[k] ?? "", reveal))),
  ];
  return {
    id: `secret/${name}`,
    name: `${name}.env`,
    origin: `Secret · ${type}`,
    kind: "Secret",
    keyCount: keys.length,
    content: lines.join("\n"),
  };
}

function renderContainerFile(
  workload: { kind: string; name: string },
  container: Record<string, unknown>,
  refs: {
    configMaps: Map<string, { data: Record<string, string> }>;
    secrets: Map<string, { type: string; data: Record<string, string> }>;
    namespace: string;
    reveal?: boolean;
  },
  isInit = false,
): EnvFile {
  const reveal = refs.reveal === true;
  const cName = String(container.name ?? "(unnamed)");
  const label = isInit ? "Init container" : "Container";
  const envFrom = (container.envFrom as Array<Record<string, unknown>> | undefined) ?? [];
  const inline = (container.env as Array<Record<string, unknown>> | undefined) ?? [];

  const lines: string[] = [
    `# ${label} · ${cName}`,
    `# ${workload.kind} ${workload.name} · namespace ${refs.namespace}`,
    "# Resolved env: envFrom imports in order, then inline env (which wins).",
    reveal
      ? "# Secret values REVEALED — treat this output as credential material."
      : "# Secret values are MASKED.",
  ];
  let keyCount = 0;

  for (const src of envFrom) {
    const cmRef = src.configMapRef as { name?: string; optional?: boolean } | undefined;
    const secRef = src.secretRef as { name?: string; optional?: boolean } | undefined;
    const refName = cmRef?.name ?? secRef?.name ?? "?";
    const isSecret = !!secRef;
    const optional = (cmRef ?? secRef)?.optional ? " (optional)" : "";

    lines.push("", `# ── envFrom · ${isSecret ? "Secret" : "ConfigMap"}/${refName}${optional}`);

    if (isSecret) {
      const found = refs.secrets.get(refName);
      if (!found) {
        lines.push(`# !! Secret "${refName}" not found in this namespace`);
        continue;
      }
      const keys = Object.keys(found.data);
      if (keys.length === 0) lines.push("# (no keys)");
      for (const k of keys) {
        lines.push(secretLine(k, found.data[k] ?? "", reveal));
        keyCount++;
      }
    } else {
      const found = refs.configMaps.get(refName);
      if (!found) {
        lines.push(`# !! ConfigMap "${refName}" not found in this namespace`);
        continue;
      }
      const keys = Object.keys(found.data);
      if (keys.length === 0) lines.push("# (no keys)");
      for (const k of keys) {
        lines.push(`${k}=${dotenvValue(found.data[k] ?? "")}`);
        keyCount++;
      }
    }
  }

  if (inline.length > 0) {
    lines.push("", "# ── inline env (overrides envFrom above)");
    for (const e of inline) {
      const key = String(e.name ?? "");
      const valueFrom = e.valueFrom as Record<string, unknown> | undefined;

      if (typeof e.value === "string") {
        lines.push(`${key}=${dotenvValue(e.value)}`);
      } else if (valueFrom?.secretKeyRef) {
        const r = valueFrom.secretKeyRef as { name?: string; key?: string };
        const raw = refs.secrets.get(r.name ?? "")?.data[r.key ?? ""];
        const src = `# ← Secret/${r.name ?? "?"}.${r.key ?? "?"}`;
        lines.push(
          reveal && raw !== undefined
            ? `${key}=${dotenvValue(Buffer.from(raw, "base64").toString("utf8"))}   ${src}`
            : `${key}=***   ${src}`,
        );
      } else if (valueFrom?.configMapKeyRef) {
        const r = valueFrom.configMapKeyRef as { name?: string; key?: string };
        const resolved = refs.configMaps.get(r.name ?? "")?.data[r.key ?? ""];
        lines.push(
          resolved !== undefined
            ? `${key}=${dotenvValue(resolved)}   # ← ConfigMap/${r.name}.${r.key}`
            : `${key}=   # ← ConfigMap/${r.name ?? "?"}.${r.key ?? "?"} (not found)`,
        );
      } else if (valueFrom?.fieldRef) {
        const r = valueFrom.fieldRef as { fieldPath?: string };
        lines.push(`${key}=   # ← pod field ${r.fieldPath ?? "?"} (set at runtime)`);
      } else if (valueFrom?.resourceFieldRef) {
        const r = valueFrom.resourceFieldRef as { resource?: string };
        lines.push(`${key}=   # ← resource ${r.resource ?? "?"} (set at runtime)`);
      } else {
        lines.push(`${key}=`);
      }
      keyCount++;
    }
  }

  if (envFrom.length === 0 && inline.length === 0) {
    lines.push("", "# (no env declared on this container)");
  }

  return {
    id: `container/${workload.name}/${isInit ? "init/" : ""}${cName}`,
    name: `${cName}.env`,
    origin: `${workload.kind} ${workload.name}${isInit ? " · init" : ""}`,
    kind: "Container",
    keyCount,
    content: lines.join("\n"),
  };
}

/**
 * Format a value as a single .env line value. Multi-line / whitespace-padded /
 * comment-containing values get quoted and escaped so the file still reads as
 * valid dotenv; very long values (certs, CA bundles) are truncated with a note
 * so one key can't drown the rest of the file.
 */
function dotenvValue(raw: string): string {
  if (raw === "") return "";
  let v = raw;
  let truncated = false;
  if (v.length > MAX_VALUE_CHARS) {
    v = v.slice(0, MAX_VALUE_CHARS);
    truncated = true;
  }
  const needsQuote = /[\n\r"#]/.test(v) || /^\s|\s$/.test(v);
  if (needsQuote) {
    v = `"${v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\r/g, "\\r").replace(/\n/g, "\\n")}"`;
  }
  return truncated ? `${v}   # …truncated, ${raw.length} chars total` : v;
}

/**
 * One `KEY=value` line for a Secret entry. Masked mode shows a byte count so
 * the reader can still tell an empty value from a populated one; revealed mode
 * decodes the base64 and formats it like any other .env value.
 */
function secretLine(key: string, b64: string, reveal: boolean): string {
  if (!reveal) return `${key}=***   # ${base64ByteLength(b64)} bytes`;
  return `${key}=${dotenvValue(Buffer.from(b64, "base64").toString("utf8"))}`;
}

function base64ByteLength(b64: string): number {
  // Cheap decode-length: 3/4 of the base64 length minus padding. Enough for a
  // size hint; the secret material itself is never decoded.
  if (!b64) return 0;
  const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0;
  return Math.max(0, Math.floor((b64.length * 3) / 4) - padding);
}

/** Chat-surface rendering: each .env file as a fenced `ini` block so the
 *  markdown renderer syntax-highlights it exactly like the UI pane does. */
function renderMarkdown(namespace: string, files: EnvFile[], filter: string): string {
  const out: string[] = [`### Env files · namespace \`${namespace}\``];
  if (filter) out.push(`_Filter: \`${filter}\`_`);
  if (files.length === 0) {
    out.push("", "_Nothing found._");
    return out.join("\n");
  }
  for (const f of files) {
    out.push("", `**${f.name}** — ${f.origin} · ${f.keyCount} key(s)`, "", "```ini", f.content, "```");
  }
  return out.join("\n");
}
