"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import type { Route } from "next";
import { useEffect, useMemo, useState } from "react";
import type { ColumnDef } from "@tanstack/react-table";
import { RunCiPipelineModal } from "@/components/modals/RunCiPipelineModal";
import { AttachReposModal } from "@/components/modals/AttachReposModal";
import { Badge, Block, Btn, DataTable, Icon, PageHead, TileGrid } from "@/components/ui";
import { CiPipelinesPanel } from "@/components/domain/CiPipelinesPanel";
import { useProjectIssues, useProjectRepos, useDetachRepo } from "@/hooks/queries/project";
import type { SeedIssue } from "@/lib/legacy-types";

type TabId = "pipelines" | "repos" | "issues";

const LANG_COLOR: Record<string, string> = {
  HCL: "#7B42BC",
  YAML: "#cb171e",
  TypeScript: "#3178c6",
  Python: "#3572A5",
};

const KIND_TONE: Record<string, "accent" | "info" | "default"> = {
  Terraform: "accent",
  Kubernetes: "info",
  Service: "default",
  Frontend: "default",
  Worker: "default",
};

export function ProjectCicdClient({ slug }: { slug: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const tab = (sp.get("tab") as TabId | null) ?? "pipelines";

  const { data: repos } = useProjectRepos(slug);
  const detach = useDetachRepo(slug);
  const [detachError, setDetachError] = useState<string | null>(null);
  const { data: issues, isLoading: issuesLoading } = useProjectIssues(slug);
  const [runPipelineOpen, setRunPipelineOpen] = useState(false);
  const [attachReposOpen, setAttachReposOpen] = useState(false);

  // "Deploy now" buttons on other pages navigate here with `?trigger=1`. Open
  // the modal, then strip the flag from the URL so the modal doesn't re-open
  // on a manual close+reopen of the page.
  useEffect(() => {
    if (sp.get("trigger") !== "1") return;
    setRunPipelineOpen(true);
    const next = new URLSearchParams(sp);
    next.delete("trigger");
    const q = next.toString();
    router.replace((q ? `${pathname}?${q}` : pathname) as Route);
    // We deliberately omit dependencies so this fires only on initial mount
    // for a given URL — once trigger is stripped, the effect won't loop.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const attachedFullNames = useMemo(
    () => new Set((repos ?? []).map((r) => r.fullName ?? r.name)),
    [repos],
  );

  const issueColumns = useMemo<ColumnDef<SeedIssue>[]>(
    () => [
      {
        id: "issue",
        header: "Issue",
        cell: ({ row }) => (
          <div className="col" style={{ lineHeight: 1.35, maxWidth: 360 }}>
            <span style={{ fontWeight: 600 }}>
              #{row.original.id} {row.original.title}
            </span>
            <span className="faint" style={{ fontSize: 11.5 }}>
              {row.original.note}
            </span>
          </div>
        ),
      },
      {
        id: "repo",
        header: "Repo",
        cell: ({ row }) => (
          <span className="mono" style={{ fontSize: 12 }}>
            {row.original.repo}
          </span>
        ),
      },
      {
        id: "reviewer",
        header: "Reviewer",
        cell: ({ row }) => <Badge icon="bot">{row.original.agent}</Badge>,
      },
      {
        id: "verdict",
        header: "Verdict",
        cell: ({ row }) =>
          row.original.verdict === "passed" ? (
            <Badge tone="ok" icon="check">
              Passed
            </Badge>
          ) : (
            <Badge tone="warn" icon="alert">
              Needs changes
            </Badge>
          ),
      },
      {
        id: "state",
        header: "State",
        cell: ({ row }) => (
          <Badge
            tone={
              row.original.state === "closed"
                ? "ok"
                : row.original.state === "reopened"
                  ? "danger"
                  : "default"
            }
          >
            {row.original.state}
          </Badge>
        ),
      },
      {
        id: "open",
        header: "",
        cell: () => (
          <Btn size="sm" variant="ghost" iconRight="chevR">
            Open
          </Btn>
        ),
      },
    ],
    [],
  );

  function setTab(next: TabId) {
    const p = new URLSearchParams(sp);
    p.set("tab", next);
    const q = p.toString();
    router.replace((q ? `${pathname}?${q}` : pathname) as Route);
  }

  return (
    <div className="col gap-5">
      <PageHead
        title="CI/CD & Repositories"
        sub="Pipelines, builds and connected GitHub repos."
        actions={
          <>
            <Btn variant="outline" icon="github" onClick={() => setAttachReposOpen(true)}>
              Attach repos
            </Btn>
            <Btn variant="primary" icon="play" onClick={() => setRunPipelineOpen(true)}>
              Run pipeline
            </Btn>
          </>
        }
        tabs={[
          { value: "pipelines", label: "Pipelines" },
          { value: "repos", label: "Repositories" },
          { value: "issues", label: "Agent reviews" },
        ]}
        tabValue={tab}
        onTabChange={(v) => setTab(v as TabId)}
      />

      {tab === "pipelines" && <CiPipelinesPanel slug={slug} />}

      {tab === "repos" && (
        <>
          {detachError && (
            <p
              role="alert"
              style={{
                padding: "10px 14px",
                fontSize: 12.5,
                color: "var(--danger)",
                background: "var(--danger-soft)",
                borderRadius: 8,
                marginBottom: 12,
              }}
            >
              {detachError}
            </p>
          )}
          <TileGrid minTile={280}>
            {(repos ?? []).map((r) => {
              // Build the upstream GitHub URL when fullName is "owner/repo".
              const ghHref = r.fullName ? `https://github.com/${r.fullName}` : undefined;
              return (
                <div key={r.id} className="card card-pad col gap-3">
                  <div className="row between">
                    <div className="row gap-2" style={{ minWidth: 0 }}>
                      <Icon name="github" size={18} />
                      <span style={{ fontWeight: 700, fontSize: 14 }}>{r.name}</span>
                    </div>
                    <Badge tone={KIND_TONE[r.kind] ?? "default"}>{r.kind}</Badge>
                  </div>
                  <p className="muted" style={{ fontSize: 12.5, lineHeight: 1.45, minHeight: 36 }}>
                    {r.desc}
                  </p>
                  <div className="row gap-3 faint" style={{ fontSize: 11.5 }}>
                    <span className="row gap-1">
                      <Icon name="commit" size={13} /> {r.lastCommit}
                    </span>
                    <span className="row gap-1">
                      <Icon name="branch" size={13} /> {r.branch}
                    </span>
                  </div>
                  <div className="divider" />
                  <div className="row between">
                    <div className="row gap-3" style={{ fontSize: 12 }}>
                      <span className="row gap-1">
                        <span
                          style={{
                            width: 9,
                            height: 9,
                            borderRadius: 99,
                            background: LANG_COLOR[r.lang] ?? "#888",
                            display: "inline-block",
                          }}
                        />
                        {r.lang}
                      </span>
                      <span className="muted">{r.issues} issues</span>
                      <span className="muted">{r.prs} PRs</span>
                    </div>
                    <div className="row gap-1">
                      {ghHref && (
                        <a
                          href={ghHref}
                          target="_blank"
                          rel="noreferrer"
                          className="btn ghost sm"
                          aria-label="Open in GitHub"
                          title="Open in GitHub"
                        >
                          <Icon name="ext" size={14} />
                        </a>
                      )}
                      <Btn
                        size="sm"
                        variant="ghost"
                        icon="trash"
                        aria-label={`Remove ${r.name} from project`}
                        title="Remove from project"
                        loading={detach.isPending && detach.variables === r.id}
                        onClick={async () => {
                          setDetachError(null);
                          const label = r.fullName ?? r.name;
                          if (
                            !confirm(
                              `Remove ${label} from this project?\n\nThe repo itself stays connected — it just gets unlinked from this project. Pipelines and approvals tied to it stop firing.`,
                            )
                          ) {
                            return;
                          }
                          try {
                            await detach.mutateAsync(r.id);
                          } catch (e) {
                            setDetachError(
                              e instanceof Error ? e.message : "Could not remove repo.",
                            );
                          }
                        }}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </TileGrid>
        </>
      )}

      {tab === "issues" && (
        <Block>
          <Block.Header>
            <Block.Title>GitHub issues reviewed by agents</Block.Title>
            <Block.Actions>
              <Badge icon="bot">Auto-review on</Badge>
            </Block.Actions>
          </Block.Header>
          <DataTable
            data={issues ?? []}
            columns={issueColumns}
            loading={issuesLoading}
            rowKey={(i) => String(i.id)}
            emptyTitle="No reviewed issues yet"
            emptyIcon="github"
          />
        </Block>
      )}

      <RunCiPipelineModal
        open={runPipelineOpen}
        onOpenChange={setRunPipelineOpen}
        projectSlug={slug}
      />
      <AttachReposModal
        open={attachReposOpen}
        onOpenChange={setAttachReposOpen}
        projectSlug={slug}
        alreadyAttachedFullNames={attachedFullNames}
      />
    </div>
  );
}
