"use client";

/**
 * Cost optimization — proactive savings recommendations computed from real
 * cluster utilization + the cloud cost breakdown (idle capacity, idle nodes,
 * biggest cost drivers). No LLM required.
 */
import { useMutation } from "@tanstack/react-query";
import { Badge, Block, Btn } from "@/components/ui";
import { api, apiErrorMessage } from "@/lib/api/client";

type Rec = {
  id: string;
  severity: "high" | "medium" | "low";
  title: string;
  detail: string;
  estimate?: string;
};
type Driver = { service: string; cents: number; pct: number };
type Report = { ok: true; recommendations: Rec[]; drivers: Driver[]; currency: string };

const TONE = { high: "danger", medium: "warn", low: "default" } as const;

export function CostOptimizationPanel({ slug }: { slug: string }) {
  const analyze = useMutation({
    mutationFn: () => api.post<Report>(`/projects/${slug}/cost/optimize`, {}),
  });
  const data = analyze.data;

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Find savings from your real cluster utilization + cost breakdown — idle capacity, idle nodes, biggest cost drivers.">
          Cost optimization
        </Block.Title>
        <Block.Actions>
          <Btn
            variant="primary"
            icon="bot"
            loading={analyze.isPending}
            onClick={() => analyze.mutate()}
          >
            {analyze.isPending ? "Analysing…" : "Analyse savings"}
          </Btn>
        </Block.Actions>
      </Block.Header>
      <Block.Body>
        {analyze.isError ? (
          <span style={{ color: "var(--danger, #e5484d)", fontSize: 12.5 }}>
            ❌ {apiErrorMessage(analyze.error)}
          </span>
        ) : !data ? (
          <span className="muted" style={{ fontSize: 13 }}>
            Click “Analyse savings” to scan this project for cost-reduction opportunities.
          </span>
        ) : (
          <div className="col gap-3">
            {data.recommendations.map((r) => (
              <div
                key={r.id}
                className="col gap-1"
                style={{ borderLeft: `3px solid var(--border)`, paddingLeft: 12 }}
              >
                <span className="row gap-2 wrap" style={{ alignItems: "center" }}>
                  <Badge tone={TONE[r.severity]} withDot>
                    {r.severity}
                  </Badge>
                  <strong style={{ fontSize: 13.5 }}>{r.title}</strong>
                  {r.estimate && <Badge tone="info">{r.estimate}</Badge>}
                </span>
                <span className="muted" style={{ fontSize: 12.5 }}>
                  {r.detail}
                </span>
              </div>
            ))}

            {data.drivers.length > 0 && (
              <div
                className="col gap-1"
                style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}
              >
                <span
                  className="faint"
                  style={{
                    fontSize: 11,
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.05em",
                  }}
                >
                  Top cost drivers
                </span>
                {data.drivers.map((d) => (
                  <div
                    key={d.service}
                    className="row between"
                    style={{ fontSize: 12.5, padding: "2px 0" }}
                  >
                    <span>{d.service}</span>
                    <span className="muted">
                      {new Intl.NumberFormat(undefined, {
                        style: "currency",
                        currency: data.currency || "USD",
                      }).format(d.cents / 100)}{" "}
                      · {d.pct}%
                    </span>
                  </div>
                ))}
              </div>
            )}
          </div>
        )}
      </Block.Body>
    </Block>
  );
}
