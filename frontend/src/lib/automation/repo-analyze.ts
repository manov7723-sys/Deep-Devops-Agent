/**
 * Shared repo-stack detection for the Automation features (Dockerfile, CI
 * workflow, docker-compose). Reads a connected repo's root + key manifests via
 * the GitHub API, then asks Claude to pick the single best stack + params. The
 * LLM only *chooses*; the actual files are produced from the vetted templates
 * in @/lib/ci/templates so generation stays correct by construction.
 */
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { prisma } from "@/lib/db/prisma";
import { resolveTokenForRepo } from "@/lib/oauth/repo-token";
import { resolveRepoClient } from "@/lib/git";
import { DOCKER_STACKS, getStack, type DockerStackId } from "@/lib/ci/templates";

const ANALYSIS_MODEL = "claude-sonnet-4-5";
const OPENAI_ANALYSIS_MODEL = "gpt-4.1-mini";

/**
 * Run the analysis prompt on whichever LLM key the server actually has:
 * Anthropic first (original behavior), falling back to OpenAI — an
 * OpenAI-only deployment (or an expired Anthropic key) must not silently
 * break stack detection for every Automation feature + deploy_my_app.
 */
async function analysisComplete(
  prompt: string,
): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (anthropicKey) {
    try {
      const anthropic = new Anthropic({ apiKey: anthropicKey });
      const msg = await anthropic.messages.create({
        model: ANALYSIS_MODEL,
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      });
      return {
        ok: true,
        text: msg.content
          .filter((b) => b.type === "text")
          .map((b) => (b as { text: string }).text)
          .join(""),
      };
    } catch {
      /* fall through to OpenAI — e.g. the Anthropic key is expired/invalid */
    }
  }
  const openaiKey = process.env.OPENAI_API_KEY;
  if (openaiKey) {
    try {
      const openai = new OpenAI({ apiKey: openaiKey });
      const completion = await openai.chat.completions.create({
        model: OPENAI_ANALYSIS_MODEL,
        max_tokens: 600,
        messages: [{ role: "user", content: prompt }],
      });
      return { ok: true, text: completion.choices[0]?.message?.content ?? "" };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : "LLM error" };
    }
  }
  return {
    ok: false,
    error:
      "No usable LLM key on the server (ANTHROPIC_API_KEY invalid/missing and OPENAI_API_KEY missing).",
  };
}
const KEY_FILES = [
  "package.json",
  "requirements.txt",
  "pyproject.toml",
  "Pipfile",
  "go.mod",
  "index.html",
  "vite.config.js",
  "vite.config.ts",
  "next.config.js",
  "next.config.ts",
  "angular.json",
  "Dockerfile",
];

type GhEntry = { name: string; type: string; path: string };

function ghHeaders(token: string) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
}

export async function ghListRoot(fullName: string, ref: string, token: string): Promise<GhEntry[]> {
  const res = await fetch(
    `https://api.github.com/repos/${fullName}/contents?ref=${encodeURIComponent(ref)}`,
    {
      headers: ghHeaders(token),
      cache: "no-store",
    },
  );
  if (!res.ok) return [];
  const data = (await res.json().catch(() => [])) as GhEntry[];
  return Array.isArray(data) ? data : [];
}

export async function ghReadFile(
  fullName: string,
  path: string,
  ref: string,
  token: string,
): Promise<string | null> {
  const res = await fetch(
    `https://api.github.com/repos/${fullName}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${encodeURIComponent(ref)}`,
    { headers: ghHeaders(token), cache: "no-store" },
  );
  if (!res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { content?: string; encoding?: string };
  if (!data.content) return null;
  try {
    return Buffer.from(data.content, (data.encoding as BufferEncoding) || "base64").toString(
      "utf8",
    );
  } catch {
    return null;
  }
}

export type ResolvedRepo = { id: string; fullName: string; ref: string; accessToken: string };

/**
 * List a repo directory with retries. The GitHub contents API occasionally
 * stalls or drops a request; a single swallowed failure here used to surface
 * as a bogus "repository is empty or no access" to the user. One retry fixes
 * virtually all of these (verified: stall → instant success on attempt 2).
 */
async function listFilesWithRetry(
  client: {
    listFiles: (path: string, ref: string) => Promise<Array<{ name: string; type: string }>>;
  },
  path: string,
  ref: string,
  attempts = 3,
): Promise<Array<{ name: string; type: string }>> {
  for (let i = 1; i <= attempts; i++) {
    const files = await client.listFiles(path, ref).catch(() => []);
    if (files.length > 0 || i === attempts) return files;
    await new Promise((r) => setTimeout(r, i * 1000));
  }
  return [];
}

/** Resolve an attached repo + a usable access token, or a clear error. */
export async function resolveAttachedRepo(
  projectId: string,
  repoFullName: string,
): Promise<{ ok: true; repo: ResolvedRepo } | { ok: false; error: string }> {
  const repo = await prisma.repo.findFirst({
    where: { fullName: repoFullName, deletedAt: null, projectRepos: { some: { projectId } } },
    select: { id: true, defaultBranch: true, fullName: true },
  });
  if (!repo) return { ok: false, error: `Repo "${repoFullName}" isn't attached to this project.` };

  const tok = await resolveTokenForRepo(repo.id);
  if (!tok.ok) return { ok: false, error: `Cannot access ${repoFullName}: ${tok.message}` };

  return {
    ok: true,
    repo: {
      id: repo.id,
      fullName: repo.fullName,
      ref: repo.defaultBranch || "main",
      accessToken: tok.accessToken,
    },
  };
}

export type StackDetection =
  | {
      ok: true;
      stack: DockerStackId;
      stackTitle: string;
      params: Record<string, unknown>;
      reasoning: string;
      present: Set<string>;
      existingDockerfile: boolean;
    }
  | { ok: false; error: string };

/**
 * Read a connected repo and detect its stack + params. Shared by the
 * Dockerfile, CI-workflow and docker-compose automations.
 */
export async function detectRepoStack(
  projectId: string,
  repoFullName: string,
): Promise<StackDetection> {
  const resolved = await resolveAttachedRepo(projectId, repoFullName);
  if (!resolved.ok) return resolved;
  const { id, ref } = resolved.repo;

  // Read through the provider-neutral client so detection works on GitHub AND
  // GitLab repos (the actual REST differences live in @/lib/git).
  const rc = await resolveRepoClient(id);
  if (!rc.ok) return { ok: false, error: `Cannot access ${repoFullName}: ${rc.message}` };
  const client = rc.client;

  const rootFiles = await listFilesWithRetry(client, "", ref);
  if (rootFiles.length === 0)
    return { ok: false, error: "Couldn't read the repository contents (empty repo or no access)." };

  const present = new Set(rootFiles.map((f) => f.name.toLowerCase()));
  const keyContents: Record<string, string> = {};
  for (const f of KEY_FILES) {
    if (present.has(f.toLowerCase())) {
      const txt = await client.readFile(f, ref).catch(() => null);
      if (txt != null) keyContents[f] = txt.slice(0, 4000);
    }
  }
  const existingDockerfile = present.has("dockerfile");

  const stacksDesc = DOCKER_STACKS.map((s) => `- ${s.id}: ${s.detect}`).join("\n");
  const fileList = rootFiles.map((f) => (f.type === "dir" ? `${f.name}/` : f.name)).join(", ");
  const prompt = `You are a DevOps assistant. Analyze this GitHub repository and choose the single best stack and parameters for it.

Supported stacks:
${stacksDesc}

Repository root entries: ${fileList}

Key file contents (truncated):
${
  Object.entries(keyContents)
    .map(([k, v]) => `### ${k}\n${v}`)
    .join("\n\n") || "(no recognizable manifest files at the root)"
}

STACK CLASSIFICATION RULES — follow EXACTLY:
- A React / Vue / Angular / Svelte / Vite / CRA project whose package.json "build" script emits a static bundle (dist/build/out) and has NO server file calling listen() is "static-spa" (served by nginx). Do NOT call it "node-service" — that runs "node server.js" which doesn't exist and crashes the container.
- Use "node-service" ONLY for a real long-running server (Express/Fastify/Nest/Koa dep + a start script running a server file, or Next.js SSR). Set params.startCommand to the ACTUAL package.json start command, never assume "node server.js".
- "python": set params.startCommand to the real command; gunicorn/uvicorn is auto-installed even if missing from requirements.txt.

Respond with ONLY a JSON object, no prose:
{"stack": "static-spa" | "node-service" | "python" | "go", "params": { ... }, "reasoning": "<one short sentence>"}
- For static-spa, set params.buildDir to the build output dir (dist | build | out) and NO port (always 8080).
- For node-service / python / go, set params.port if you can infer the listening port (else omit).`;

  const llm = await analysisComplete(prompt);
  if (!llm.ok) return { ok: false, error: `Analysis failed: ${llm.error}` };
  const text = llm.text;

  let parsed: { stack?: string; params?: Record<string, unknown>; reasoning?: string };
  try {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    parsed = JSON.parse(text.slice(start, end + 1)) as typeof parsed;
  } catch {
    return { ok: false, error: "Couldn't parse the analysis result. Try again." };
  }

  const stackId = (parsed.stack ?? "") as DockerStackId;
  const stack = getStack(stackId);
  if (!stack)
    return { ok: false, error: `The analysis returned an unknown stack "${parsed.stack ?? ""}".` };

  return {
    ok: true,
    stack: stackId,
    stackTitle: stack.title,
    params: parsed.params ?? {},
    reasoning: parsed.reasoning ?? "",
    present,
    existingDockerfile,
  };
}

/** Common service-directory names to probe in a monorepo (frontend + backend). */
const SERVICE_DIR_HINTS = [
  "frontend",
  "backend",
  "client",
  "server",
  "web",
  "api",
  "app",
  "ui",
  "service",
  "services",
  "apps",
  "packages",
  "src",
];

export type AppService = {
  /** Short role label: "frontend" | "backend" | "app" (single-service) | dir name. */
  name: string;
  /** Repo-relative path of this service's build context ("" = repo root). */
  path: string;
  stack: DockerStackId;
  stackTitle: string;
  params: Record<string, unknown>;
  /** Container port this service listens on. */
  port: number;
  /** Suggested ECR/image name (repo-short + role), lowercase DNS-safe. */
  suggestedImageName: string;
  existingDockerfile: boolean;
};

export type ServicesDetection =
  { ok: true; monorepo: boolean; services: AppService[] } | { ok: false; error: string };

const DEFAULT_PORT: Record<string, number> = {
  "static-spa": 8080,
  "node-service": 3000,
  python: 8000,
  go: 8080,
};

/**
 * Deterministic SPA classifier from a package.json — used to override the LLM
 * when it mislabels a static frontend as a node-service. Returns isSpa=true
 * only when the deps show a client-side build tool (CRA/Vite/Angular/Vue/…),
 * there's a `build` script, AND there's NO long-running server framework
 * (Express/Fastify/Nest/Koa/Next) — because those genuinely need node-service.
 */
function classifySpaFromPackageJson(raw: string): { isSpa: boolean; buildDir: string } {
  try {
    const pkg = JSON.parse(raw) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
      scripts?: Record<string, string>;
    };
    const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
    const names = Object.keys(deps);
    const has = (n: string) => names.some((d) => d === n || d.startsWith(n + "/") || d.startsWith(n));
    const scripts = pkg.scripts ?? {};
    const hasBuild = typeof scripts.build === "string" && scripts.build.trim().length > 0;

    // A real long-running Node server → NOT a static SPA (keep node-service).
    // "next" is here because Next.js SSR needs a node runtime; a pure static
    // Next export is rare enough that defaulting it to node-service is safer.
    const isServer =
      has("express") ||
      has("fastify") ||
      has("@nestjs") ||
      has("koa") ||
      has("next") ||
      has("@hapi") ||
      has("hapi") ||
      has("restify");
    if (isServer) return { isSpa: false, buildDir: "dist" };

    const isCra = has("react-scripts");
    const isVite = has("vite");
    const isAngular = has("@angular/cli") || has("@angular/core");
    const isVueCli = has("@vue/cli-service");
    const isParcel = has("parcel");
    const isReactOrVue = has("react") || has("vue") || has("svelte") || has("solid-js");

    const looksSpa =
      isCra || isVite || isAngular || isVueCli || isParcel || (isReactOrVue && hasBuild);
    if (looksSpa && hasBuild) {
      // CRA builds to build/, most others to dist/.
      const buildDir = isCra ? "build" : "dist";
      return { isSpa: true, buildDir };
    }
  } catch {
    /* not JSON / unreadable → let the LLM's choice stand */
  }
  return { isSpa: false, buildDir: "dist" };
}

/** "owner/My_Repo" + "backend" -> "my-repo-backend" (DNS/ECR-safe, ≤200). */
function imageNameFor(repoFullName: string, role: string): string {
  const short = (repoFullName.split("/").pop() ?? "app").toLowerCase();
  const base = role && role !== "app" && role !== short ? `${short}-${role}` : short;
  return (
    base
      .replace(/[^a-z0-9._-]+/g, "-")
      .replace(/^[-.]+|[-.]+$/g, "")
      .slice(0, 200) || "app"
  );
}

/**
 * Detect ALL deployable services in a repo — a single app, OR a monorepo with a
 * separate frontend and backend. Reads the root plus likely service subdirs and
 * asks the LLM to enumerate each service's build context, stack and port. Used
 * by the deploy flow to decide whether to ask the user for one ECR repo or two.
 */
export async function analyzeAppServices(
  projectId: string,
  repoFullName: string,
): Promise<ServicesDetection> {
  const resolved = await resolveAttachedRepo(projectId, repoFullName);
  if (!resolved.ok) return resolved;
  const { id, ref } = resolved.repo;

  const rc = await resolveRepoClient(id);
  if (!rc.ok) return { ok: false, error: `Cannot access ${repoFullName}: ${rc.message}` };
  const client = rc.client;

  const rootFiles = await listFilesWithRetry(client, "", ref);
  if (rootFiles.length === 0)
    return { ok: false, error: "Couldn't read the repository contents (empty repo or no access)." };
  const rootDirs = rootFiles.filter((f) => f.type === "dir").map((f) => f.name);

  // Probe root + candidate service dirs for manifests. Keep it cheap: only dirs
  // whose name hints at a service (frontend/backend/…) and that actually hold a manifest.
  const probePaths = ["", ...rootDirs.filter((d) => SERVICE_DIR_HINTS.includes(d.toLowerCase()))];
  const dirManifests: Record<string, string[]> = {};
  const dirContents: Record<string, Record<string, string>> = {};
  for (const dir of probePaths) {
    const files = dir === "" ? rootFiles : await listFilesWithRetry(client, dir, ref, 2);
    const names = files.map((f) => f.name);
    const manifests = KEY_FILES.filter((k) =>
      names.some((n) => n.toLowerCase() === k.toLowerCase()),
    );
    if (dir !== "" && manifests.length === 0) continue; // subdir with no manifest → not a service
    dirManifests[dir || "."] = manifests;
    const contents: Record<string, string> = {};
    for (const k of manifests) {
      const p = dir === "" ? k : `${dir}/${k}`;
      const txt = await client.readFile(p, ref).catch(() => null);
      if (txt != null) contents[k] = txt.slice(0, 3000);
    }
    dirContents[dir || "."] = contents;
  }

  const stacksDesc = DOCKER_STACKS.map((s) => `- ${s.id}: ${s.detect}`).join("\n");
  const treeDesc = Object.entries(dirContents)
    .map(([dir, contents]) => {
      const header = dir === "." ? "(repo root)" : `${dir}/`;
      const body =
        Object.entries(contents)
          .map(([k, v]) => `#### ${k}\n${v}`)
          .join("\n\n") || "(manifests present, no content read)";
      return `### ${header} — manifests: ${dirManifests[dir]?.join(", ") || "none"}\n${body}`;
    })
    .join("\n\n");

  const prompt = `You are a DevOps assistant. Determine every DEPLOYABLE service in this repository.
Most repos have ONE service. Some are a monorepo with a SEPARATE frontend and backend (each in its own directory with its own manifest). Only report a directory as a service if it has its own build manifest (package.json, requirements.txt, go.mod, etc.).

Supported stacks:
${stacksDesc}

Repository layout and manifests:
${treeDesc}

STACK CLASSIFICATION RULES — follow these EXACTLY, they prevent the two most common deploy-breaking mistakes:
- A React / Vue / Angular / Svelte / Vite / Create-React-App project is a "static-spa" WHENEVER its package.json "build" script emits a static bundle (to dist/build/out) and there is NO server entry file that calls listen() (no server.js/index.js running Express/Fastify/Nest, not Next.js). Serving is done by nginx over the built files. Do NOT classify these as "node-service" — that would run "node server.js", which does not exist, and the container crashes with "Cannot find module server.js".
  • Tell-tale static-spa deps: react-scripts, vite, @angular/cli, @vue/cli-service, parcel, webpack (as a build tool). buildDir: CRA→build, Vite/Angular/Vue→dist, Next export→out.
- Only use "node-service" when the package.json has a real long-running server: an Express/Fastify/Nest/Koa dependency AND a start script that runs a server file (e.g. "node server.js", "nest start", "next start" for SSR). If you pick node-service, set params.startCommand to the ACTUAL command from package.json "scripts.start" (or the file named in "main") — never assume "node server.js" unless that file exists.
- "python": set params.startCommand to the real server command; gunicorn/uvicorn will be auto-installed even if absent from requirements.txt.

Respond with ONLY a JSON object, no prose:
{"monorepo": true|false, "services": [{"name": "frontend"|"backend"|"app", "path": "<repo-relative dir, \"\" for root>", "stack": "static-spa"|"node-service"|"python"|"go", "params": { ... }, "port": <number> }]}
- Use "frontend" for the UI/SPA service, "backend" for the API service, "app" for a single-service repo.
- For static-spa set params.buildDir (dist|build|out) — do NOT set a port, it always serves on 8080. For others set params.port to the listening port when inferable.
- If the whole repo is one service, return exactly one service with path "".`;

  const llm = await analysisComplete(prompt);
  if (!llm.ok) return { ok: false, error: `Analysis failed: ${llm.error}` };

  let parsed: {
    monorepo?: boolean;
    services?: Array<{
      name?: string;
      path?: string;
      stack?: string;
      params?: Record<string, unknown>;
      port?: number;
    }>;
  };
  try {
    const start = llm.text.indexOf("{");
    const end = llm.text.lastIndexOf("}");
    parsed = JSON.parse(llm.text.slice(start, end + 1)) as typeof parsed;
  } catch {
    return { ok: false, error: "Couldn't parse the service analysis result. Try again." };
  }

  const rawServices =
    Array.isArray(parsed.services) && parsed.services.length
      ? parsed.services
      : [{ name: "app", path: "", stack: parsed.services?.[0]?.stack }];
  const services: AppService[] = [];
  for (const s of rawServices) {
    let stackId = (s.stack ?? "") as DockerStackId;
    let params = (s.params ?? {}) as Record<string, unknown>;
    const path = (s.path ?? "").replace(/^\.?\/*/, "").replace(/\/+$/, "");
    const role = (s.name ?? "app").toLowerCase();
    const dirKey = path || ".";

    // DETERMINISTIC override — the LLM intermittently tags a static SPA as a
    // "node-service", which then runs "node server.js" and crashes the pod
    // with "Cannot find module server.js". Correct it straight from the
    // service's real package.json: SPA build tooling + a build script + NO
    // server framework ⇒ static-spa (served by nginx). This removes the LLM
    // from the decision for the single most common deploy-breaking mistake.
    if (stackId === "node-service" || stackId === "static-spa") {
      const pkgRaw = dirContents[dirKey]?.["package.json"];
      const spa = pkgRaw ? classifySpaFromPackageJson(pkgRaw) : null;
      if (spa?.isSpa && stackId !== "static-spa") {
        stackId = "static-spa" as DockerStackId;
        params = { ...params, buildDir: spa.buildDir };
      }
    }

    const stack = getStack(stackId);
    if (!stack) continue;
    // static-spa always serves on 8080 (nginx); ignore any port the LLM set.
    const port =
      stackId === "static-spa"
        ? 8080
        : Number(s.port) > 0
          ? Number(s.port)
          : (DEFAULT_PORT[stackId] ?? 8080);
    // Does this service dir already ship a Dockerfile?
    const hasDockerfile = (dirManifests[dirKey] ?? []).some(
      (m) => m.toLowerCase() === "dockerfile",
    );
    services.push({
      name: role,
      path,
      stack: stackId,
      stackTitle: stack.title,
      params,
      port,
      suggestedImageName: imageNameFor(repoFullName, role),
      existingDockerfile: hasDockerfile,
    });
  }
  if (services.length === 0)
    return {
      ok: false,
      error: "No deployable service with a recognizable stack was found in the repo.",
    };

  return { ok: true, monorepo: services.length > 1 || parsed.monorepo === true, services };
}
