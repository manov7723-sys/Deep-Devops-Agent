"use client";

/**
 * Inline approve/reject card for a single Approval — lets the user confirm a
 * pending infra change or production deploy without leaving chat. Uses the
 * same generic Approval API the standalone /approvals page uses. Rendered
 * via the ```approval-card``` fence with a `{"approvalId":"..."}` payload.
 */
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Badge, Block, Btn, Icon } from "@/components/ui";
import { api, apiErrorMessage } from "@/lib/api/client";

type DiffLine = { kind: "add" | "remove" | "comment"; text: string; order: number };
type ApprovalRow = {
  id: string;
  envKey: string;
  title: string;
  summary: string | null;
  changesSummary: string | null;
  risk: "low" | "medium" | "high";
  status: "pending" | "approved" | "rejected";
  decidedByName: string | null;
  requestedAt: string;
  decidedAt: string | null;
  diff: DiffLine[];
};
type DecisionResponse = {
  ok: boolean;
  approval: ApprovalRow;
  apply?: { applied: boolean; runId?: string; error?: string };
};

const RISK_TONE = { low: "ok", medium: "warn", high: "danger" } as const;

export function ApprovalCard({ slug, approvalId }: { slug: string; approvalId: string }) {
  const qc = useQueryClient();
  const q = useQuery<ApprovalRow>({
    queryKey: ["p", slug, "approval", approvalId],
    queryFn: () => api.get<ApprovalRow>(`/projects/${slug}/approvals/${approvalId}`),
    refetchInterval: (query) => (query.state.data?.status === "pending" ? 4000 : false),
  });

  const decide = useMutation({
    mutationFn: (decision: "approve" | "reject") =>
      api.post<DecisionResponse>(`/projects/${slug}/approvals/${approvalId}/decision`, {
        decision,
      }),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["p", slug, "approval", approvalId] });
      qc.invalidateQueries({ queryKey: ["p", slug] });
    },
  });

  if (q.isLoading) {
    return (
      <Block>
        <Block.Body>
          <span className="muted" style={{ fontSize: 13 }}>
            Loading approval…
          </span>
        </Block.Body>
      </Block>
    );
  }
  if (!q.data) {
    return (
      <Block>
        <Block.Body>
          <span style={{ fontSize: 13, color: "var(--danger)" }}>
            Couldn&apos;t load that approval.
          </span>
        </Block.Body>
      </Block>
    );
  }

  const a = q.data;
  const result = decide.data;

  return (
    <Block>
      <Block.Header>
        <Block.Title sub={a.summary ?? undefined}>
          <span className="row gap-2" style={{ alignItems: "center" }}>
            <Icon name="approve" size={16} /> {a.title}
          </span>
        </Block.Title>
      </Block.Header>
      <Block.Body>
        <div className="col gap-3" style={{ maxWidth: 560 }}>
          <div className="row gap-2 wrap" style={{ alignItems: "center" }}>
            <Badge tone={RISK_TONE[a.risk]} withDot>
              {a.risk} risk
            </Badge>
            <Badge
              tone={a.status === "pending" ? "warn" : a.status === "approved" ? "ok" : "danger"}
            >
              {a.status}
            </Badge>
            <span className="muted" style={{ fontSize: 12.5 }}>
              env: {a.envKey}
            </span>
            {a.changesSummary && (
              <span className="muted" style={{ fontSize: 12.5 }}>
                · {a.changesSummary}
              </span>
            )}
          </div>

          {a.diff.length > 0 && (
            <div
              className="col gap-1 mono"
              style={{
                fontSize: 12,
                border: "1px solid var(--border)",
                borderRadius: 8,
                padding: 10,
                maxHeight: 220,
                overflowY: "auto",
              }}
            >
              {a.diff
                .slice()
                .sort((x, y) => x.order - y.order)
                .map((d, i) => (
                  <div
                    key={i}
                    style={{
                      color:
                        d.kind === "add"
                          ? "var(--ok, #2f9e44)"
                          : d.kind === "remove"
                            ? "var(--danger, #e5484d)"
                            : "var(--muted)",
                    }}
                  >
                    {d.kind === "add" ? "+ " : d.kind === "remove" ? "- " : "  "}
                    {d.text}
                  </div>
                ))}
            </div>
          )}

          {a.status === "pending" ? (
            <div className="col gap-2">
              <div className="row gap-2">
                <Btn
                  variant="primary"
                  icon="check"
                  loading={decide.isPending}
                  onClick={() => decide.mutate("approve")}
                >
                  Approve &amp; apply
                </Btn>
                <Btn
                  variant="outline"
                  icon="x"
                  loading={decide.isPending}
                  onClick={() => decide.mutate("reject")}
                >
                  Reject
                </Btn>
              </div>
              {decide.isError && (
                <span style={{ fontSize: 12.5, color: "var(--danger)" }}>
                  {apiErrorMessage(decide.error, "Could not record decision.")}
                </span>
              )}
              {result?.apply && (
                <span
                  style={{
                    fontSize: 12.5,
                    color: result.apply.applied ? "var(--ok, #2f9e44)" : "var(--danger)",
                  }}
                >
                  {result.apply.applied
                    ? "Applying…"
                    : `Apply failed: ${result.apply.error ?? "unknown error"}`}
                </span>
              )}
            </div>
          ) : (
            <span className="muted" style={{ fontSize: 12.5 }}>
              {a.status === "approved" ? "Approved" : "Rejected"}
              {a.decidedByName ? ` by ${a.decidedByName}` : ""}
              {a.decidedAt ? ` · ${new Date(a.decidedAt).toLocaleString()}` : ""}
            </span>
          )}
        </div>
      </Block.Body>
    </Block>
  );
}
