/**
 * Shared repo-stack detection for the Automation features (Dockerfile, CI
 * workflow, docker-compose). Reads a connected repo's root + key manifests via
 * the GitHub API, then asks Claude to pick the single best stack + params. The
 * LLM only *chooses*; the actual files are produced from the vetted templates
 * in @/lib/ci/templates so generation stays correct by construction.
 */
import Anthropic from "@anthropic-ai/sdk";
import { prisma } from "@/lib/db/prisma";
import { resolveTokenForRepo } from "@/lib/oauth/repo-token";
import { resolveRepoClient } from "@/lib/git";
import { DOCKER_STACKS, getStack, type DockerStackId } from "@/lib/ci/templates";

const ANALYSIS_MODEL = "claude-sonnet-4-5";
const KEY_FILES = [
  "package.json", "requirements.txt", "pyproject.toml", "Pipfile", "go.mod", "index.html",
  "vite.config.js", "vite.config.ts", "next.config.js", "next.config.ts", "angular.json", "Dockerfile",
];

type GhEntry = { name: string; type: string; path: string };

function ghHeaders(token: string) {
  return { Authorization: `Bearer ${token}`, Accept: "application/vnd.github+json", "X-GitHub-Api-Version": "2022-11-28" };
}

export async function ghListRoot(fullName: string, ref: string, token: string): Promise<GhEntry[]> {
  const res = await fetch(`https://api.github.com/repos/${fullName}/contents?ref=${encodeURIComponent(ref)}`, {
    headers: ghHeaders(token), cache: "no-store",
  });
  if (!res.ok) return [];
  const data = (await res.json().catch(() => [])) as GhEntry[];
  return Array.isArray(data) ? data : [];
}

export async function ghReadFile(fullName: string, path: string, ref: string, token: string): Promise<string | null> {
  const res = await fetch(
    `https://api.github.com/repos/${fullName}/contents/${encodeURIComponent(path).replace(/%2F/g, "/")}?ref=${encodeURIComponent(ref)}`,
    { headers: ghHeaders(token), cache: "no-store" },
  );
  if (!res.ok) return null;
  const data = (await res.json().catch(() => ({}))) as { content?: string; encoding?: string };
  if (!data.content) return null;
  try {
    return Buffer.from(data.content, (data.encoding as BufferEncoding) || "base64").toString("utf8");
  } catch {
    return null;
  }
}

export type ResolvedRepo = { id: string; fullName: string; ref: string; accessToken: string };

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
    repo: { id: repo.id, fullName: repo.fullName, ref: repo.defaultBranch || "main", accessToken: tok.accessToken },
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
export async function detectRepoStack(projectId: string, repoFullName: string): Promise<StackDetection> {
  const resolved = await resolveAttachedRepo(projectId, repoFullName);
  if (!resolved.ok) return resolved;
  const { id, ref } = resolved.repo;

  // Read through the provider-neutral client so detection works on GitHub AND
  // GitLab repos (the actual REST differences live in @/lib/git).
  const rc = await resolveRepoClient(id);
  if (!rc.ok) return { ok: false, error: `Cannot access ${repoFullName}: ${rc.message}` };
  const client = rc.client;

  const rootFiles = await client.listFiles("", ref).catch(() => []);
  if (rootFiles.length === 0) return { ok: false, error: "Couldn't read the repository contents (empty repo or no access)." };

  const present = new Set(rootFiles.map((f) => f.name.toLowerCase()));
  const keyContents: Record<string, string> = {};
  for (const f of KEY_FILES) {
    if (present.has(f.toLowerCase())) {
      const txt = await client.readFile(f, ref).catch(() => null);
      if (txt != null) keyContents[f] = txt.slice(0, 4000);
    }
  }
  const existingDockerfile = present.has("dockerfile");

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return { ok: false, error: "ANTHROPIC_API_KEY isn't set on the server." };

  const stacksDesc = DOCKER_STACKS.map((s) => `- ${s.id}: ${s.detect}`).join("\n");
  const fileList = rootFiles.map((f) => (f.type === "dir" ? `${f.name}/` : f.name)).join(", ");
  const prompt = `You are a DevOps assistant. Analyze this GitHub repository and choose the single best stack and parameters for it.

Supported stacks:
${stacksDesc}

Repository root entries: ${fileList}

Key file contents (truncated):
${Object.entries(keyContents).map(([k, v]) => `### ${k}\n${v}`).join("\n\n") || "(no recognizable manifest files at the root)"}

Respond with ONLY a JSON object, no prose:
{"stack": "static-spa" | "node-service" | "python" | "go", "params": { ... }, "reasoning": "<one short sentence>"}
- For static-spa, set params.buildDir to the build output dir (dist | build | out).
- For node-service / python / go, set params.port if you can infer the listening port (else omit).`;

  let text = "";
  try {
    const anthropic = new Anthropic({ apiKey });
    const msg = await anthropic.messages.create({
      model: ANALYSIS_MODEL,
      max_tokens: 600,
      messages: [{ role: "user", content: prompt }],
    });
    text = msg.content.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
  } catch (e) {
    return { ok: false, error: `Analysis failed: ${e instanceof Error ? e.message : "LLM error"}` };
  }

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
  if (!stack) return { ok: false, error: `The analysis returned an unknown stack "${parsed.stack ?? ""}".` };

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
