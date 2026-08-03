/**
 * Pre-deploy repo intelligence for `deploy_my_app`.
 *
 * WHY THIS EXISTS (2026-08 incident + Plan-B follow-up):
 * The current deploy pipeline uses vetted templates that are correct by
 * construction — but "correct" alone isn't enough when the repo already has
 * hand-scaffolded k8s files that silently shadow the fresh template output,
 * when the app exposes a real `/api/health` endpoint but we're probing on
 * TCP, or when the user wants per-service overrides without editing the
 * agent. This module adds three focused pre-flight passes:
 *
 *   1. listStaleManifestFiles — enumerates *.yaml files in a service's
 *      manifest directory that are NOT `manifest.yaml`. These are the exact
 *      files that cause "kubectl apply -f dir/" to silently override a
 *      freshly-generated ClusterIP+ALB manifest with an older LoadBalancer+
 *      NLB one (the 2026-08 root cause).
 *
 *   2. detectHealthProbePath — reads the service's source for common health
 *      endpoints (/health, /healthz, /api/health, /_livez, /actuator/health)
 *      based on the detected stack, so the generated manifest can use an
 *      HTTP readinessProbe instead of the coarse tcpSocket default. Prevents
 *      "pod is Ready but the app isn't actually serving" false positives.
 *
 *   3. readDeepAgentConfig — parses an optional `deepagent.yaml` at the repo
 *      root that lets a user override per-service defaults (probePath, extra
 *      env vars, resource requests). Extension slot — templates stay
 *      deterministic; the user pins the deltas.
 *
 * All three are best-effort: any failure returns a sensible neutral default,
 * never throws. Callers gate on the presence of a returned value.
 */
import type { DockerStackId } from "@/lib/ci/templates";
import { prisma } from "@/lib/db/prisma";
import { resolveRepoClient, type GitRepoClient } from "@/lib/git";

// ── Small helper: get an authed git client + default branch for the repo ──
async function repoForProject(
  projectId: string,
  fullName: string,
): Promise<{ ok: true; ref: string; client: GitRepoClient } | { ok: false; error: string }> {
  const repo = await prisma.repo.findFirst({
    where: {
      fullName,
      deletedAt: null,
      projectRepos: { some: { projectId } },
    },
    select: { id: true, defaultBranch: true },
  });
  if (!repo) return { ok: false, error: `Repo "${fullName}" not attached to this project.` };
  const resolved = await resolveRepoClient(repo.id);
  if (!resolved.ok) return { ok: false, error: resolved.message };
  return { ok: true, ref: repo.defaultBranch, client: resolved.client };
}

// ─────────────────────────────────────────────────────────────────────────────
// 1. Stale manifest-file scan
// ─────────────────────────────────────────────────────────────────────────────
export type StaleScan = {
  /** repo-relative paths, e.g. ["k8s/dev/backend/deployment.yaml", ...] */
  stalePaths: string[];
  hasFreshManifest: boolean;
};

/**
 * List *.yaml / *.yml files under `manifestDir` that aren't `manifest.yaml`.
 * These are what shadow the freshly-generated single-doc manifest when the
 * CD workflow does `kubectl apply -f <dir>/` (alphabetical sort means the
 * older `service.yaml` wins over `manifest.yaml`). Deleting them in the same
 * commit that writes the fresh manifest is what makes the deploy clean.
 */
export async function listStaleManifestFiles(
  projectId: string,
  fullName: string,
  manifestDir: string,
): Promise<StaleScan> {
  const empty: StaleScan = { stalePaths: [], hasFreshManifest: false };
  const r = await repoForProject(projectId, fullName);
  if (!r.ok) return empty;

  const dir = manifestDir.replace(/^\/+|\/+$/g, "");
  try {
    const entries = await r.client.listFiles(dir, r.ref);
    let hasFreshManifest = false;
    const stale: string[] = [];
    for (const e of entries) {
      if (e.type !== "file") continue;
      const name = e.name.toLowerCase();
      if (!name.endsWith(".yaml") && !name.endsWith(".yml")) continue;
      if (name === "manifest.yaml" || name === "manifest.yml") {
        hasFreshManifest = true;
        continue;
      }
      // Preserve anything the user has clearly hand-tuned via a kustomization
      // — kustomize.yaml/kustomization.yaml is a config file, not a resource
      // manifest, so deleting it would break their setup. Same for helm chart
      // pieces that leaked into k8s/ by mistake.
      if (name === "kustomization.yaml" || name === "kustomization.yml") continue;
      stale.push(e.path);
    }
    return { stalePaths: stale, hasFreshManifest };
  } catch {
    return empty;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 2. Health-probe detection
// ─────────────────────────────────────────────────────────────────────────────
export type ProbeDetection = {
  /** e.g. "/api/health". null when no confident match was found. */
  probePath: string | null;
  /** Repo-relative file the path was extracted from — for the [analyzed] note. */
  sourceFile: string | null;
  /** Which detection heuristic matched (for the note). */
  hint: string | null;
};

/**
 * Look for a health-check endpoint the app actually serves and return its
 * path. Two-tier match, with the FIRST successful tier winning:
 *
 *   Tier 1 — filename convention (fast, no file reads):
 *     Next.js  pages router:   pages/api/health*.{ts,tsx,js}       → /api/health
 *     Next.js  app router:     app/api/health/route.{ts,js}        → /api/health
 *                              (also .../healthz/route.{ts,js})
 *     Node/Express, generic:   src/routes/health.{ts,js}           → /health
 *
 *   Tier 2 — content regex against likely files (bounded to <=10 files):
 *     grep the framework's typical route registration for a literal path
 *     like "/health", "/healthz", "/api/health", "/_livez", or
 *     "/actuator/health". First hit wins.
 *
 * Returns null when nothing matches — the caller falls back to tcpSocket.
 */
export async function detectHealthProbePath(args: {
  projectId: string;
  fullName: string;
  servicePath: string;
  stack: DockerStackId;
}): Promise<ProbeDetection> {
  const empty: ProbeDetection = { probePath: null, sourceFile: null, hint: null };
  const r = await repoForProject(args.projectId, args.fullName);
  if (!r.ok) return empty;

  const base = args.servicePath.replace(/^\/+|\/+$/g, "");
  const inSvc = (p: string) => (base ? `${base}/${p}` : p);

  // Tier 1 — filename conventions
  if (args.stack === "node-service") {
    // Next.js pages router: pages/api/health.{ts,tsx,js}
    for (const pfx of ["pages/api", "src/pages/api"]) {
      const dir = inSvc(pfx);
      const entries = await safeList(r.client, dir, r.ref);
      const hit = entries.find(
        (e) => e.type === "file" && /^health(z)?\.(t|j)sx?$/i.test(e.name),
      );
      if (hit) {
        return {
          probePath: /healthz/i.test(hit.name) ? "/api/healthz" : "/api/health",
          sourceFile: hit.path,
          hint: `Found Next.js pages-router health route at ${hit.path}`,
        };
      }
    }
    // Next.js app router: app/api/health/route.{ts,js}
    for (const pfx of ["app/api", "src/app/api"]) {
      const healthDirs = ["health", "healthz"];
      for (const hd of healthDirs) {
        const routeDir = inSvc(`${pfx}/${hd}`);
        const entries = await safeList(r.client, routeDir, r.ref);
        const hit = entries.find(
          (e) => e.type === "file" && /^route\.(t|j)sx?$/i.test(e.name),
        );
        if (hit) {
          return {
            probePath: `/api/${hd}`,
            sourceFile: hit.path,
            hint: `Found Next.js app-router health route at ${hit.path}`,
          };
        }
      }
    }
  }

  // Tier 2 — content-grep the framework's likely entry files
  const candidates = candidateEntryFiles(args.stack, base);
  for (const path of candidates) {
    const body = await safeRead(r.client, path, r.ref);
    if (!body) continue;
    // Look for common route declarations. Ordered longest-first so
    // "/api/health" wins over "/health" when both appear in a file.
    const PATTERNS: Array<{ path: string; re: RegExp }> = [
      { path: "/api/healthz", re: /["'`]\/api\/healthz["'`]/ },
      { path: "/api/health", re: /["'`]\/api\/health["'`]/ },
      { path: "/actuator/health", re: /["'`]\/actuator\/health["'`]/ },
      { path: "/_livez", re: /["'`]\/_livez["'`]/ },
      { path: "/healthz", re: /["'`]\/healthz["'`]/ },
      { path: "/health", re: /["'`]\/health["'`]/ },
    ];
    for (const { path: hp, re } of PATTERNS) {
      if (re.test(body)) {
        return {
          probePath: hp,
          sourceFile: path,
          hint: `Matched "${hp}" literal in ${path}`,
        };
      }
    }
  }

  return empty;
}

function candidateEntryFiles(stack: DockerStackId, base: string): string[] {
  const rel = (p: string) => (base ? `${base}/${p}` : p);
  switch (stack) {
    case "node-service":
      return [
        rel("src/index.ts"),
        rel("src/index.js"),
        rel("src/app.ts"),
        rel("src/app.js"),
        rel("src/server.ts"),
        rel("src/server.js"),
        rel("index.ts"),
        rel("index.js"),
        rel("app.ts"),
        rel("app.js"),
        rel("server.ts"),
        rel("server.js"),
      ];
    case "python":
      return [
        rel("main.py"),
        rel("app.py"),
        rel("src/main.py"),
        rel("src/app.py"),
        rel("app/main.py"),
      ];
    case "go":
      return [rel("main.go"), rel("cmd/server/main.go"), rel("cmd/main.go")];
    default:
      return [];
  }
}

async function safeList(
  client: GitRepoClient,
  path: string,
  ref: string,
): Promise<{ path: string; name: string; type: "file" | "dir" }[]> {
  try {
    return await client.listFiles(path, ref);
  } catch {
    return [];
  }
}

async function safeRead(
  client: GitRepoClient,
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    return await client.readFile(path, ref);
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 3. deepagent.yaml — user extension slots
// ─────────────────────────────────────────────────────────────────────────────
export type DeepAgentServiceOverrides = {
  /** HTTP path for readiness/liveness probes (e.g. "/api/custom-health"). */
  probePath?: string;
  /** Container port override — overrides the framework default. */
  containerPort?: number;
  /** Extra env vars for the Deployment. Prefer secrets for sensitive values. */
  env?: Record<string, string>;
  /** K8s resource requests. */
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
};

export type DeepAgentConfig = {
  /** Config schema version. Only "1" is currently understood. */
  version?: number;
  /** Per-service overrides keyed by service name (frontend, backend, or the app name). */
  services?: Record<string, DeepAgentServiceOverrides>;
};

export type DeepAgentConfigResult = {
  present: boolean;
  config?: DeepAgentConfig;
  /** Warnings emitted during parse (e.g. unknown fields, bad shapes). */
  warnings: string[];
};

/**
 * Read `deepagent.yaml` (or .yml) at the repo root if present. YAML parsing is
 * done via `js-yaml` if it's installable — otherwise falls back to a minimal
 * parser that handles the tiny subset this file uses (mappings of scalars +
 * nested mappings). No wildcard, no lists needed for the overrides schema.
 *
 * Returns { present: false } cleanly when the file doesn't exist — the caller
 * treats "no file" the same as "no overrides".
 */
export async function readDeepAgentConfig(
  projectId: string,
  fullName: string,
): Promise<DeepAgentConfigResult> {
  const empty: DeepAgentConfigResult = { present: false, warnings: [] };
  const r = await repoForProject(projectId, fullName);
  if (!r.ok) return empty;

  let raw: string | null = null;
  let sourcePath = "";
  for (const path of ["deepagent.yaml", "deepagent.yml", ".deepagent.yaml", ".deepagent.yml"]) {
    const body = await safeRead(r.client, path, r.ref);
    if (body != null) {
      raw = body;
      sourcePath = path;
      break;
    }
  }
  if (raw == null) return empty;

  const warnings: string[] = [];
  let parsed: unknown;
  try {
    // Minimal YAML parser scoped to the exact shape this file supports:
    // nested mappings + scalar values. No lists, no anchors, no multi-line
    // strings — which is exactly what the deepagent.yaml schema declares. If
    // a user needs more, they can PR a real YAML dependency later; keeping
    // the parser inline avoids adding a runtime dep for a config file most
    // users won't ship.
    parsed = parseMinimalYaml(raw);
  } catch (err) {
    warnings.push(
      `Failed to parse ${sourcePath}: ${err instanceof Error ? err.message : String(err)}. Ignoring the file — deploy will use defaults.`,
    );
    return { present: true, warnings };
  }

  const config = validateConfig(parsed, warnings, sourcePath);
  return { present: true, config, warnings };
}

function validateConfig(
  raw: unknown,
  warnings: string[],
  sourcePath: string,
): DeepAgentConfig {
  const out: DeepAgentConfig = {};
  if (!raw || typeof raw !== "object") {
    warnings.push(`${sourcePath}: root must be a mapping — ignored.`);
    return out;
  }
  const root = raw as Record<string, unknown>;
  if (typeof root.version === "number") out.version = root.version;
  if (root.version !== undefined && root.version !== 1) {
    warnings.push(`${sourcePath}: unknown version ${String(root.version)} — treating as v1.`);
  }
  if (root.services && typeof root.services === "object" && !Array.isArray(root.services)) {
    const services: Record<string, DeepAgentServiceOverrides> = {};
    for (const [name, overridesRaw] of Object.entries(root.services)) {
      if (!overridesRaw || typeof overridesRaw !== "object" || Array.isArray(overridesRaw)) {
        warnings.push(`${sourcePath}: services.${name} must be a mapping — skipped.`);
        continue;
      }
      const o = overridesRaw as Record<string, unknown>;
      const s: DeepAgentServiceOverrides = {};
      if (typeof o.probePath === "string" && o.probePath.startsWith("/")) s.probePath = o.probePath;
      else if (o.probePath !== undefined) {
        warnings.push(`${sourcePath}: services.${name}.probePath must be a string starting with "/" — ignored.`);
      }
      if (typeof o.containerPort === "number" && Number.isInteger(o.containerPort) && o.containerPort > 0) {
        s.containerPort = o.containerPort;
      } else if (o.containerPort !== undefined) {
        warnings.push(`${sourcePath}: services.${name}.containerPort must be a positive integer — ignored.`);
      }
      if (o.env && typeof o.env === "object" && !Array.isArray(o.env)) {
        const env: Record<string, string> = {};
        for (const [k, v] of Object.entries(o.env as Record<string, unknown>)) {
          if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
            env[k] = String(v);
          } else {
            warnings.push(`${sourcePath}: services.${name}.env.${k} must be a scalar — skipped.`);
          }
        }
        if (Object.keys(env).length) s.env = env;
      }
      if (o.resources && typeof o.resources === "object" && !Array.isArray(o.resources)) {
        const rr = o.resources as Record<string, Record<string, unknown> | undefined>;
        const shape = (block?: Record<string, unknown>): { cpu?: string; memory?: string } | undefined => {
          if (!block) return undefined;
          const out: { cpu?: string; memory?: string } = {};
          if (typeof block.cpu === "string") out.cpu = block.cpu;
          if (typeof block.memory === "string") out.memory = block.memory;
          return out.cpu || out.memory ? out : undefined;
        };
        const requests = shape(rr.requests);
        const limits = shape(rr.limits);
        if (requests || limits) s.resources = { ...(requests ? { requests } : {}), ...(limits ? { limits } : {}) };
      }
      services[name] = s;
    }
    if (Object.keys(services).length) out.services = services;
  }
  return out;
}

/**
 * Minimal YAML parser — supports ONLY the flat/nested-mapping subset this
 * file needs (no lists, no anchors, no multi-line scalars). Used when
 * js-yaml isn't available in the runtime. Not a general-purpose parser —
 * a deepagent.yaml that exceeds this shape should install js-yaml.
 */
function parseMinimalYaml(raw: string): unknown {
  const lines = raw.split("\n");
  type Frame = { indent: number; obj: Record<string, unknown> };
  const root: Record<string, unknown> = {};
  const stack: Frame[] = [{ indent: -1, obj: root }];
  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, "").replace(/\r$/, "");
    if (!line.trim()) continue;
    const indent = line.match(/^(\s*)/)![1].length;
    while (stack.length > 1 && indent <= stack[stack.length - 1].indent) stack.pop();
    const parent = stack[stack.length - 1];
    const trimmed = line.trim();
    const m = trimmed.match(/^([^:]+):\s*(.*)$/);
    if (!m) continue;
    const key = m[1].trim();
    const val = m[2].trim();
    if (val === "") {
      const child: Record<string, unknown> = {};
      parent.obj[key] = child;
      stack.push({ indent, obj: child });
    } else {
      let v: unknown = val.replace(/^["']|["']$/g, "");
      if (/^-?\d+$/.test(val)) v = Number(val);
      else if (val === "true" || val === "false") v = val === "true";
      parent.obj[key] = v;
    }
  }
  return root;
}
