"use client";

import Link from "next/link";
import type { Route } from "next";
import { Avatar, Badge, Bars, Block, Btn, Donut, PageHead, RowList, Stat } from "@/components/ui";
import { McpCard } from "@/components/domain/McpCard";
import { useAdminDashboard } from "@/hooks/queries/admin";
import type { AdminRecentSignup } from "@/lib/api/schemas/admin-api";

function planTone(plan: string): "accent" | "info" | "default" {
  if (plan === "Scale") return "accent";
  if (plan === "Pro") return "info";
  return "default";
}

export function AdminDashboardClient() {
  const { data } = useAdminDashboard();

  return (
    <div className="col gap-5">
      <PageHead
        title="Platform overview"
        sub="Revenue, customers and system health across DeepAgent."
        actions={
          <Btn variant="outline" icon="download">
            Report
          </Btn>
        }
      />

      <div className="dda-stat-row">
        <Stat
          label="MRR"
          value={data?.kpis.mrr ?? "—"}
          icon="dollar"
          trend={{ up: true, v: "8.4%" }}
          sub={data ? `${data.kpis.arr} ARR` : undefined}
        />
        <Stat
          label="Active users"
          value={data ? data.kpis.users.toLocaleString() : "—"}
          icon="users"
          trend={{ up: true, v: "6.1%" }}
        />
        <Stat
          label="Projects"
          value={data ? data.kpis.projects.toLocaleString() : "—"}
          icon="projects"
          sub={data ? `${(data.kpis.environments / 1000).toFixed(1)}k environments` : undefined}
        />
        <Stat
          label="Churn"
          value={data?.kpis.churn ?? "—"}
          icon="activity"
          trend={{ up: false, v: "0.3%" }}
          sub="monthly"
        />
      </div>

      <div className="dda-proj-dash-grid">
        <Block>
          <Block.Header>
            <Block.Title>Recurring revenue</Block.Title>
            <Block.Actions>
              <Badge tone="ok">+8.4% MoM</Badge>
            </Block.Actions>
          </Block.Header>
          <Block.Body>
            {data ? (
              <>
                <Bars
                  data={data.mrrTrend}
                  width={560}
                  height={150}
                  ariaLabel="Monthly recurring revenue"
                />
                <div className="row between faint" style={{ fontSize: 11, marginTop: 8 }}>
                  <span>Jul &apos;25</span>
                  <span>Jun &apos;26</span>
                </div>
              </>
            ) : (
              <Block.Loading />
            )}
          </Block.Body>
        </Block>

        <Block>
          <Block.Header>
            <Block.Title>Plan distribution</Block.Title>
          </Block.Header>
          <Block.Body>
            {data ? (
              <div className="row gap-4" style={{ alignItems: "center", flexWrap: "wrap" }}>
                <Donut
                  size={130}
                  segments={data.plans.map((p) => ({
                    name: p.name,
                    value: p.active,
                    color: p.accent,
                  }))}
                  center={
                    <>
                      <span className="faint" style={{ fontSize: 10 }}>
                        PAID
                      </span>
                      <span style={{ fontSize: 18, fontWeight: 800 }}>{data.paidUsers}</span>
                    </>
                  }
                />
                <div className="col gap-2 grow" style={{ minWidth: 140 }}>
                  {data.plans.map((p) => (
                    <div key={p.id} className="row between" style={{ fontSize: 12.5 }}>
                      <span className="row gap-2">
                        <span className="dot" style={{ background: p.accent, boxShadow: "none" }} />
                        {p.name}
                      </span>
                      <b>{p.active}</b>
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

      <div className="dda-dash-grid">
        <Block>
          <Block.Header>
            <Block.Title>MCP server health</Block.Title>
            <Block.Actions>
              <Link href={"/admin/mcp" as Route} className="btn ghost sm">
                All →
              </Link>
            </Block.Actions>
          </Block.Header>
          {data ? (
            <div className="col">
              {data.mcp.slice(0, 4).map((m) => (
                <McpCard key={m.id} connector={m} variant="compact" />
              ))}
            </div>
          ) : (
            <Block.Loading />
          )}
        </Block>

        <Block>
          <Block.Header>
            <Block.Title>Recent signups</Block.Title>
            <Block.Actions>
              <Link href={"/admin/users" as Route} className="btn ghost sm">
                All users →
              </Link>
            </Block.Actions>
          </Block.Header>
          {data ? (
            <RowList<AdminRecentSignup>
              items={data.recentSignups}
              getKey={(u) => u.id}
              renderItem={(u) => (
                <div className="row between gap-3">
                  <div className="row gap-3" style={{ minWidth: 0 }}>
                    <Avatar name={u.name} size={30} />
                    <div className="col" style={{ lineHeight: 1.3 }}>
                      <span style={{ fontWeight: 600, fontSize: 13 }}>{u.name}</span>
                      <span className="faint" style={{ fontSize: 11.5 }}>
                        {u.email}
                      </span>
                    </div>
                  </div>
                  <Badge tone={planTone(u.plan)}>{u.plan}</Badge>
                </div>
              )}
            />
          ) : (
            <Block.Loading />
          )}
        </Block>
      </div>
    </div>
  );
}
