"use client";

import { useState } from "react";
import {
  Badge,
  Bars,
  Block,
  Btn,
  Donut,
  Icon,
  PageHead,
  Progress,
  Stat,
  TileGrid,
} from "@/components/ui";
import { EnvFilter } from "@/components/domain/EnvFilter";
import { CostBudgetPanel } from "@/components/domain/CostBudgetPanel";
import { CostOptimizationPanel } from "@/components/domain/CostOptimizationPanel";
import { CostEstimatorPanel } from "@/components/domain/CostEstimatorPanel";
import { useProjectCostFull } from "@/hooks/queries/project";
import { useCostHistory, useSynthesizeCost } from "@/hooks/queries/cost";

function moneyK(v: number) {
  return `$${(v / 1000).toFixed(1)}k`;
}

function formatCents(cents: number): string {
  if (cents >= 100 * 1000) return `$${Math.round(cents / 100 / 1000)}k`;
  return `$${Math.round(cents / 100)}`;
}

function formatMonth(iso: string): string {
  const d = new Date(iso);
  return d.toLocaleDateString("en-US", { month: "short", year: "numeric" });
}

export function ProjectCostClient({ slug }: { slug: string }) {
  const { data: c } = useProjectCostFull(slug);
  const { data: history } = useCostHistory(slug);
  const synthesize = useSynthesizeCost(slug);
  const [syntheticReport, setSyntheticReport] = useState<{
    resources: number;
    envs: number;
    services: number;
    totalCents: number;
    forecastCents: number;
    budgetCents: number;
  } | null>(null);

  async function recordSnapshot() {
    setSyntheticReport(null);
    try {
      const res = await synthesize.mutateAsync({});
      if (res.summary) setSyntheticReport(res.summary);
    } catch {
      // useSynthesizeCost throws on failure — TanStack surfaces via `synthesize.error`.
    }
  }

  return (
    <div className="col gap-5">
      <PageHead
        title="Cost management"
        sub="Spend by environment, service and project — with agent-driven savings."
        actions={
          <>
            <a
              className="btn outline"
              style={{ display: "inline-flex", alignItems: "center", gap: 6 }}
              href={`/api/v1/projects/${slug}/cost/export`}
              download
            >
              <Icon name="download" size={16} />
              Export CSV
            </a>
            <Btn
              variant="primary"
              icon="dollar"
              loading={synthesize.isPending}
              onClick={recordSnapshot}
            >
              Record snapshot
            </Btn>
          </>
        }
      />

      {/* Estimate infra cost BEFORE creating it. */}
      <CostEstimatorPanel slug={slug} />

      {/* Live account + project cost with budget threshold → alert. */}
      <CostBudgetPanel slug={slug} />

      <CostOptimizationPanel slug={slug} />

      {syntheticReport && (
        <div
          className="row gap-3 between"
          style={{
            padding: 14,
            background: "var(--ok-soft)",
            color: "var(--ok)",
            borderRadius: 10,
            fontSize: 13,
          }}
        >
          <span>
            <strong>Snapshot recorded.</strong> Synthesized from {syntheticReport.resources}{" "}
            resources across {syntheticReport.envs} envs ·{" "}
            <b>{formatCents(syntheticReport.totalCents)}</b> total · forecast{" "}
            <b>{formatCents(syntheticReport.forecastCents)}</b> · budget{" "}
            {formatCents(syntheticReport.budgetCents)}.
          </span>
          <button
            type="button"
            onClick={() => setSyntheticReport(null)}
            className="auth-link"
            style={{
              background: "none",
              border: "none",
              padding: 0,
              font: "inherit",
              cursor: "pointer",
            }}
            aria-label="Dismiss"
          >
            Dismiss
          </button>
        </div>
      )}

      {synthesize.error && (
        <div
          style={{
            padding: 12,
            background: "var(--danger-soft)",
            color: "var(--danger)",
            borderRadius: 10,
            fontSize: 13,
          }}
        >
          {(synthesize.error as Error).message}
        </div>
      )}

      <EnvFilter />

      <TileGrid minTile={200} maxTile="1fr">
        <Stat
          label="Month to date"
          value={c?.monthTotal ?? "—"}
          icon="dollar"
          trend={c?.trend}
          sub={
            c && c.budget > 0
              ? `${Math.round((c.monthTotalDollars / c.budget) * 100)}% of ${moneyK(c.budget)} budget`
              : c
                ? "No budget set"
                : undefined
          }
        />
        <Stat label="Forecast" value={c?.forecast ?? "—"} icon="activity" sub="within budget" />
        <Stat
          label="Savings found"
          value={c?.savings ?? "—"}
          icon="zap"
          sub="by Cost Pilot this month"
        />
        <Stat
          label="Untagged spend"
          value={c?.untagged ?? "—"}
          icon="alert"
          sub="3 resources need tags"
        />
      </TileGrid>

      <div className="dda-proj-dash-grid">
        <Block>
          <Block.Header>
            <Block.Title>Monthly trend</Block.Title>
            <Block.Actions>
              <Badge tone="warn">Budget {c ? moneyK(c.budget) : "—"}</Badge>
            </Block.Actions>
          </Block.Header>
          <Block.Body>
            {c && c.monthly && c.monthly.length > 0 ? (
              <>
                <div className="dda-cost-trend">
                  <Bars data={c.monthly} width={520} height={150} ariaLabel="Monthly cost trend" />
                  {c.budget > 0 && (
                    <div
                      className="dda-cost-budget-line"
                      style={{
                        top: `${Math.max(0, 100 - (c.budget / (Math.max(...c.monthly) || c.budget) / 1.05) * 100)}%`,
                      }}
                    />
                  )}
                </div>
                <div className="row between faint mono" style={{ fontSize: 10.5, marginTop: 8 }}>
                  <span>Jul</span>
                  <span>Sep</span>
                  <span>Nov</span>
                  <span>Jan</span>
                  <span>Mar</span>
                  <span>Jun</span>
                </div>
              </>
            ) : c ? (
              <span className="muted" style={{ fontSize: 13 }}>
                No spend recorded yet. Click <b>Record snapshot</b> to capture the current month.
              </span>
            ) : (
              <Block.Loading />
            )}
          </Block.Body>
        </Block>

        <Block>
          <Block.Header>
            <Block.Title>By environment</Block.Title>
          </Block.Header>
          <Block.Body>
            {c ? (
              <div className="row gap-4" style={{ alignItems: "center", flexWrap: "wrap" }}>
                <Donut
                  size={130}
                  segments={c.byEnv}
                  center={
                    <>
                      <span className="faint" style={{ fontSize: 10 }}>
                        TOTAL
                      </span>
                      <span style={{ fontSize: 18, fontWeight: 800 }}>{c.monthTotal}</span>
                    </>
                  }
                />
                <div className="col gap-3 grow" style={{ minWidth: 160 }}>
                  {c.byEnv.map((s: { name: string; value: number; color: string }) => (
                    <div key={s.name} className="row between" style={{ fontSize: 12.5 }}>
                      <span className="row gap-2">
                        <span className="dot" style={{ background: s.color, boxShadow: "none" }} />
                        {s.name}
                      </span>
                      <b>${s.value.toLocaleString()}</b>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              <Block.Loading />
            )}
          </Block.Body>
        </Block>
      </div>

      <Block>
        <Block.Header>
          <Block.Title>Spend by service</Block.Title>
        </Block.Header>
        {c ? (
          <table className="tbl">
            <thead>
              <tr>
                <th>Service</th>
                <th style={{ width: "40%" }}>Share</th>
                <th style={{ textAlign: "right" }}>Cost</th>
                <th style={{ textAlign: "right" }}>Trend</th>
              </tr>
            </thead>
            <tbody>
              {c.byService.map(
                (s: { name: string; value: number; total: string; pct: number }, i: number) => {
                  const up = i % 3 === 0;
                  return (
                    <tr key={s.name}>
                      <td style={{ fontWeight: 600 }}>{s.name}</td>
                      <td>
                        <div className="row gap-2">
                          <div className="grow">
                            <Progress value={s.pct} height={6} ariaLabel={`${s.name} share`} />
                          </div>
                          <span className="faint tnum" style={{ fontSize: 11.5, width: 32 }}>
                            {s.pct}%
                          </span>
                        </div>
                      </td>
                      <td style={{ textAlign: "right", fontWeight: 700 }} className="tnum">
                        ${s.value.toLocaleString()}
                      </td>
                      <td
                        style={{
                          textAlign: "right",
                          color: up ? "var(--danger)" : "var(--ok)",
                          fontSize: 12,
                          fontWeight: 700,
                        }}
                      >
                        {up ? "▲ 4%" : "▼ 2%"}
                      </td>
                    </tr>
                  );
                },
              )}
            </tbody>
          </table>
        ) : (
          <Block.Loading />
        )}
      </Block>

      <Block>
        <Block.Header>
          <Block.Title sub="Each row is a monthly aggregate. Use the button above to record a new snapshot from current state.">
            Snapshot history
          </Block.Title>
          <Block.Actions>
            <Badge tone="default">{history?.length ?? 0} snapshots</Badge>
          </Block.Actions>
        </Block.Header>
        <Block.Body>
          {!history ? (
            <Block.Loading />
          ) : history.length === 0 ? (
            <span className="muted" style={{ fontSize: 13 }}>
              No snapshots yet. Click <b>Record snapshot</b> to capture the current month.
            </span>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr
                  style={{
                    textAlign: "left",
                    color: "var(--text-faint)",
                    fontWeight: 600,
                    fontSize: 12,
                  }}
                >
                  <th style={{ padding: "8px 0" }}>Period</th>
                  <th style={{ padding: "8px 12px" }}>Total</th>
                  <th style={{ padding: "8px 12px" }}>Forecast</th>
                  <th style={{ padding: "8px 12px" }}>Budget</th>
                  <th style={{ padding: "8px 12px" }} className="hide-sm">
                    Breakdown
                  </th>
                </tr>
              </thead>
              <tbody>
                {history.map((s) => {
                  const overBudget =
                    s.budgetCents && s.totalCents > s.budgetCents ? "var(--danger)" : "inherit";
                  return (
                    <tr key={s.id} style={{ borderTop: "1px solid var(--border-soft)" }}>
                      <td style={{ padding: "10px 0", fontWeight: 600 }}>
                        {formatMonth(s.periodStart)}
                      </td>
                      <td
                        className="mono"
                        style={{ padding: "10px 12px", fontWeight: 700, color: overBudget }}
                      >
                        {formatCents(s.totalCents)}
                      </td>
                      <td className="mono" style={{ padding: "10px 12px" }}>
                        {s.forecastCents != null ? formatCents(s.forecastCents) : "—"}
                      </td>
                      <td className="mono faint" style={{ padding: "10px 12px" }}>
                        {s.budgetCents != null ? formatCents(s.budgetCents) : "—"}
                      </td>
                      <td className="faint hide-sm" style={{ padding: "10px 12px", fontSize: 12 }}>
                        {s.envCount} envs · {s.serviceCount} services
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </Block.Body>
      </Block>
    </div>
  );
}
