/**
 * Repo Intelligence engine — the analysis step of project creation.
 *
 * Given a GitHub repo (user OAuth token + fullName), reads the tree and a
 * bounded set of key files, then produces a structured report:
 *
 *   • services       — deployable units (stack, path, port)
 *   • readme         — summary of what the docs declare (run cmds, services)
 *   • infraNeeds     — DB/cache/queue/storage/email inferred from dependencies
 *   • envVars        — variables the app reads, secret vs plain
 *   • missingFiles   — scaffolding audit (Dockerfile, CI, .env.example, …)
 *   • recommendations— cluster size, replicas/HPA, requests/limits, DB, exposure
 *
 * Pure functions over fetched bytes — no Prisma, no project required — so it
 * can run DURING the create-project wizard (before the project exists). The
 * caller supplies the token; nothing here stores it.
 *
 * Bounded on purpose: one tree call + ≤ ~20 file fetches. The wizard shows a
 * live progress label; the whole scan targets < 10 s on a normal repo.
 */

const GH = "https://api.github.com";

// ─────────────────────────────────────────────────────────────────
// Report types (shared with the wizard UI + DeploymentPlan storage)
// ─────────────────────────────────────────────────────────────────

export type DetectedService = {
  name: string;
  path: string; // "" for repo root
  stack: string; // "nextjs" | "node" | "python" | "go" | "java" | "static" | "unknown"
  stackTitle: string;
  role: "frontend" | "backend" | "worker" | "unknown";
  port: number | null;
  hasDockerfile: boolean;
  /**
   * Deep-detected runtime facts — one bundle per service. Everything nullable
   * because the source of truth is the manifest/lockfile, and older repos may
   * not pin any of it.
   */
  languageProfile: LanguageProfile;
};

/**
 * Per-service runtime deep-detection — the "what actually is this?" the plain
 * stack label can't answer. Drives concrete decisions later: JVM version
 * changes memory sizing, package manager picks the install command, Python
 * server picks the CMD, and so on.
 */
export type LanguageProfile = {
  language: string; // "JavaScript" | "Python" | "Java" | "Go" | …
  version: string | null; // "3.12", "20", "17", "1.22"
  framework: string | null; // "Next.js" | "FastAPI" | "Django" | "Spring Boot" | …
  server: string | null; // "uvicorn" | "gunicorn" | "next start" | …
  packageManager: string | null; // "npm" | "pnpm" | "yarn" | "bun" | "pip" | "poetry" | "gomod" | "maven"
  buildTool: string | null; // "Next.js build" | "Vite" | "webpack" | "Maven" | "Go build"
};

/** Database-migration tooling and how it runs today. */
export type MigrationInfo = {
  tool: "Prisma" | "Alembic" | "Django" | "Rails" | "Knex" | "TypeORM" | "unknown";
  service: string;
  runsAtStartup: boolean;
  recommendation: string;
};

/**
 * Top-of-report call on whether this app belongs on Kubernetes at all.
 *   ready    — go
 *   warn     — deployable but there are concerns (stateful bits, migrations)
 *   not_fit  — no HTTP surface AND no worker signals (CLI, desktop, library)
 */
export type DeployabilityVerdict = {
  status: "ready" | "warn" | "not_fit";
  title: string;
  reason: string;
  concernCount: number;
};

export type InfraNeed = {
  kind: "postgres" | "mysql" | "mongodb" | "redis" | "queue" | "objectStorage" | "email";
  evidence: string; // "package.json dependency `pg`"
  recommendation: string; // "RDS PostgreSQL — db.t3.micro (dev)"
};

export type EnvVarInfo = {
  name: string;
  secret: boolean;
  source: "code" | "env-example" | "readme";
};

export type MissingFile = {
  id: string; // "dockerfile:frontend" | "env-example" | "readme" | "dockerignore"
  label: string;
  detail: string;
  /** Which service it belongs to, when per-service (Dockerfile). */
  servicePath?: string;
  generatable: boolean;
  /**
   * True → the wizard must NOT proceed until the developer fixes this in the
   * repo (currently only the README: the agent reads it to understand the
   * application before recommending deployment capacity, and writing it is
   * the developer's job — never generated).
   */
  blocking?: boolean;
};

export type Recommendation = {
  id: string;
  area:
    | "cluster"
    | "replicas"
    | "resources"
    | "database"
    | "services"
    | "exposure"
    | "env";
  title: string;
  value: string; // human-readable recommended value
  why: string; // confidence label / evidence
};

/**
 * The in-app agent's judgment of the analysis — it TESTS the application's
 * readiness (README adequacy, deployment capacity) so the user doesn't have
 * to. "skipped" = no model/key configured; heuristics stand alone.
 */
export type AgentReview = {
  verdict: "pass" | "warn" | "skipped";
  notes: string;
};

/**
 * Rough throughput headroom for a stateless HTTP pod at typical resource
 * requests. Kept intentionally conservative — the goal is a defensible
 * starting number the user then adjusts, not a load-test replacement.
 */
export const PER_POD_RPS: Record<string, number> = {
  nextjs: 50,
  react: 200, // static via nginx
  node: 200,
  python: 100,
  go: 500,
  java: 300,
  static: 200,
  unknown: 100,
};

/** Standard usage assumption — one interactive request per 10 s per user. */
export const DEFAULT_REQ_PER_USER_PER_SEC = 0.1;

export type ReplicaPlan = {
  serviceName: string;
  stack: string;
  perPodRps: number;
  minReplicas: number;
  maxReplicas: number;
  usersServedByMax: number;
};

export type ClusterPlan = {
  nodeType: string;
  nodeCount: number;
  maxNodeCount: number;
  /** Rough max concurrent users this cluster + HPA-max replicas can serve. */
  maxConcurrentUsers: number;
};

/**
 * The capacity plan is what the user actually adjusts with the slider:
 * "how many concurrent users should this app serve at peak?" → derived
 * replicas (HPA min/max) and cluster size (nodes + max nodes).
 */
export type CapacityPlan = {
  targetConcurrentUsers: number;
  reqPerUserPerSec: number;
  replicas: ReplicaPlan[];
  cluster: ClusterPlan;
  reasoning: string;
};

/**
 * Compute a capacity plan for a set of detected services from a target
 * concurrent-user count. Deterministic — no model call — so the slider
 * interaction stays snappy. Only stateless HTTP services (frontend/backend)
 * contribute to the concurrent-user math; workers are counted separately in
 * the recommendations.
 */
export function computeCapacityPlan(
  services: DetectedService[],
  targetConcurrentUsers: number,
): CapacityPlan {
  const httpServices = services.filter((s) => s.role === "frontend" || s.role === "backend");
  const totalTargetRps = Math.max(1, targetConcurrentUsers) * DEFAULT_REQ_PER_USER_PER_SEC;

  const replicas: ReplicaPlan[] = httpServices.map((s) => {
    const perPodRps = PER_POD_RPS[s.stack] ?? PER_POD_RPS.unknown;
    // Each HTTP service must independently handle the traffic — a request
    // typically hits frontend AND backend. Size each for the full target.
    const needed = Math.max(1, Math.ceil(totalTargetRps / perPodRps));
    const minReplicas = Math.max(2, needed); // never below 2 for HA
    const maxReplicas = Math.max(minReplicas * 2, Math.ceil(needed * 1.5));
    return {
      serviceName: s.name,
      stack: s.stack,
      perPodRps,
      minReplicas,
      maxReplicas,
      usersServedByMax: Math.floor((maxReplicas * perPodRps) / DEFAULT_REQ_PER_USER_PER_SEC),
    };
  });

  // Cluster sizing — rough pods-per-node capacity keyed by the biggest stack.
  // (JVM → heavier per pod, fewer per node; Go/Node → lighter.)
  const heaviest = services.reduce<string>(
    (acc, s) =>
      s.stack === "java" ? "java" : acc === "java" ? acc : s.stack === "python" ? "python" : acc,
    "node",
  );
  const podsPerLargeNode = heaviest === "java" ? 3 : heaviest === "python" ? 6 : 10;
  const totalMaxPods = replicas.reduce((sum, r) => sum + r.maxReplicas, 0) + 2; // + system overhead
  const nodeCount = Math.max(2, Math.ceil(replicas.reduce((s, r) => s + r.minReplicas, 0) / podsPerLargeNode));
  const maxNodeCount = Math.max(nodeCount + 1, Math.ceil(totalMaxPods / podsPerLargeNode));
  const nodeType =
    heaviest === "java"
      ? "t3.xlarge"
      : targetConcurrentUsers >= 5000
        ? "t3.xlarge"
        : targetConcurrentUsers >= 1500
          ? "t3.large"
          : "t3.medium";

  // Cluster's max concurrent-user headroom = the WEAKEST service's ceiling
  // (a request needs both frontend and backend to succeed).
  const clusterMax = replicas.length
    ? Math.min(...replicas.map((r) => r.usersServedByMax))
    : Math.floor(totalMaxPods * (PER_POD_RPS.node * podsPerLargeNode)) / DEFAULT_REQ_PER_USER_PER_SEC;

  return {
    targetConcurrentUsers,
    reqPerUserPerSec: DEFAULT_REQ_PER_USER_PER_SEC,
    replicas,
    cluster: {
      nodeType,
      nodeCount,
      maxNodeCount,
      maxConcurrentUsers: clusterMax,
    },
    reasoning:
      `Assumed ${DEFAULT_REQ_PER_USER_PER_SEC} req/s per user (typical interactive web usage). ` +
      `Each HTTP service sized independently — a request usually hits frontend AND backend. ` +
      `Cluster max reflects the weakest service at HPA-max replicas.`,
  };
}

/**
 * Rough US-region monthly on-demand prices (USD). Kept intentionally
 * conservative and low-fidelity — the point is a defensible ballpark the
 * user sees while dragging the slider, not a bill preview. Refreshed lazily
 * when the underlying prices move materially. All numbers rounded.
 *
 *   EC2 / EKS worker nodes  — hourly on-demand × 730
 *   RDS instances           — hourly on-demand × 730 (Multi-AZ ≈ 2×)
 *   ElastiCache             — cache.t3.micro roughly
 *   S3 / SES                — "small" allowance
 */
const NODE_MONTHLY_USD: Record<string, number> = {
  "t3.medium": 30,
  "t3.large": 60,
  "t3.xlarge": 120,
  "t3.2xlarge": 240,
};
const RDS_MONTHLY_USD: Record<string, number> = {
  "db.t3.micro": 15,
  "db.t3.small": 30,
  "db.t3.medium": 60,
  "db.t3.large": 120,
};

export type CostLineItem = {
  label: string;
  monthlyUsd: number;
  detail: string;
};

export type CostEstimate = {
  monthlyUsd: number;
  lineItems: CostLineItem[];
  assumptions: string;
};

/**
 * Ballpark monthly cost from a capacity plan + infra needs. Excludes DB when
 * the user says they have their own — that's the ownDb toggle in the wizard.
 * Bandwidth / egress deliberately not modelled (varies wildly by workload).
 */
export function computeCostEstimate(
  capacity: CapacityPlan,
  infraNeeds: InfraNeed[],
  opts: { hasOwnDb: boolean; environmentCount?: number },
): CostEstimate {
  const envs = Math.max(1, opts.environmentCount ?? 1);
  const items: CostLineItem[] = [];

  // Cluster nodes — priced at the recommended MIN count (steady-state cost).
  // Bursting to maxNodeCount would cost more; we call this out in assumptions.
  const nodePrice = NODE_MONTHLY_USD[capacity.cluster.nodeType] ?? 60;
  const clusterMonthly = nodePrice * capacity.cluster.nodeCount * envs;
  items.push({
    label: `Cluster · ${capacity.cluster.nodeCount}× ${capacity.cluster.nodeType}` +
      (envs > 1 ? ` × ${envs} envs` : ""),
    monthlyUsd: clusterMonthly,
    detail: `On-demand at steady-state. Bursts to ${capacity.cluster.maxNodeCount} nodes under load.`,
  });

  // EKS control-plane fee (AWS charges per cluster regardless of node count).
  const controlPlaneMonthly = 73 * envs; // $0.10/hr × 730
  items.push({
    label: `EKS control plane${envs > 1 ? ` × ${envs}` : ""}`,
    monthlyUsd: controlPlaneMonthly,
    detail: "AWS charges $0.10/hr per EKS cluster.",
  });

  // Managed database — only when detected AND the user hasn't opted out.
  if (!opts.hasOwnDb) {
    const dbNeed = infraNeeds.find((n) => n.kind === "postgres" || n.kind === "mysql");
    if (dbNeed) {
      // Guess the size from the recommendation string ("db.t3.micro (dev) / db.t3.medium Multi-AZ (prod)").
      const rec = dbNeed.recommendation.toLowerCase();
      const cls = rec.includes("db.t3.large")
        ? "db.t3.large"
        : rec.includes("db.t3.medium")
          ? "db.t3.medium"
          : rec.includes("db.t3.small")
            ? "db.t3.small"
            : "db.t3.micro";
      const base = RDS_MONTHLY_USD[cls] ?? 15;
      // Multi-AZ ≈ 2× the instance cost. Assume Multi-AZ for prod only.
      const multiplier = envs > 1 ? 1 + (envs - 1) * 2 : 1;
      const dbMonthly = base * multiplier;
      items.push({
        label: `Managed DB · ${cls}${envs > 1 ? " (Multi-AZ prod + dev)" : ""}`,
        monthlyUsd: dbMonthly,
        detail: dbNeed.recommendation,
      });
    }
  }

  // Redis / object storage / email — flat small allowances.
  if (infraNeeds.some((n) => n.kind === "redis")) {
    items.push({ label: "ElastiCache Redis · cache.t3.micro", monthlyUsd: 13 * envs, detail: "Small dev instance; scale later." });
  }
  if (infraNeeds.some((n) => n.kind === "objectStorage")) {
    items.push({ label: "S3 storage + requests", monthlyUsd: 5, detail: "First few GB + PUT/GET allowances." });
  }
  if (infraNeeds.some((n) => n.kind === "email")) {
    items.push({ label: "SES email", monthlyUsd: 1, detail: "First 62k emails/mo free from EC2." });
  }

  // Load balancer for the frontend (ALB ~$18/mo baseline + LCUs).
  const hasFrontend = capacity.replicas.some((r) => /frontend|front/i.test(r.serviceName));
  if (hasFrontend) {
    items.push({ label: `ALB${envs > 1 ? ` × ${envs}` : ""}`, monthlyUsd: 18 * envs, detail: "AWS Application Load Balancer baseline." });
  }

  const monthlyUsd = items.reduce((sum, i) => sum + i.monthlyUsd, 0);
  return {
    monthlyUsd,
    lineItems: items,
    assumptions:
      `Rough US-region on-demand prices. Excludes bandwidth/egress, backups, snapshots and reserved-instance discounts. ` +
      (opts.hasOwnDb ? "Managed DB excluded — you're using your own database." : "Includes a managed DB from the detected infra needs."),
  };
}

/**
 * Suggest a default target concurrent-user count for the first render of the
 * slider: pick something the DEFAULT replica count (2 per stateless service)
 * comfortably serves. This anchors the recommendation card in "here's what
 * the platform recommends OOTB" rather than a made-up round number.
 */
export function defaultTargetUsers(services: DetectedService[]): number {
  const httpServices = services.filter((s) => s.role === "frontend" || s.role === "backend");
  if (httpServices.length === 0) return 500;
  const bottleneckRps = Math.min(
    ...httpServices.map((s) => (PER_POD_RPS[s.stack] ?? PER_POD_RPS.unknown) * 2), // 2 replicas
  );
  return Math.floor(bottleneckRps / DEFAULT_REQ_PER_USER_PER_SEC / 100) * 100 || 500;
}

/**
 * Turn a CapacityPlan into the cluster + per-service replicas recommendation
 * rows the wizard renders. Extracted so the resize endpoint can rebuild
 * exactly the same rows after the user moves the slider — without the
 * frontend having to know the string format.
 *
 * Defined here (above analyzeGithubRepo) so tsserver's live diagnostics see
 * the identity in reading order — `tsc` hoists function declarations either
 * way, so the runtime behaviour is identical.
 */
export function recommendationsFromCapacity(
  services: DetectedService[],
  cap: CapacityPlan,
): Recommendation[] {
  const out: Recommendation[] = [];
  const stackLabels = services.map((s) => s.stackTitle).join(" + ");
  out.push({
    id: "cluster",
    area: "cluster",
    title: "Cluster size",
    value: `${cap.cluster.nodeCount}× ${cap.cluster.nodeType} nodes (auto-scale to ${cap.cluster.maxNodeCount}). Serves ~${cap.cluster.maxConcurrentUsers.toLocaleString()} concurrent users at HPA-max.`,
    why: `Sized for ${cap.targetConcurrentUsers.toLocaleString()} target concurrent users · ${stackLabels}.`,
  });
  for (const rep of cap.replicas) {
    out.push({
      id: `replicas:${rep.serviceName}`,
      area: "replicas",
      title: `Replicas + autoscaling — ${rep.serviceName}`,
      value: `${rep.minReplicas} replicas · HPA on CPU 70% (min ${rep.minReplicas} / max ${rep.maxReplicas}) — max serves ~${rep.usersServedByMax.toLocaleString()} users`,
      why: `~${rep.perPodRps} req/s per pod at typical requests × ${cap.reqPerUserPerSec} req/s per user.`,
    });
  }
  return out;
}

export type RepoAnalysisReport = {
  repoFullName: string;
  defaultBranch: string;
  analyzedAt: string;
  fileCount: number;
  services: DetectedService[];
  readmeSummary: string | null;
  /** First ~6000 chars of the README — input for the agent review. */
  readmeExcerpt: string | null;
  infraNeeds: InfraNeed[];
  envVars: EnvVarInfo[];
  missingFiles: MissingFile[];
  recommendations: Recommendation[];
  agentReview: AgentReview | null;
  /**
   * Capacity plan — sized for `capacity.targetConcurrentUsers`. The slider
   * in the wizard swaps this whole object (via POST /repos/resize) and the
   * cluster/replicas recommendations get regenerated to match. Independent
   * from `recommendations` because those are also derived from it — the
   * plan is the ground truth for sizing.
   */
  capacity: CapacityPlan;
  /**
   * Top-of-report call on cluster fit — 🟢 ready / 🟠 warn / 🔴 not_fit —
   * shown as the first card in the Analysis step and used to gate Continue
   * (`not_fit` disables it).
   */
  deployability: DeployabilityVerdict;
  /** Per-service migration tooling + init-container recommendation. */
  migrations: MigrationInfo[];
};

// ─────────────────────────────────────────────────────────────────
// GitHub fetch helpers
// ─────────────────────────────────────────────────────────────────

async function gh<T>(token: string, path: string): Promise<T | null> {
  const res = await fetch(`${GH}${path}`, {
    headers: {
      Authorization: `Bearer ${token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    cache: "no-store",
  });
  if (!res.ok) return null;
  return (await res.json()) as T;
}

/** Fetch a file's text content (contents API, base64). Null when absent/too big. */
async function fileText(token: string, fullName: string, path: string): Promise<string | null> {
  const data = await gh<{ content?: string; encoding?: string; size?: number }>(
    token,
    `/repos/${fullName}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}`,
  );
  if (!data?.content || data.encoding !== "base64") return null;
  if ((data.size ?? 0) > 300_000) return null; // skip huge files
  try {
    return Buffer.from(data.content, "base64").toString("utf8");
  } catch {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// Scanners
// ─────────────────────────────────────────────────────────────────

type Manifest = { path: string; dir: string; json: Record<string, unknown> };

function depsOf(json: Record<string, unknown>): Record<string, string> {
  return {
    ...((json.dependencies as Record<string, string>) ?? {}),
    ...((json.devDependencies as Record<string, string>) ?? {}),
  };
}

function detectStackFromPackageJson(deps: Record<string, string>): {
  stack: string;
  stackTitle: string;
  role: DetectedService["role"];
  port: number | null;
} {
  if (deps["next"]) return { stack: "nextjs", stackTitle: "Next.js", role: "frontend", port: 3000 };
  if (deps["react"] && !deps["express"] && !deps["fastify"])
    return { stack: "react", stackTitle: "React (static build)", role: "frontend", port: 3000 };
  if (deps["express"] || deps["fastify"] || deps["koa"] || deps["@nestjs/core"])
    return { stack: "node", stackTitle: "Node.js API", role: "backend", port: 8000 };
  return { stack: "node", stackTitle: "Node.js", role: "unknown", port: 3000 };
}

/**
 * Deep-detect a Node manifest into a LanguageProfile. Reads engines.node for
 * version, the presence of a lockfile for package manager, and framework
 * signals in dependencies for the framework/server/buildTool fields.
 */
function languageProfileForNode(
  json: Record<string, unknown>,
  deps: Record<string, string>,
  fileSet: Set<string>,
  dir: string,
): LanguageProfile {
  const engines = (json.engines as Record<string, string> | undefined) ?? {};
  const nodeVer = engines.node?.replace(/^[^\d]*/, "") ?? null;
  const scripts = (json.scripts as Record<string, string> | undefined) ?? {};
  const has = (p: string) => fileSet.has(dir ? `${dir}/${p}` : p);
  // Package manager — the lockfile that's actually present wins.
  const pm = has("pnpm-lock.yaml")
    ? "pnpm"
    : has("yarn.lock")
      ? "yarn"
      : has("bun.lockb") || has("bun.lock")
        ? "bun"
        : has("package-lock.json")
          ? "npm"
          : null;
  let framework: string | null = null;
  let server: string | null = null;
  let buildTool: string | null = null;
  if (deps["next"]) {
    framework = "Next.js";
    server = "next start";
    buildTool = "Next.js build";
  } else if (deps["@nestjs/core"]) {
    framework = "NestJS";
    server = "nest start";
    buildTool = "NestJS build";
  } else if (deps["fastify"]) {
    framework = "Fastify";
    server = scripts.start ?? "node";
  } else if (deps["express"]) {
    framework = "Express";
    server = scripts.start ?? "node";
  } else if (deps["koa"]) {
    framework = "Koa";
    server = scripts.start ?? "node";
  } else if (deps["react"] && !buildTool) {
    framework = "React";
    buildTool = deps["vite"] ? "Vite" : deps["webpack"] || deps["webpack-cli"] ? "webpack" : "npm run build";
  }
  return { language: "JavaScript", version: nodeVer, framework, server, packageManager: pm, buildTool };
}

/** Deep-detect a Python service from requirements.txt + optional pyproject. */
function languageProfileForPython(
  requirements: string,
  fileSet: Set<string>,
  dir: string,
): LanguageProfile {
  const lower = requirements.toLowerCase();
  const has = (p: string) => fileSet.has(dir ? `${dir}/${p}` : p);
  let framework: string | null = null;
  let server: string | null = null;
  if (/(^|\n)fastapi/.test(lower)) {
    framework = "FastAPI";
    server = /uvicorn/.test(lower) ? "uvicorn" : "uvicorn (recommended)";
  } else if (/(^|\n)django/.test(lower)) {
    framework = "Django";
    server = /gunicorn/.test(lower) ? "gunicorn" : "gunicorn (recommended)";
  } else if (/(^|\n)flask/.test(lower)) {
    framework = "Flask";
    server = /gunicorn/.test(lower) ? "gunicorn" : "gunicorn (recommended)";
  } else if (/celery|apscheduler/.test(lower)) {
    framework = "Worker (Celery/APScheduler)";
    server = null;
  }
  const pm = has("poetry.lock") ? "poetry" : has("Pipfile.lock") ? "pipenv" : "pip";
  // Version — Pipfile has [requires] python_version, pyproject may too. Skip
  // parsing for now unless we've fetched those files; leave null when unsure.
  return { language: "Python", version: null, framework, server, packageManager: pm, buildTool: null };
}

/** Empty profile used when we haven't fetched anything useful. */
function emptyLanguageProfile(language: string): LanguageProfile {
  return { language, version: null, framework: null, server: null, packageManager: null, buildTool: null };
}

/**
 * Detect a migration tool for a service by inspecting file names and the
 * dependency list. Also guesses whether migrations run at pod startup — a
 * pattern that breaks rolling deploys (multiple pods race to migrate).
 */
function detectMigrations(
  service: DetectedService,
  fileSet: Set<string>,
  nodeDeps: Record<string, string>,
  pyReqs: string,
): MigrationInfo | null {
  const inDir = (p: string) => fileSet.has(service.path ? `${service.path}/${p}` : p);
  const anyIn = (re: RegExp) => {
    for (const f of fileSet) {
      if (re.test(f) && (service.path === "" || f.startsWith(service.path + "/"))) return true;
    }
    return false;
  };
  // Prisma — Node
  if (nodeDeps["prisma"] || nodeDeps["@prisma/client"] || anyIn(/(^|\/)prisma\/schema\.prisma$/)) {
    return {
      tool: "Prisma",
      service: service.name,
      // Common Node pattern: "prisma migrate deploy" in the start script.
      runsAtStartup: false,
      recommendation:
        "Run `prisma migrate deploy` in an init container (or a one-off Job) — running it at pod startup makes multiple replicas race on the same migration.",
    };
  }
  // Alembic — Python
  if (inDir("alembic.ini") || anyIn(/(^|\/)alembic\//)) {
    return {
      tool: "Alembic",
      service: service.name,
      runsAtStartup: false,
      recommendation: "Run `alembic upgrade head` in an init container before app pods start.",
    };
  }
  // Django — Python
  if (/(^|\n)django/.test(pyReqs.toLowerCase()) && (inDir("manage.py") || anyIn(/(^|\/)manage\.py$/))) {
    return {
      tool: "Django",
      service: service.name,
      runsAtStartup: false,
      recommendation: "Run `python manage.py migrate` in an init container — Django migrations aren't safe to race.",
    };
  }
  // Rails
  if (anyIn(/(^|\/)db\/migrate\//)) {
    return {
      tool: "Rails",
      service: service.name,
      runsAtStartup: false,
      recommendation: "Run `rails db:migrate` in an init container — never at pod startup.",
    };
  }
  // Knex — Node
  if (nodeDeps["knex"] || anyIn(/(^|\/)knexfile\.(js|ts)$/)) {
    return {
      tool: "Knex",
      service: service.name,
      runsAtStartup: false,
      recommendation: "Run `knex migrate:latest` in an init container.",
    };
  }
  // TypeORM — Node
  if (nodeDeps["typeorm"]) {
    return {
      tool: "TypeORM",
      service: service.name,
      runsAtStartup: false,
      recommendation: "Run TypeORM migrations in an init container (`typeorm migration:run`); disable `synchronize` in production.",
    };
  }
  return null;
}

/**
 * Combine every signal into the top-of-report deployability call. The wizard
 * uses this to render the 🟢 / 🟠 / 🔴 verdict card and, for 🔴, to disable
 * Continue. The rule is intentionally simple: any HTTP service or worker =
 * ready; nothing runnable detected = not_fit.
 */
function computeDeployability(services: DetectedService[]): DeployabilityVerdict {
  const httpServices = services.filter((s) => s.role === "frontend" || s.role === "backend");
  const workers = services.filter((s) => s.role === "worker");
  const hasAnyRunnable = httpServices.length > 0 || workers.length > 0;

  if (!hasAnyRunnable) {
    return {
      status: "not_fit",
      title: "Not a fit for Kubernetes",
      reason:
        "No HTTP service or worker was detected — this repo looks like a library, CLI or non-server codebase. Deploying it to a cluster would run a container that nothing can reach.",
      concernCount: 0,
    };
  }

  const stackLabels = services.map((s) => s.stackTitle).join(" + ");
  return {
    status: "ready",
    title: "Ready for Kubernetes",
    reason: `${stackLabels}. Stateless HTTP surface detected — safe to scale horizontally.`,
    concernCount: 0,
  };
}

const PY_BACKEND_MARKERS = ["fastapi", "flask", "django", "uvicorn", "gunicorn"];

/** Infra needs from dependency names across every manifest we saw. */
function scanInfraNeeds(nodeDeps: Record<string, string>, pyReqs: string): InfraNeed[] {
  const out: InfraNeed[] = [];
  const add = (kind: InfraNeed["kind"], evidence: string, recommendation: string) => {
    if (!out.some((n) => n.kind === kind)) out.push({ kind, evidence, recommendation });
  };
  const py = pyReqs.toLowerCase();

  if (nodeDeps["pg"] || nodeDeps["@prisma/client"] || nodeDeps["prisma"] || /psycopg|asyncpg|sqlalchemy/.test(py))
    add("postgres", nodeDeps["pg"] ? "dependency `pg`" : nodeDeps["prisma"] || nodeDeps["@prisma/client"] ? "Prisma client" : "python postgres driver", "RDS PostgreSQL — db.t3.micro (dev) / db.t3.medium Multi-AZ (prod)");
  if (nodeDeps["mysql2"] || nodeDeps["mysql"] || /pymysql|mysqlclient/.test(py))
    add("mysql", "mysql driver dependency", "RDS MySQL — db.t3.micro (dev) / db.t3.medium Multi-AZ (prod)");
  if (nodeDeps["mongoose"] || nodeDeps["mongodb"] || /pymongo|motor/.test(py))
    add("mongodb", "mongodb driver dependency", "MongoDB Atlas or DocumentDB (external — connect via secret)");
  if (nodeDeps["redis"] || nodeDeps["ioredis"] || /(^|\n)redis/.test(py))
    add("redis", "redis client dependency", "ElastiCache Redis — cache.t3.micro (dev)");
  if (nodeDeps["kafkajs"] || nodeDeps["amqplib"] || /kafka|pika|celery/.test(py))
    add("queue", "queue client dependency", "Managed queue (MSK / MQ / SQS) — advisory");
  if (nodeDeps["@aws-sdk/client-s3"] || nodeDeps["aws-sdk"] || /boto3/.test(py))
    add("objectStorage", "S3 SDK dependency", "S3 bucket (create via s3-create wizard)");
  if (nodeDeps["nodemailer"] || /sendgrid|smtplib usage/.test(py))
    add("email", "mailer dependency", "SES or SMTP credentials as secrets — advisory");
  return out;
}

const SECRET_PATTERN = /KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|PRIVATE|_URL|_URI|DSN/i;

function envVarsFromEnvExample(text: string): EnvVarInfo[] {
  const out: EnvVarInfo[] = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]{1,60})\s*=/);
    if (m) out.push({ name: m[1]!, secret: SECRET_PATTERN.test(m[1]!), source: "env-example" });
  }
  return out;
}

function envVarsFromSource(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(/process\.env\.([A-Z][A-Z0-9_]{1,60})/g)) found.add(m[1]!);
  for (const m of text.matchAll(/process\.env\[["']([A-Z][A-Z0-9_]{1,60})["']\]/g)) found.add(m[1]!);
  for (const m of text.matchAll(/os\.environ(?:\.get)?\(?\[?["']([A-Z][A-Z0-9_]{1,60})["']/g)) found.add(m[1]!);
  for (const m of text.matchAll(/os\.getenv\(\s*["']([A-Z][A-Z0-9_]{1,60})["']/g)) found.add(m[1]!);
  return [...found];
}

/** Compact README digest: first heading + first paragraph + any run commands + service mentions. */
function summarizeReadme(text: string): string {
  const lines = text.split("\n");
  const title = lines.find((l) => l.startsWith("#"))?.replace(/^#+\s*/, "") ?? "";
  const firstPara =
    lines
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && !l.startsWith("!") && !l.startsWith("["))
      .slice(0, 2)
      .join(" ")
      .slice(0, 280) ?? "";
  const mentions: string[] = [];
  const lower = text.toLowerCase();
  for (const [needle, label] of [
    ["postgres", "PostgreSQL"],
    ["mysql", "MySQL"],
    ["mongodb", "MongoDB"],
    ["redis", "Redis"],
    ["kafka", "Kafka"],
    ["rabbitmq", "RabbitMQ"],
    ["s3", "S3"],
    ["docker", "Docker"],
  ] as const) {
    if (lower.includes(needle)) mentions.push(label);
  }
  const parts = [title && `“${title}”`, firstPara, mentions.length ? `Mentions: ${mentions.join(", ")}.` : ""].filter(
    Boolean,
  );
  return parts.join(" — ").slice(0, 500);
}

// ─────────────────────────────────────────────────────────────────
// Main entry
// ─────────────────────────────────────────────────────────────────

export async function analyzeGithubRepo(args: {
  token: string;
  fullName: string;
  defaultBranch?: string;
  onStep?: (label: string) => void;
}): Promise<RepoAnalysisReport | { error: string }> {
  const { token, fullName } = args;
  const step = args.onStep ?? (() => {});

  step("Reading repository metadata…");
  const repoMeta = await gh<{ default_branch?: string }>(token, `/repos/${fullName}`);
  if (!repoMeta) return { error: `Could not read ${fullName} — check GitHub access.` };
  const branch = args.defaultBranch || repoMeta.default_branch || "main";

  step("Listing the file tree…");
  const tree = await gh<{ tree?: Array<{ path: string; type: string; size?: number }>; truncated?: boolean }>(
    token,
    `/repos/${fullName}/git/trees/${encodeURIComponent(branch)}?recursive=1`,
  );
  if (!tree?.tree) return { error: "Could not list the repository tree." };
  const files = tree.tree.filter((t) => t.type === "blob").map((t) => t.path);
  const fileSet = new Set(files);
  const has = (p: string) => fileSet.has(p);
  const anyMatch = (re: RegExp) => files.some((f) => re.test(f));

  // ── manifests ──────────────────────────────────────────────────
  step("Reading manifests…");
  const pkgPaths = files.filter((f) => f.endsWith("package.json") && !f.includes("node_modules")).slice(0, 4);
  const manifests: Manifest[] = [];
  for (const p of pkgPaths) {
    const txt = await fileText(token, fullName, p);
    if (!txt) continue;
    try {
      manifests.push({ path: p, dir: p.replace(/\/?package\.json$/, ""), json: JSON.parse(txt) });
    } catch {
      /* malformed */
    }
  }
  const reqPath = files.find((f) => /(^|\/)requirements\.txt$/.test(f));
  const pyReqs = reqPath ? ((await fileText(token, fullName, reqPath)) ?? "") : "";
  const goMod = files.some((f) => /(^|\/)go\.mod$/.test(f));
  const pomXml = files.some((f) => /(^|\/)pom\.xml$/.test(f));

  // ── services ───────────────────────────────────────────────────
  step("Detecting services…");
  const services: DetectedService[] = [];
  for (const m of manifests) {
    const deps = depsOf(m.json);
    // Skip workspace-root manifests with no runnable stack signal.
    if (!deps["next"] && !deps["react"] && !deps["express"] && !deps["fastify"] && !deps["koa"] && !deps["@nestjs/core"] && manifests.length > 1 && m.dir === "")
      continue;
    const det = detectStackFromPackageJson(deps);
    services.push({
      name: m.dir ? m.dir.split("/").pop()! : ((m.json.name as string) || "app"),
      path: m.dir,
      stack: det.stack,
      stackTitle: det.stackTitle,
      role: det.role,
      port: det.port,
      hasDockerfile: has(m.dir ? `${m.dir}/Dockerfile` : "Dockerfile"),
      languageProfile: languageProfileForNode(m.json, deps, fileSet, m.dir),
    });
  }
  if (pyReqs) {
    const dir = reqPath!.replace(/\/?requirements\.txt$/, "");
    const isBackend = PY_BACKEND_MARKERS.some((mk) => pyReqs.toLowerCase().includes(mk));
    services.push({
      name: dir ? dir.split("/").pop()! : "backend",
      path: dir,
      stack: "python",
      stackTitle: isBackend ? "Python API (FastAPI/Flask/Django)" : "Python",
      role: isBackend ? "backend" : "worker",
      port: isBackend ? 8000 : null,
      hasDockerfile: has(dir ? `${dir}/Dockerfile` : "Dockerfile"),
      languageProfile: languageProfileForPython(pyReqs, fileSet, dir),
    });
  }
  if (goMod && services.length === 0)
    services.push({
      name: "app",
      path: "",
      stack: "go",
      stackTitle: "Go service",
      role: "backend",
      port: 8080,
      hasDockerfile: has("Dockerfile"),
      languageProfile: emptyLanguageProfile("Go"),
    });
  if (pomXml && services.length === 0)
    services.push({
      name: "app",
      path: "",
      stack: "java",
      stackTitle: "Java (Maven)",
      role: "backend",
      port: 8080,
      hasDockerfile: has("Dockerfile"),
      languageProfile: { ...emptyLanguageProfile("Java"), packageManager: "maven", buildTool: "Maven" },
    });
  if (services.length === 0)
    services.push({
      name: "app",
      path: "",
      stack: "unknown",
      stackTitle: "Unknown stack",
      role: "unknown",
      port: null,
      hasDockerfile: has("Dockerfile"),
      languageProfile: emptyLanguageProfile("Unknown"),
    });

  // ── README ─────────────────────────────────────────────────────
  step("Reading the README…");
  const readmePath = files.find((f) => /^readme\.md$/i.test(f)) ?? files.find((f) => /^readme/i.test(f));
  const readmeText = readmePath ? await fileText(token, fullName, readmePath) : null;
  const readmeSummary = readmeText ? summarizeReadme(readmeText) : null;

  // ── env vars ───────────────────────────────────────────────────
  step("Extracting environment variables…");
  const envExamplePath = files.find((f) => /(^|\/)\.env\.(example|sample|template)$/.test(f));
  const envExampleText = envExamplePath ? await fileText(token, fullName, envExamplePath) : null;
  const envVarMap = new Map<string, EnvVarInfo>();
  if (envExampleText) for (const v of envVarsFromEnvExample(envExampleText)) envVarMap.set(v.name, v);

  // Sample a bounded set of config-ish + entrypoint source files for env reads.
  const candidateSources = files
    .filter((f) =>
      /\.(ts|js|mjs|py|go)$/.test(f) &&
      !f.includes("node_modules") &&
      !f.includes("test") &&
      (/config|settings|env|index|main|app|server|db|database/i.test(f.split("/").pop() ?? "")),
    )
    .slice(0, 12);
  for (const p of candidateSources) {
    const txt = await fileText(token, fullName, p);
    if (!txt) continue;
    for (const name of envVarsFromSource(txt)) {
      if (!envVarMap.has(name))
        envVarMap.set(name, { name, secret: SECRET_PATTERN.test(name), source: "code" });
    }
  }
  const envVars = [...envVarMap.values()].sort((a, b) => a.name.localeCompare(b.name));

  // ── infra needs ────────────────────────────────────────────────
  const allNodeDeps = manifests.reduce<Record<string, string>>((acc, m) => Object.assign(acc, depsOf(m.json)), {});
  const infraNeeds = scanInfraNeeds(allNodeDeps, pyReqs);

  // ── migrations (per service) ───────────────────────────────────
  const migrations: MigrationInfo[] = [];
  for (const s of services) {
    const info = detectMigrations(s, fileSet, allNodeDeps, pyReqs);
    if (info) migrations.push(info);
  }

  // ── deployability verdict ──────────────────────────────────────
  const deployability = computeDeployability(services);

  // ── missing-file audit ─────────────────────────────────────────
  step("Auditing scaffolding files…");
  const missingFiles: MissingFile[] = [];
  for (const s of services) {
    if (!s.hasDockerfile && s.stack !== "unknown")
      missingFiles.push({
        id: `dockerfile:${s.path || "root"}`,
        label: `Dockerfile — ${s.name}`,
        detail: `No Dockerfile at ${s.path || "repo root"}. A ${s.stackTitle} multi-stage Dockerfile can be generated.`,
        servicePath: s.path,
        generatable: true,
      });
  }
  if (!anyMatch(/(^|\/)\.dockerignore$/))
    missingFiles.push({ id: "dockerignore", label: ".dockerignore", detail: "Keeps node_modules/.git out of image builds.", generatable: true });
  // CI/CD workflows are deliberately NOT audited here — pipeline generation
  // (CI + CD, registry auth, kubeconfig secrets) is owned by the in-project
  // deploy flow (deploy_my_app / CI-CD tab), which knows the target env and
  // registry. Offering a bare CI file from analysis would create a second,
  // inferior path that the deploy flow then has to reconcile with.
  if (!envExamplePath && envVars.length > 0)
    missingFiles.push({ id: "env-example", label: ".env.example", detail: `Documents the ${envVars.length} env vars the code reads.`, generatable: true });
  // README is the developer's to write — NEVER generated. It's also a hard
  // gate: without it the agent can't understand the application well enough
  // to size the deployment, so the wizard blocks until one is pushed.
  if (!readmePath)
    missingFiles.push({
      id: "readme",
      label: "README.md — required",
      detail:
        "This repo has no README. Write one describing what the app does, how it runs, and what it needs (DBs, external services) — the agent reads it to size the deployment. Push it to the repo, then re-analyze.",
      generatable: false,
      blocking: true,
    });

  // ── recommendations ────────────────────────────────────────────
  step("Building recommendations…");
  // Capacity plan first — the cluster + replicas recommendations are derived
  // from it so they stay coherent when the user later moves the slider.
  const capacity = computeCapacityPlan(services, defaultTargetUsers(services));
  const recommendations = recommendationsFromCapacity(services, capacity);
  // Workers get their own row (not part of the HTTP capacity math).
  for (const s of services) {
    if (s.role === "frontend" || s.role === "backend") continue;
    recommendations.push({
      id: `replicas:${s.path || "root"}`,
      area: "replicas",
      title: `Replicas + autoscaling — ${s.name}`,
      value: "1 replica · consider VPA",
      why: `${s.stackTitle} looks like a worker — horizontal scaling depends on queue semantics.`,
    });
  }
  for (const s of services) {
    const preset =
      s.stack === "python" ? "512Mi / 1Gi" : s.stack === "java" ? "1Gi / 2Gi" : s.stack === "go" ? "128Mi / 256Mi" : "256Mi / 512Mi";
    recommendations.push({
      id: `resources:${s.path || "root"}`,
      area: "resources",
      title: `Requests / limits — ${s.name}`,
      value: preset,
      why: `Stack preset for ${s.stackTitle}.`,
    });
  }
  for (const need of infraNeeds) {
    recommendations.push({
      id: `infra:${need.kind}`,
      area: need.kind === "postgres" || need.kind === "mysql" || need.kind === "mongodb" ? "database" : "services",
      title:
        need.kind === "postgres" ? "Database — PostgreSQL"
        : need.kind === "mysql" ? "Database — MySQL"
        : need.kind === "mongodb" ? "Database — MongoDB"
        : need.kind === "redis" ? "Cache — Redis"
        : need.kind === "queue" ? "Message queue"
        : need.kind === "objectStorage" ? "Object storage"
        : "Email delivery",
      value: need.recommendation,
      why: `Detected via ${need.evidence}.`,
    });
  }
  const fe = services.find((s) => s.role === "frontend");
  const be = services.find((s) => s.role === "backend");
  if (fe)
    recommendations.push({ id: "exposure:frontend", area: "exposure", title: `Exposure — ${fe.name}`, value: "ALB (internet-facing) · health path /", why: "User-facing frontend." });
  if (be)
    recommendations.push({
      id: "exposure:backend",
      area: "exposure",
      title: `Exposure — ${be.name}`,
      value: fe ? "ClusterIP (internal only)" : "ALB (internet-facing)",
      why: fe ? "Frontend can reach it via the cluster DNS — saves a LoadBalancer." : "Only service — needs external exposure.",
    });
  if (envVars.length > 0)
    recommendations.push({
      id: "env",
      area: "env",
      title: "Environment variables",
      value: `${envVars.length} vars (${envVars.filter((v) => v.secret).length} secrets) — set before first deploy`,
      why: "Extracted from source + .env.example.",
    });

  return {
    repoFullName: fullName,
    defaultBranch: branch,
    analyzedAt: new Date().toISOString(),
    fileCount: files.length,
    services,
    readmeSummary,
    readmeExcerpt: readmeText ? readmeText.slice(0, 6000) : null,
    infraNeeds,
    envVars,
    missingFiles,
    recommendations,
    agentReview: null,
    capacity,
    deployability,
    migrations,
  };
}
