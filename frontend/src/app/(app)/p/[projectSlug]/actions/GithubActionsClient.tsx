"use client";

/**
 * GitHub Actions tab — live view of every workflow run across the project's
 * attached repos, no matter who started it (app Run button, chat agent, git
 * push, GitHub UI). Polls the server every 15s so a freshly-started run shows
 * up here within one tick. Read-only by design: running/fixing stays with the
 * CI/CD tab's pipelines + the background review agent.
 */
import { useQuery } from "@tanstack/react-query";
import { Badge, Block, PageHead, StatusDot } from "@/components/ui";
import { api } from "@/lib/api/client";

type RunRow = {
  repoFullName: string;
  runId: number;
  runNumber: number;
  workflowName: string;
  workflowPath: string;
  branch: string;
  event: string;
  status: string;
  conclusion: string | null;
  htmlUrl: string;
  createdAt: string;
  updatedAt: string;
};
type Resp = { ok: boolean; runs: RunRow[]; warnings?: string[] };

function relativeTime(iso: string): string {
  if (!iso) return "";
  const sec = Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 1000));
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function runTone(r: RunRow): { tone: "ok" | "warn" | "danger" | "info"; label: string; pulse: boolean } {
  if (r.status !== "completed") return { tone: "info", label: r.status === "queued" ? "queued" : "running", pulse: true };
  switch (r.conclusion) {
    case "success":
      return { tone: "ok", label: "success", pulse: false };
    case "failure":
      return { tone: "danger", label: "failed", pulse: false };
    case "cancelled":
      return { tone: "warn", label: "cancelled", pulse: false };
    case "skipped":
      return { tone: "warn", label: "skipped", pulse: false };
    default:
      return { tone: "warn", label: r.conclusion ?? "done", pulse: false };
  }
}

export function GithubActionsClient({ slug }: { slug: string }) {
  const q = useQuery<Resp>({
    queryKey: ["p", slug, "actions-runs"],
    queryFn: () => api.get<Resp>(`/projects/${slug}/actions-runs`),
    refetchInterval: 15_000,
    staleTime: 10_000,
  });
  const runs = q.data?.runs ?? [];
  const running = runs.filter((r) => r.status !== "completed").length;

  return (
    <div className="col gap-5">
      <PageHead
        title="GitHub Actions"
        sub={
          running > 0
            ? `${running} run${running === 1 ? "" : "s"} in progress — auto-refreshes every 15s. Failures are auto-reviewed by the agent.`
            : "Every workflow run across this project's repos, from any trigger. Auto-refreshes every 15s."
        }
      />

      <Block>
        <Block.Header>
          <Block.Title sub="Newest first. Click a run to open it on GitHub.">Recent runs</Block.Title>
        </Block.Header>
        <Block.Body>
          {q.isLoading ? (
            <Block.Loading />
          ) : runs.length === 0 ? (
            <Block.Empty
              title="No runs yet"
              description="Trigger a pipeline from the CI/CD tab (or push to a repo with a push-triggered workflow) and it will appear here."
            />
          ) : (
            <div className="col gap-2">
              {runs.map((r) => {
                const t = runTone(r);
                return (
                  <a
                    key={`${r.repoFullName}-${r.runId}`}
                    href={r.htmlUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="row gap-3"
                    style={{
                      alignItems: "center",
                      border: "1px solid var(--border)",
                      borderRadius: 10,
                      padding: "10px 14px",
                      textDecoration: "none",
                      color: "inherit",
                    }}
                  >
                    <StatusDot tone={t.tone} pulse={t.pulse} />
                    <div className="col" style={{ gap: 2, flex: 1, minWidth: 0 }}>
                      <span className="row gap-2" style={{ alignItems: "center", flexWrap: "wrap" }}>
                        <b style={{ fontSize: 13 }}>{r.workflowName}</b>
                        <span className="faint" style={{ fontSize: 11.5 }}>
                          #{r.runNumber}
                        </span>
                        <Badge tone={t.tone}>{t.label}</Badge>
                      </span>
                      <span className="muted" style={{ fontSize: 11.5 }}>
                        {r.repoFullName}
                        {r.branch ? ` · ${r.branch}` : ""}
                        {r.event ? ` · ${r.event}` : ""}
                      </span>
                    </div>
                    <span className="faint" style={{ fontSize: 11.5, flex: "none" }}>
                      {relativeTime(r.createdAt)}
                    </span>
                  </a>
                );
              })}
            </div>
          )}
          {(q.data?.warnings?.length ?? 0) > 0 && (
            <p className="faint" style={{ fontSize: 11.5, marginTop: 10 }}>
              Some repos couldn&apos;t be read: {q.data!.warnings!.join("; ")}
            </p>
          )}
        </Block.Body>
      </Block>
    </div>
  );
}
