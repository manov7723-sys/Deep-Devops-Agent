/**
 * Provider-neutral git repo client. One interface, two implementations
 * (GitHub + GitLab), so agent tools and automation read/write a repo without
 * caring which host it lives on. Built from a Repo row + a resolved token via
 * `resolveRepoClient()` in ./index.
 *
 * This first cut covers the READ surface (list + read files) used by the
 * discovery/analysis tools. Write operations (branch, commit, open PR/MR) are
 * added in the write-paths phase.
 */
export type GitProviderKind = "github" | "gitlab";

export type GitEntry = {
  /** Full path from repo root, e.g. "src/index.ts". */
  path: string;
  /** Last path segment, e.g. "index.ts". */
  name: string;
  type: "file" | "dir";
};

export type CommitFile = { path: string; content: string };

/** A pull request (GitHub) or merge request (GitLab). `number` is the GitLab MR iid. */
export type ChangeRequest = { number: number; url: string };

export interface GitRepoClient {
  readonly provider: GitProviderKind;
  readonly fullName: string;
  readonly defaultBranch: string;

  /** Repo landing page (github.com/o/r or {instance}/group/sub/repo). */
  webUrl(): string;

  /** HTTPS clone URL with the token embedded (x-access-token@ / oauth2@). */
  cloneUrlWithToken(): string;

  /** Entries directly under `path` ("" = repo root). Empty array if the path 404s. */
  listFiles(path: string, ref?: string): Promise<GitEntry[]>;

  /** Decoded UTF-8 file contents, or null if the file doesn't exist. */
  readFile(path: string, ref?: string): Promise<string | null>;

  /** Create `branch` from `fromRef` (default branch if omitted) if it doesn't exist. */
  ensureBranch(branch: string, fromRef?: string): Promise<{ created: boolean }>;

  /** Commit one or more files to `branch` in a single commit. Creates/updates each path. */
  commitFiles(args: { branch: string; message: string; files: CommitFile[] }): Promise<{ commitSha: string }>;

  /** Open a PR (GitHub) / MR (GitLab) from `sourceBranch` → `targetBranch`. */
  openChangeRequest(args: {
    sourceBranch: string;
    targetBranch: string;
    title: string;
    body?: string;
  }): Promise<ChangeRequest>;
}
