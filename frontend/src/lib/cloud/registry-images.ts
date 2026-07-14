/**
 * List container images + tags from a project's connected cloud registry so the
 * Deploy wizard can offer a picker instead of a hand-typed image reference.
 *
 *   • AWS ECR  — `aws ecr describe-repositories` + `describe-images` (CLI).
 *   • GCP GAR  — Artifact Registry REST (dockerImages) with the stored token.
 *   • Azure ACR— data-plane /v2 catalog+tags via an ACR token exchanged from the
 *                stored AAD token.
 *
 * Every path is best-effort and defensive: on any failure it returns
 * { ok:false, error }, and the wizard simply falls back to manual entry — the
 * picker is additive and never blocks a deploy.
 */
import { prisma } from "@/lib/db/prisma";
import { runStage } from "@/lib/runner/exec";
import { resolveAwsExecEnv } from "@/lib/cloud/aws-onboard";
import { getGcpAccessToken } from "@/lib/cloud/gcp";
import { getAzureAccessToken } from "@/lib/cloud/azure";
import { listAcr } from "@/lib/cloud/azure-acr";

export type RegistryImage = {
  repository: string; // repo/path within the registry
  tag: string;
  image: string; // full pullable reference (registry/repo:tag)
  pushedAt?: string; // ISO string, best-effort
};

export type RegistryImagesResult =
  | { ok: true; cloud: "aws" | "azure" | "gcp"; images: RegistryImage[]; note?: string }
  | { ok: false; error: string };

const MAX_REPOS = 25;
const MAX_IMAGES = 150;

/** Find the project's cloud provider and list images from its registry. */
export async function listProjectRegistryImages(projectId: string): Promise<RegistryImagesResult> {
  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId, kind: { in: ["aws", "azure", "gcp"] } },
    select: { id: true, kind: true, region: true, accountRef: true },
  });
  if (!cp) return { ok: false, error: "No cloud provider is connected to this project." };

  if (cp.kind === "aws") return listEcrImages(cp.id);
  if (cp.kind === "gcp") return listGarImages(cp.id, cp.region, cp.accountRef);
  if (cp.kind === "azure") return listAcrImages(cp.id);
  return { ok: false, error: "Unsupported cloud." };
}

function sortAndCap(images: RegistryImage[]): RegistryImage[] {
  return images
    .sort((a, b) => (b.pushedAt ?? "").localeCompare(a.pushedAt ?? ""))
    .slice(0, MAX_IMAGES);
}

// ── AWS ECR ────────────────────────────────────────────────────────────────
async function listEcrImages(cloudProviderId: string): Promise<RegistryImagesResult> {
  const resolved = await resolveAwsExecEnv(cloudProviderId);
  if (!resolved.ok) return { ok: false, error: resolved.message };
  const env = { ...resolved.env };
  const base = ["--region", resolved.region, "--output", "json", "--no-cli-pager"];

  const repoRes = await runStage({
    command: "aws",
    args: ["ecr", "describe-repositories", ...base],
    cwd: process.cwd(),
    env,
    timeoutMs: 30_000,
    maxBufferBytes: 4 * 1024 * 1024,
  });
  if (repoRes.exitCode !== 0) {
    if (repoRes.exitCode === -1)
      return { ok: false, error: "`aws` CLI isn't installed on the server." };
    return {
      ok: false,
      error: (repoRes.stderr.trim() || "Couldn't list ECR repositories.").slice(-300),
    };
  }
  let repos: Array<{ repositoryName?: string; repositoryUri?: string }> = [];
  try {
    repos = (JSON.parse(repoRes.stdout) as { repositories?: typeof repos }).repositories ?? [];
  } catch {
    return { ok: false, error: "Couldn't parse the ECR repository list." };
  }

  const images: RegistryImage[] = [];
  for (const repo of repos.slice(0, MAX_REPOS)) {
    if (!repo.repositoryName || !repo.repositoryUri) continue;
    const imgRes = await runStage({
      command: "aws",
      args: ["ecr", "describe-images", "--repository-name", repo.repositoryName, ...base],
      cwd: process.cwd(),
      env,
      timeoutMs: 30_000,
      maxBufferBytes: 4 * 1024 * 1024,
    });
    if (imgRes.exitCode !== 0) continue;
    try {
      const details =
        (
          JSON.parse(imgRes.stdout) as {
            imageDetails?: Array<{ imageTags?: string[]; imagePushedAt?: number | string }>;
          }
        ).imageDetails ?? [];
      for (const d of details) {
        const pushedAt = toIso(d.imagePushedAt);
        for (const tag of d.imageTags ?? []) {
          images.push({
            repository: repo.repositoryName,
            tag,
            image: `${repo.repositoryUri}:${tag}`,
            pushedAt,
          });
        }
      }
    } catch {
      /* skip this repo */
    }
    if (images.length >= MAX_IMAGES) break;
  }
  return {
    ok: true,
    cloud: "aws",
    images: sortAndCap(images),
    note: repos.length > MAX_REPOS ? `Showing the first ${MAX_REPOS} repositories.` : undefined,
  };
}

// ── GCP Artifact Registry ────────────────────────────────────────────────────
async function listGarImages(
  cloudProviderId: string,
  region: string | null,
  project: string | null,
): Promise<RegistryImagesResult> {
  const proj = (project || "").trim();
  const location = (region || "").trim();
  if (!proj) return { ok: false, error: "GCP provider has no project id." };
  if (!location)
    return {
      ok: false,
      error: "GCP provider has no region set — set a region/location to list images.",
    };
  const tok = await getGcpAccessToken(cloudProviderId);
  if (!tok.ok) return { ok: false, error: tok.error };
  const token = tok.accessToken;

  const gget = async <T>(url: string): Promise<T | null> => {
    try {
      const r = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
      if (!r.ok) return null;
      return (await r.json()) as T;
    } catch {
      return null;
    }
  };

  const repoList = await gget<{ repositories?: Array<{ name?: string; format?: string }> }>(
    `https://artifactregistry.googleapis.com/v1/projects/${proj}/locations/${location}/repositories`,
  );
  if (!repoList)
    return {
      ok: false,
      error: "Couldn't list Artifact Registry repositories (check the region and API access).",
    };
  const repos = (repoList.repositories ?? [])
    .filter((r) => (r.format ?? "").toUpperCase() === "DOCKER" && r.name)
    .map((r) => r.name!.split("/").pop()!)
    .slice(0, MAX_REPOS);

  const images: RegistryImage[] = [];
  for (const repo of repos) {
    const imgs = await gget<{
      dockerImages?: Array<{ uri?: string; tags?: string[]; updateTime?: string }>;
    }>(
      `https://artifactregistry.googleapis.com/v1/projects/${proj}/locations/${location}/repositories/${repo}/dockerImages`,
    );
    for (const im of imgs?.dockerImages ?? []) {
      const base = (im.uri ?? "").split("@")[0]; // strip the digest
      if (!base) continue;
      for (const tag of im.tags ?? []) {
        images.push({ repository: repo, tag, image: `${base}:${tag}`, pushedAt: im.updateTime });
      }
    }
    if (images.length >= MAX_IMAGES) break;
  }
  return { ok: true, cloud: "gcp", images: sortAndCap(images) };
}

// ── Azure ACR ────────────────────────────────────────────────────────────────
async function listAcrImages(cloudProviderId: string): Promise<RegistryImagesResult> {
  const tok = await getAzureAccessToken(cloudProviderId);
  if (!tok.ok) return { ok: false, error: tok.error };
  const registries = await listAcr(cloudProviderId);
  if (!registries.ok) return { ok: false, error: registries.error };
  if (registries.data.length === 0)
    return {
      ok: true,
      cloud: "azure",
      images: [],
      note: "No container registries found in this subscription.",
    };

  const tenant = tenantFromJwt(tok.accessToken);
  const images: RegistryImage[] = [];

  for (const reg of registries.data.slice(0, 5)) {
    const server = reg.loginServer;
    // 1) Exchange the AAD token for an ACR refresh token.
    const acrToken = await acrAccessToken(server, tok.accessToken, tenant);
    if (!acrToken) continue;
    // 2) List repositories, then tags for each.
    const catalog = await acrGet<{ repositories?: string[] }>(server, "/v2/_catalog", acrToken);
    for (const repo of (catalog?.repositories ?? []).slice(0, MAX_REPOS)) {
      const tagsRes = await acrGet<{ tags?: string[] }>(server, `/v2/${repo}/tags/list`, acrToken);
      for (const tag of tagsRes?.tags ?? []) {
        images.push({ repository: repo, tag, image: `${server}/${repo}:${tag}` });
      }
      if (images.length >= MAX_IMAGES) break;
    }
    if (images.length >= MAX_IMAGES) break;
  }
  return { ok: true, cloud: "azure", images: sortAndCap(images) };
}

/** Exchange an AAD token for an ACR access token scoped to read the catalog. */
async function acrAccessToken(
  loginServer: string,
  aadToken: string,
  tenant: string | null,
): Promise<string | null> {
  try {
    const exch = await fetch(`https://${loginServer}/oauth2/exchange`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "access_token",
        service: loginServer,
        ...(tenant ? { tenant } : {}),
        access_token: aadToken,
      }),
    });
    if (!exch.ok) return null;
    const rt = ((await exch.json()) as { refresh_token?: string }).refresh_token;
    if (!rt) return null;

    const tk = await fetch(`https://${loginServer}/oauth2/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "refresh_token",
        service: loginServer,
        scope: "registry:catalog:* repository:*:metadata_read repository:*:pull",
        refresh_token: rt,
      }),
    });
    if (!tk.ok) return null;
    return ((await tk.json()) as { access_token?: string }).access_token ?? null;
  } catch {
    return null;
  }
}

async function acrGet<T>(loginServer: string, path: string, token: string): Promise<T | null> {
  try {
    const r = await fetch(`https://${loginServer}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!r.ok) return null;
    return (await r.json()) as T;
  } catch {
    return null;
  }
}

// ── helpers ──────────────────────────────────────────────────────────────────
function toIso(v: number | string | undefined): string | undefined {
  if (v == null) return undefined;
  const ms = typeof v === "number" ? v * 1000 : Date.parse(v);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : undefined;
}

/** Best-effort extract the `tid` (tenant) claim from an AAD JWT. */
function tenantFromJwt(jwt: string): string | null {
  try {
    const payload = jwt.split(".")[1];
    if (!payload) return null;
    const json = JSON.parse(
      Buffer.from(payload.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"),
    );
    return typeof json.tid === "string" ? json.tid : null;
  } catch {
    return null;
  }
}
