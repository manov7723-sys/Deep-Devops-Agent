/**
 * GitLab implementation of GitRepoClient — talks to the GitLab REST API
 * ({instance}/api/v4). Uses the numeric project id when available (survives
 * renames and avoids %2F encoding); otherwise the URL-encoded path_with_namespace.
 */
import type { ChangeRequest, CommitFile, GitEntry, GitRepoClient } from "./types";

type GitlabTreeEntry = { id: string; name: string; type: "tree" | "blob"; path: string };

export class GitlabRepoClient implements GitRepoClient {
  readonly provider = "gitlab" as const;
  readonly fullName: string;
  readonly defaultBranch: string;
  private readonly token: string;
  private readonly apiBase: string;
  private readonly webBase: string;
  private readonly projectId: string;

  constructor(opts: {
    token: string;
    fullName: string;
    defaultBranch: string;
    apiBase: string;
    /** GitLab numeric project id (preferred). Empty → fall back to encoded path. */
    projectId?: string | null;
    /** Instance base URL for web links (no trailing slash). */
    webBase: string;
  }) {
    this.token = opts.token;
    this.fullName = opts.fullName;
    this.defaultBranch = opts.defaultBranch;
    this.apiBase = opts.apiBase.replace(/\/+$/, "");
    this.webBase = opts.webBase.replace(/\/+$/, "");
    this.projectId = opts.projectId || "";
  }

  webUrl(): string {
    return `${this.webBase}/${this.fullName}`;
  }

  cloneUrlWithToken(): string {
    const host = this.webBase.replace(/^https?:\/\//, "");
    return `https://oauth2:${this.token}@${host}/${this.fullName}.git`;
  }

  /** Project identifier for the API path: numeric id, or url-encoded full path. */
  private pid(): string {
    return this.projectId || encodeURIComponent(this.fullName);
  }

  private headers(): Record<string, string> {
    return { Authorization: `Bearer ${this.token}`, Accept: "application/json" };
  }

  async listFiles(path: string, ref?: string): Promise<GitEntry[]> {
    const url = new URL(`${this.apiBase}/projects/${this.pid()}/repository/tree`);
    if (path) url.searchParams.set("path", path);
    url.searchParams.set("ref", ref || this.defaultBranch);
    url.searchParams.set("per_page", "100");
    const res = await fetch(url.toString(), { headers: this.headers(), cache: "no-store" });
    if (res.status === 404) return [];
    if (!res.ok) throw new Error(`GitLab tree ${res.status} for ${this.fullName}/${path}`);
    const rows = (await res.json()) as GitlabTreeEntry[];
    return rows.map((e) => ({
      path: e.path,
      name: e.name,
      type: e.type === "tree" ? "dir" : "file",
    }));
  }

  async readFile(path: string, ref?: string): Promise<string | null> {
    // The whole file path is a single URL-encoded segment for this endpoint.
    const enc = encodeURIComponent(path);
    const url = `${this.apiBase}/projects/${this.pid()}/repository/files/${enc}/raw?ref=${encodeURIComponent(ref || this.defaultBranch)}`;
    const res = await fetch(url, { headers: this.headers(), cache: "no-store" });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitLab read ${res.status} for ${this.fullName}/${path}`);
    return await res.text();
  }

  private async fileExists(path: string, ref: string): Promise<boolean> {
    const enc = encodeURIComponent(path);
    const url = `${this.apiBase}/projects/${this.pid()}/repository/files/${enc}?ref=${encodeURIComponent(ref)}`;
    const res = await fetch(url, { method: "HEAD", headers: this.headers(), cache: "no-store" });
    return res.ok;
  }

  async ensureBranch(branch: string, fromRef?: string): Promise<{ created: boolean }> {
    const check = await fetch(
      `${this.apiBase}/projects/${this.pid()}/repository/branches/${encodeURIComponent(branch)}`,
      { headers: this.headers(), cache: "no-store" },
    );
    if (check.ok) return { created: false };

    const url = new URL(`${this.apiBase}/projects/${this.pid()}/repository/branches`);
    url.searchParams.set("branch", branch);
    url.searchParams.set("ref", fromRef || this.defaultBranch);
    const res = await fetch(url.toString(), { method: "POST", headers: this.headers() });
    if (!res.ok)
      throw new Error(
        `Could not create branch ${branch}: ${res.status} ${await res.text().catch(() => "")}`,
      );
    return { created: true };
  }

  async commitFiles(args: {
    branch: string;
    message: string;
    files: CommitFile[];
  }): Promise<{ commitSha: string }> {
    const { branch, message, files } = args;
    // GitLab has no upsert action, so classify each path as create vs update.
    const actions = await Promise.all(
      files.map(async (f) => {
        const path = f.path.replace(/^\/+/, "");
        const exists = await this.fileExists(path, branch);
        return { action: exists ? "update" : "create", file_path: path, content: f.content };
      }),
    );
    const res = await fetch(`${this.apiBase}/projects/${this.pid()}/repository/commits`, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ branch, commit_message: message, actions }),
    });
    if (!res.ok)
      throw new Error(`GitLab commit failed: ${res.status} ${await res.text().catch(() => "")}`);
    const j = (await res.json()) as { id: string };
    return { commitSha: j.id };
  }

  async openChangeRequest(args: {
    sourceBranch: string;
    targetBranch: string;
    title: string;
    body?: string;
  }): Promise<ChangeRequest> {
    const res = await fetch(`${this.apiBase}/projects/${this.pid()}/merge_requests`, {
      method: "POST",
      headers: { ...this.headers(), "Content-Type": "application/json" },
      body: JSON.stringify({
        source_branch: args.sourceBranch,
        target_branch: args.targetBranch,
        title: args.title,
        description: args.body ?? "",
      }),
    });
    if (!res.ok)
      throw new Error(
        `Could not open merge request: ${res.status} ${await res.text().catch(() => "")}`,
      );
    const j = (await res.json()) as { iid: number; web_url: string };
    return { number: j.iid, url: j.web_url };
  }
}
