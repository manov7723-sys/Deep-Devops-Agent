"use client";

import Link from "next/link";
import { useSearchParams } from "next/navigation";
import type { Route } from "next";
import { Badge, Block, Btn, Donut, PageHead, RowList, Stat, StatusDot } from "@/components/ui";
import { EnvFilter, type EnvFilterValue } from "@/components/domain/EnvFilter";
import { PipeIcon } from "@/components/domain/PipeIcon";
import { ActivityRow } from "@/components/domain/ActivityRow";
import {
  useProjectActivity,
  useProjectApprovals,
  useProjectCost,
  useProjectEnvs,
  useProjectPipelines,
  useProjectWorkloads,
} from "@/hooks/queries/project";
import type { SeedActivity, SeedApproval, SeedEnv, SeedPipeline } from "@/lib/legacy-types";

const ENV_TONE = { release: "ok", beta: "warn", alpha: "info" } as const;

function moneyK(v: number) {
  return `$${(v / 1000).toFixed(1)}k`;
}

function riskTone(risk: SeedApproval["risk"]): "danger" | "warn" | "ok" {
  return risk === "high" ? "danger" : risk === "medium" ? "warn" : "ok";
}

export function ProjectDashboardClient({
  slug,
  projectName,
}: {
  slug: string;
  projectName: string;
}) {
  const sp = useSearchParams();
  const env = (sp.get("env") as EnvFilterValue | null) ?? "all";

  const { data: envs } = useProjectEnvs(slug);
  const { data: workloads } = useProjectWorkloads(slug, env);
  const { data: pipelines } = useProjectPipelines(slug, env);
  const { data: approvals } = useProjectApprovals(slug);
  const { data: activity } = useProjectActivity(slug);
  const { data: cost } = useProjectCost(slug);

  const healthyEnvs =
    envs?.filter((e) => !workloads?.some((w) => w.env === e.id && w.status !== "ok")).length ?? 0;
  const totalEnvs = envs?.length ?? 0;
  const degradedNote = (() => {
    if (!workloads || !envs) return undefined;
    const bad = workloads.find((w) => w.status !== "ok");
    if (!bad) return undefined;
    const envName = envs.find((e) => e.id === bad.env)?.name.toLowerCase() ?? bad.env;
    return `${bad.name} degraded in ${envName}`;
  })();

  return (
    <div className="col gap-5">
      <PageHead
        title={projectName}
        sub="Production-grade infra across alpha, beta & release — watched by 5 agents."
        actions={
          <>
            <Btn variant="outline" icon="refresh">
              Sync now
            </Btn>
            <Link href={`/p/${slug}/chat` as Route} className="btn primary">
              <span className="row gap-2">
                <span style={{ display: "inline-flex" }}>
                  <svg
                    width="16"
                    height="16"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                  >
                    <path d="M21 12a8 8 0 0 1-11.5 7.2L3 21l1.8-6.5A8 8 0 1 1 21 12Z" />
                  </svg>
                </span>
                Ask Deep Agent
              </span>
            </Link>
          </>
        }
      />
      <EnvFilter />

      <div className="dda-stat-row">
        <Stat
          label="Environments healthy"
          value={`${healthyEnvs} / ${totalEnvs}`}
          icon="layers"
          sub={degradedNote}
        />
        <Stat
          label="Deploys this week"
          value="312"
          icon="rocket"
          trend={{ up: true, v: "12%" }}
          sub="98.7% success rate"
        />
        <Stat
          label="Open approvals"
          value={approvals?.length ?? "—"}
          icon="approve"
          sub={
            approvals && approvals.some((a) => a.risk === "high")
              ? `${approvals.filter((a) => a.risk === "high").length} high-risk pending`
              : undefined
          }
        />
        <Stat
          label="Spend this month"
          value={cost ? moneyK(cost.monthTotal) : "—"}
          icon="dollar"
          trend={{ up: true, v: "6.2%" }}
          sub={cost ? `of ${moneyK(cost.budget)} budget` : undefined}
        />
      </div>

      <div className="dda-proj-dash-grid">
        <Block>
          <Block.Header>
            <Block.Title>Environments</Block.Title>
            <Block.Actions>
              <Link href={`/p/${slug}/environments` as Route} className="btn ghost sm">
                Manage →
              </Link>
            </Block.Actions>
          </Block.Header>
          {envs ? (
            <RowList<SeedEnv>
              items={envs}
              getKey={(e) => e.id}
              renderItem={(e) => {
                const wl = workloads?.filter((w) => w.env === e.id) ?? [];
                const bad = wl.some((w) => w.status !== "ok");
                return (
                  <div className="row between gap-3">
                    <div className="row gap-3" style={{ minWidth: 0 }}>
                      <span
                        className={`dot ${bad ? "warn" : "ok"} ${e.id === "release" ? "pulse" : ""}`}
                      />
                      <div className="col" style={{ lineHeight: 1.35, minWidth: 0 }}>
                        <span className="row gap-2" style={{ fontWeight: 700, fontSize: 13.5 }}>
                          {e.name}
                          <Badge tone={e.tone}>{e.branch}</Badge>
                        </span>
                        <span className="faint mono" style={{ fontSize: 11.5 }}>
                          {e.url}
                        </span>
                      </div>
                    </div>
                    <div className="row gap-4 nowrap">
                      <div
                        className="col hide-sm nowrap"
                        style={{ alignItems: "flex-end", lineHeight: 1.3 }}
                      >
                        <span style={{ fontSize: 13, fontWeight: 700 }}>{wl.length} workloads</span>
                        <span className="faint" style={{ fontSize: 11.5 }}>
                          {e.auto ? "Auto-deploy on" : "Manual deploy"}
                        </span>
                      </div>
                      <Link
                        href={`/p/${slug}/stats?env=${e.id}` as Route}
                        className="btn outline sm"
                      >
                        View
                      </Link>
                    </div>
                  </div>
                );
              }}
            />
          ) : (
            <Block.Loading />
          )}
        </Block>

        <Block>
          <Block.Header>
            <Block.Title>Cost by service</Block.Title>
            <Block.Actions>
              <Link href={`/p/${slug}/stats` as Route} className="btn ghost sm">
                Details →
              </Link>
            </Block.Actions>
          </Block.Header>
          <Block.Body>
            {cost ? (
              <div className="row gap-4" style={{ alignItems: "center", flexWrap: "wrap" }}>
                <Donut
                  size={120}
                  segments={cost.byEnv}
                  center={
                    <>
                      <span className="faint" style={{ fontSize: 10.5 }}>
                        MONTH
                      </span>
                      <span style={{ fontSize: 19, fontWeight: 800 }}>
                        {moneyK(cost.monthTotal)}
                      </span>
                    </>
                  }
                />
                <div className="col gap-2 grow" style={{ minWidth: 140 }}>
                  {cost.byEnv.map((s) => (
                    <div key={s.name} className="row between" style={{ fontSize: 12.5 }}>
                      <span className="row gap-2">
                        <span className="dot" style={{ background: s.color, boxShadow: "none" }} />
                        {s.name}
                      </span>
                      <b className="tnum">{moneyK(s.value)}</b>
                    </div>
                  ))}
                  <div className="divider" style={{ margin: "4px 0" }} />
                  <div className="row between" style={{ fontSize: 12 }}>
                    <span className="muted">Forecast</span>
                    <b>{cost.forecast}</b>
                  </div>
                </div>
              </div>
            ) : (
              <Block.Loading />
            )}
          </Block.Body>
        </Block>
      </div>

      <div className="dda-dash-grid">
        <Block>
          <Block.Header>
            <Block.Title>Recent pipelines</Block.Title>
            <Block.Actions>
              <Link href={`/p/${slug}/cicd` as Route} className="btn ghost sm">
                CI/CD →
              </Link>
            </Block.Actions>
          </Block.Header>
          {pipelines ? (
            <RowList<SeedPipeline>
              items={pipelines.slice(0, 4)}
              getKey={(p) => p.id}
              renderItem={(p) => (
                <div className="row between gap-3">
                  <div className="row gap-3" style={{ minWidth: 0 }}>
                    <PipeIcon status={p.status} />
                    <div className="col" style={{ lineHeight: 1.35, minWidth: 0 }}>
                      <span style={{ fontSize: 13, fontWeight: 700 }} className="nowrap">
                        {p.repo}
                      </span>
                      <span className="faint mono nowrap" style={{ fontSize: 11 }}>
                        {p.sha} · {p.branch}
                      </span>
                    </div>
                  </div>
                  <div className="row gap-3 nowrap">
                    <Badge tone={ENV_TONE[p.env]}>{p.env}</Badge>
                    <span
                      className="faint"
                      style={{ fontSize: 11.5, width: 56, textAlign: "right" }}
                    >
                      {p.startedRelative}
                    </span>
                  </div>
                </div>
              )}
            />
          ) : (
            <Block.Loading />
          )}
        </Block>

        <Block>
          <Block.Header>
            <Block.Title>Needs your approval</Block.Title>
            <Block.Actions>
              <Link href={`/p/${slug}/approvals` as Route} className="btn ghost sm">
                All →
              </Link>
            </Block.Actions>
          </Block.Header>
          {approvals ? (
            <RowList<SeedApproval>
              items={approvals.slice(0, 3)}
              getKey={(a) => a.id}
              renderItem={(a) => (
                <div className="row between gap-3">
                  <div className="row gap-3" style={{ minWidth: 0 }}>
                    <StatusDot tone={riskTone(a.risk)} />
                    <div className="col" style={{ lineHeight: 1.35, minWidth: 0 }}>
                      <span
                        style={{
                          fontSize: 12.5,
                          fontWeight: 700,
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          whiteSpace: "nowrap",
                        }}
                      >
                        {a.title}
                      </span>
                      <span className="faint" style={{ fontSize: 11 }}>
                        {a.agent} · {a.requestedRelative}
                      </span>
                    </div>
                  </div>
                  <Link href={`/p/${slug}/approvals` as Route} className="btn primary sm">
                    Review
                  </Link>
                </div>
              )}
            />
          ) : (
            <Block.Loading />
          )}
        </Block>
      </div>

      <Block>
        <Block.Header>
          <Block.Title>Activity</Block.Title>
          <Block.Actions>
            <Link href={`/p/${slug}/activity` as Route} className="btn ghost sm">
              Full feed →
            </Link>
          </Block.Actions>
        </Block.Header>
        {activity ? (
          <RowList<SeedActivity>
            items={activity.slice(0, 5)}
            getKey={(a) => a.id}
            renderItem={(a) => <ActivityRow a={a} />}
            divider={false}
          />
        ) : (
          <Block.Loading />
        )}
      </Block>
    </div>
  );
}
