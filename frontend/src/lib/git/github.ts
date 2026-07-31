/**
 * GitHub implementation of GitRepoClient — thin wrapper over the REST contents
 * API (api.github.com). Preserves the exact behaviour the repo tools already
 * relied on (base64 file decoding, array-vs-object contents shape).
 */
import type { ChangeRequest, CommitFile, GitEntry, GitRepoClient } from "./types";

/** Encode each path segment but keep the slashes that separate them. */
function encodePath(path: string): string {
  return path.split("/").filter(Boolean).map(encodeURIComponent).join("/");
}

export class GithubRepoClient implements GitRepoClient {
  readonly provider = "github" as const;
  readonly fullName: string;
  readonly defaultBranch: string;
  private readonly token: string;
  private readonly apiBase: string;

  constructor(opts: { token: string; fullName: string; defaultBranch: string; apiBase: string }) {
    this.token = opts.token;
    this.fullName = opts.fullName;
    this.defaultBranch = opts.defaultBranch;
    this.apiBase = opts.apiBase.replace(/\/+$/, "");
  }

  webUrl(): string {
    return `https://github.com/${this.fullName}`;
  }

  cloneUrlWithToken(): string {
    return `https://x-access-token:${this.token}@github.com/${this.fullName}.git`;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    };
  }

  /**
   * fetch with retries on NETWORK failures ("fetch failed" — flaky link, DNS,
   * broken IPv6) and 5xx gateway blips. Git object POSTs are content-addressed,
   * so a duplicate retry is harmless; without this, one dropped packet aborted
   * a whole multi-file push halfway through.
   */
  private async http(url: string, init?: RequestInit, attempts = 3): Promise<Response> {
    let lastErr: unknown;
    for (let i = 1; i <= attempts; i++) {
      try {
        const res = await fetch(url, init);
        if ((res.status === 502 || res.status === 503 || res.status === 504) && i < attempts) {
          await new Promise((r) => setTimeout(r, i * 1000));
          continue;
        }
        return res;
      } catch (err) {
        lastErr = err;
        if (i < attempts) await new Promise((r) => setTimeout(r, i * 1000));
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("Network request to GitHub failed.");
  }

  private async post(path: string, body: unknown): Promise<Response> {
    return this.http(`${this.apiBase}${path}`, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  }

  private contentsUrl(path: string, ref?: string): string {
    const seg = encodePath(path);
    const url = new URL(`${this.apiBase}/repos/${this.fullName}/contents${seg ? `/${seg}` : ""}`);
    if (ref) url.searchParams.set("ref", ref);
    return url.toString();
  }

  async listFiles(path: string, ref?: string): Promise<GitEntry[]> {
    const res = await this.http(this.contentsUrl(path, ref), {
      headers: this.headers(),
      cache: "no-store",
    });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`GitHub contents ${res.status} for ${this.fullName}/${path}`);
    const body = (await res.json()) as unknown;
    const items = Array.isArray(body) ? body : [body];
    return items
      .filter(
        (e): e is { path: string; name: string; type: string } => !!e && typeof e === "object",
      )
      .map((e) => ({ path: e.path, name: e.name, type: e.type === "dir" ? "dir" : "file" }));
  }

  async readFile(path: string, ref?: string): Promise<string | null> {
    const res = await this.http(this.contentsUrl(path, ref), {
      headers: this.headers(),
      cache: "no-store",
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub read ${res.status} for ${this.fullName}/${path}`);
    const body = (await res.json()) as { type?: string; content?: string; encoding?: string };
    if (Array.isArray(body) || body.type !== "file" || typeof body.content !== "string")
      return null;
    return Buffer.from(body.content, body.encoding === "base64" ? "base64" : "utf8").toString(
      "utf8",
    );
  }

  private async refSha(branch: string): Promise<string | null> {
    const res = await this.http(
      `${this.apiBase}/repos/${this.fullName}/git/refs/heads/${encodePath(branch)}`,
      { headers: this.headers(), cache: "no-store" },
    );
    if (!res.ok) return null;
    const body = (await res.json()) as { object?: { sha?: string } };
    return body.object?.sha ?? null;
  }

  async ensureBranch(branch: string, fromRef?: string): Promise<{ created: boolean }> {
    if (await this.refSha(branch)) return { created: false };
    const baseSha = await this.refSha(fromRef || this.defaultBranch);
    if (!baseSha)
      throw new Error(
        `Could not read base branch "${fromRef || this.defaultBranch}" of ${this.fullName}`,
      );
    const res = await this.post(`/repos/${this.fullName}/git/refs`, {
      ref: `refs/heads/${branch}`,
      sha: baseSha,
    });
    if (!res.ok)
      throw new Error(
        `Could not create branch ${branch}: ${res.status} ${await res.text().catch(() => "")}`,
      );
    // GitHub's ref-read API can lag a beat behind the write that just
    // succeeded — a subsequent commitFiles() call can otherwise 404 on a
    // branch we just created. Poll briefly until it's actually readable.
    for (let attempt = 0; attempt < 5; attempt++) {
      if (await this.refSha(branch)) return { created: true };
      await new Promise((r) => setTimeout(r, 300));
    }
    return { created: true };
  }

  async commitFiles(args: {
    branch: string;
    message: string;
    files: CommitFile[];
  }): Promise<{ commitSha: string }> {
    const { branch, message, files } = args;

    // Blobs FIRST, once. Git blobs are content-addressed, so uploading them is
    // independent of which commit ends up referencing them — they survive a
    // retry below without being re-sent.
    const tree = await Promise.all(
      files.map(async (f) => {
        const blob = await this.post(`/repos/${this.fullName}/git/blobs`, {
          content: f.content,
          encoding: "utf-8",
        });
        if (!blob.ok) throw new Error(`Blob failed for ${f.path}: ${blob.status}`);
        const sha = ((await blob.json()) as { sha: string }).sha;
        return { path: f.path.replace(/^\/+/, ""), mode: "100644", type: "blob", sha };
      }),
    );

    // Read HEAD → build tree → commit → move ref, retrying when the branch
    // moves underneath us.
    //
    // WHY THE RETRY: this is a read-modify-write across many HTTP round-trips
    // (one per file, plus tree/commit/ref). If ANYTHING else pushes to the
    // branch in that window, the ref PATCH is rejected:
    //
    //     422 Update is not a fast forward
    //
    // …surfaced to the user as "the branch has diverged, sync your local repo
    // and try again" — advice that doesn't apply, since nothing here is local.
    // A deploy writes Dockerfiles, workflows and manifests for every service,
    // so the window is wide and a concurrent push (a teammate, CI's own commit
    // in GitOps mode, or a second deploy) is entirely ordinary.
    //
    // Re-reading HEAD and rebuilding on the new tip is exactly what a human
    // would do, and it PRESERVES the other commit: base_tree comes from the
    // NEW head, so their changes stay and ours layer on top. No force-push,
    // nothing overwritten.
    const MAX_ATTEMPTS = 4;
    let lastErr = "";
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      const headSha = await this.refSha(branch);
      if (!headSha)
        throw new Error(
          `Branch "${branch}" not found in ${this.fullName} — call ensureBranch first.`,
        );

      const commitRes = await this.http(
        `${this.apiBase}/repos/${this.fullName}/git/commits/${headSha}`,
        { headers: this.headers(), cache: "no-store" },
      );
      if (!commitRes.ok) throw new Error(`Could not read HEAD commit: ${commitRes.status}`);
      const baseTree = ((await commitRes.json()) as { tree: { sha: string } }).tree.sha;

      const treeRes = await this.post(`/repos/${this.fullName}/git/trees`, {
        base_tree: baseTree,
        tree,
      });
      if (!treeRes.ok)
        throw new Error(`Tree failed: ${treeRes.status} ${await treeRes.text().catch(() => "")}`);
      const newTree = ((await treeRes.json()) as { sha: string }).sha;

      const commit = await this.post(`/repos/${this.fullName}/git/commits`, {
        message,
        tree: newTree,
        parents: [headSha],
      });
      if (!commit.ok)
        throw new Error(`Commit failed: ${commit.status} ${await commit.text().catch(() => "")}`);
      const newCommitSha = ((await commit.json()) as { sha: string }).sha;

      const patch = await this.http(
        `${this.apiBase}/repos/${this.fullName}/git/refs/heads/${encodePath(branch)}`,
        {
          method: "PATCH",
          headers: { ...this.headers(), "Content-Type": "application/json" },
          body: JSON.stringify({ sha: newCommitSha }),
        },
      );
      if (patch.ok) return { commitSha: newCommitSha };

      const body = await patch.text().catch(() => "");
      lastErr = `${patch.status} ${body}`;
      // Only a stale-parent rejection is worth retrying. A 403 (protected
      // branch) or 404 (bad ref) will fail identically every time — retrying
      // just delays a clear error.
      const stale = /not a fast forward|fast-forward/i.test(body) || patch.status === 409;
      if (!stale || attempt === MAX_ATTEMPTS) break;
      // Brief backoff so a burst of concurrent writers doesn't lock-step.
      await new Promise((r) => setTimeout(r, 400 * attempt));
    }

    throw new Error(
      `Could not update branch ref after ${MAX_ATTEMPTS} attempts: ${lastErr}. ` +
        `The branch "${branch}" is being written to concurrently, or is protected against direct pushes.`,
    );
  }

  async openChangeRequest(args: {
    sourceBranch: string;
    targetBranch: string;
    title: string;
    body?: string;
  }): Promise<ChangeRequest> {
    const res = await this.post(`/repos/${this.fullName}/pulls`, {
      title: args.title,
      head: args.sourceBranch,
      base: args.targetBranch,
      body: args.body ?? "",
      maintainer_can_modify: true,
    });
    if (res.ok) {
      const j = (await res.json()) as { number: number; html_url: string };
      return { number: j.number, url: j.html_url };
    }
    // 422 "A pull request already exists" — e.g. a retried push after a network
    // blip. Idempotent: return the existing open PR for this branch instead.
    if (res.status === 422) {
      const owner = this.fullName.split("/")[0];
      const existing = await this.http(
        `${this.apiBase}/repos/${this.fullName}/pulls?state=open&head=${encodeURIComponent(`${owner}:${args.sourceBranch}`)}`,
        { headers: this.headers(), cache: "no-store" },
      );
      if (existing.ok) {
        const list = (await existing.json()) as Array<{ number: number; html_url: string }>;
        if (list[0]) return { number: list[0].number, url: list[0].html_url };
      }
    }
    throw new Error(
      `Could not open pull request: ${res.status} ${await res.text().catch(() => "")}`,
    );
  }
}
