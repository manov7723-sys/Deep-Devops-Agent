"use client";

import Link from "next/link";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import type { Route } from "next";
import { useState } from "react";
import { Badge, Block, Btn, Icon, PageHead } from "@/components/ui";
import { EnvFilter, type EnvFilterValue } from "@/components/domain/EnvFilter";
import { ApprovalQueueRow } from "@/components/domain/ApprovalQueueRow";
import {
  useApprovalDecision,
  useApprovalDetail,
  useProjectApprovals,
} from "@/hooks/queries/project";

const ENV_TONE: Record<string, "ok" | "warn" | "info" | "default"> = {
  release: "ok",
  beta: "warn",
  alpha: "info",
};

function riskTone(risk: "high" | "medium" | "low"): "danger" | "warn" | "ok" {
  return risk === "high" ? "danger" : risk === "medium" ? "warn" : "ok";
}

const DIFF_COLOR: Record<string, string> = {
  add: "var(--ok)",
  remove: "var(--danger)",
  comment: "var(--text-faint)",
};

function timeAgo(iso: string | null | undefined): string {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (!Number.isFinite(t)) return "—";
  const s = Math.floor((Date.now() - t) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86_400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86_400)}d ago`;
}

export function ProjectApprovalsClient({ slug }: { slug: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const env = (sp.get("env") as EnvFilterValue | null) ?? "all";

  const { data: list } = useProjectApprovals(slug);
  const filtered =
    list?.filter((a) => {
      if (env === "all") return true;
      const key =
        (a as unknown as { envKey?: string; env?: string }).envKey ??
        (a as unknown as { env?: string }).env;
      return key === env;
    }) ?? [];
  const activeId = sp.get("id") ?? filtered[0]?.id ?? null;
  const { data: detail } = useApprovalDetail(slug, activeId);
  const decide = useApprovalDecision(slug);
  const [decisions, setDecisions] = useState<Record<string, "approve" | "reject" | null>>({});

  function selectId(id: string) {
    const p = new URLSearchParams(sp);
    p.set("id", id);
    router.replace(`${pathname}?${p.toString()}` as Route);
  }

  async function act(id: string, decision: "approve" | "reject") {
    setDecisions((s) => ({ ...s, [id]: decision }));
    try {
      await decide.mutateAsync({ id, decision });
    } catch {
      setDecisions((s) => ({ ...s, [id]: null }));
    }
  }

  const pending = filtered.filter((a) => !decisions[a.id]).length;

  return (
    <div className="col gap-5">
      <PageHead
        title="Approvals"
        sub="Human-in-the-loop gates. Deep Agent waits for you on risky moves."
        actions={
          <Badge tone="warn" icon="clock">
            {pending} pending
          </Badge>
        }
      />
      <EnvFilter />

      <div className="dda-approvals-grid">
        <Block>
          <Block.Header>
            <Block.Title>Queue</Block.Title>
          </Block.Header>
          {list ? (
            filtered.length === 0 ? (
              <Block.Empty
                icon="approve"
                title="No approvals for this filter"
                description="Switch envs or wait for the next agent request."
              />
            ) : (
              <div className="col">
                {filtered.map((a) => (
                  <ApprovalQueueRow
                    key={a.id}
                    approval={a}
                    active={activeId === a.id}
                    decision={decisions[a.id] ?? null}
                    onSelect={selectId}
                  />
                ))}
              </div>
            )
          ) : (
            <Block.Loading />
          )}
        </Block>

        {detail ? (
          (() => {
            const d = detail as unknown as {
              id: string;
              title: string;
              summary: string | null;
              risk: "high" | "medium" | "low";
              agent?: string;
              requestedRelative?: string;
              requestedAt?: string;
              repo?: string;
              env?: string;
              envKey?: string;
              changes?: string;
              changesSummary?: string | null;
              diff?: ReadonlyArray<{ kind: string; text: string }>;
            };
            const requester = d.agent ?? "Deep Agent";
            const requested = d.requestedRelative ?? timeAgo(d.requestedAt);
            const envKey = d.envKey ?? d.env ?? "—";
            const changesLabel = d.changes ?? d.changesSummary ?? "Pending review";
            const repoLabel = d.repo ?? "Linked repo";
            const diffLines = d.diff ?? [];
            return (
              <Block>
                <Block.Body>
                  <div className="col gap-4">
                    <div className="row between wrap gap-2">
                      <Badge tone={riskTone(detail.risk)} icon="alert">
                        {detail.risk} risk
                      </Badge>
                      <span className="row gap-2 faint" style={{ fontSize: 12 }}>
                        <Icon name="bot" size={14} />
                        Requested by {requester} · {requested}
                      </span>
                    </div>
                    <h2 style={{ fontSize: 19, fontWeight: 800, lineHeight: 1.25 }}>
                      {detail.title}
                    </h2>
                    <p className="muted tx-pretty" style={{ fontSize: 14, lineHeight: 1.55 }}>
                      {detail.summary}
                    </p>
                    <div className="row gap-2 wrap">
                      <Badge icon="github">{repoLabel}</Badge>
                      <Badge tone={ENV_TONE[envKey] ?? "default"}>{envKey}</Badge>
                      <Badge icon="edit">{changesLabel}</Badge>
                    </div>
                    <div className="dda-approval-diff">
                      <div className="dda-approval-diff-head">
                        <span style={{ fontSize: 11.5 }} className="muted">
                          terraform plan
                        </span>
                        <Badge tone="ok">{changesLabel}</Badge>
                      </div>
                      <pre>
                        {diffLines.length === 0 ? (
                          <span className="faint" style={{ fontSize: 12 }}>
                            No diff attached to this approval.
                          </span>
                        ) : (
                          diffLines.map((line, i) => (
                            <span
                              key={i}
                              style={{
                                color: DIFF_COLOR[line.kind] ?? "inherit",
                                display: "block",
                              }}
                            >
                              {line.text}
                            </span>
                          ))
                        )}
                      </pre>
                    </div>
                    {decisions[detail.id] ? (
                      <div
                        className="row gap-2 dda-approval-result"
                        style={{
                          padding: 14,
                          borderRadius: 10,
                          background:
                            decisions[detail.id] === "approve"
                              ? "var(--ok-soft)"
                              : "var(--danger-soft)",
                          color: decisions[detail.id] === "approve" ? "var(--ok)" : "var(--danger)",
                          fontWeight: 700,
                          fontSize: 13.5,
                        }}
                      >
                        <Icon name={decisions[detail.id] === "approve" ? "check" : "x"} size={18} />
                        {decisions[detail.id] === "approve"
                          ? "Approved — Deep Agent is applying the change."
                          : "Rejected — Deep Agent will revise and resubmit."}
                      </div>
                    ) : (
                      <div className="row gap-2 wrap">
                        <Btn
                          variant="primary"
                          icon="approve"
                          onClick={() => act(detail.id, "approve")}
                        >
                          Approve &amp; apply
                        </Btn>
                        <Btn variant="danger" icon="x" onClick={() => act(detail.id, "reject")}>
                          Reject
                        </Btn>
                        <Link href={`/p/${slug}/chat` as Route} className="btn outline">
                          <Icon name="chat" size={16} />
                          Ask a question
                        </Link>
                      </div>
                    )}
                  </div>
                </Block.Body>
              </Block>
            );
          })()
        ) : activeId ? (
          <Block>
            <Block.Loading />
          </Block>
        ) : (
          <Block>
            <Block.Empty
              icon="approve"
              title="Select an approval"
              description="Pick one from the queue to see the diff."
            />
          </Block>
        )}
      </div>
    </div>
  );
}
