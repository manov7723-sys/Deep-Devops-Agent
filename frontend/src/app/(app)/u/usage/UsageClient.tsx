"use client";

import { Badge, Bars, Block, Btn, PageHead, Progress } from "@/components/ui";
import { useUsage, type MeUsage } from "@/hooks/queries/me";

function pct(used: number, limit: number | null): number {
  if (typeof limit !== "number" || limit <= 0) return 30;
  return Math.round((used / limit) * 100);
}

function toneFor(p: number) {
  return p >= 95 ? "danger" : p >= 80 ? "warn" : "default";
}

const METRICS: Array<{
  label: string;
  used: (u: MeUsage) => number;
  limit: (u: MeUsage) => number | null;
}> = [
  { label: "Agent runs", used: (u) => u.agentRunsUsed, limit: (u) => u.agentRunsLimit },
  { label: "Deploys", used: (u) => u.deploysUsed, limit: (u) => u.deploysLimit },
  { label: "Seats", used: (u) => u.seatsUsed, limit: (u) => u.seatsLimit },
  { label: "Environments", used: (u) => u.envsUsed, limit: (u) => u.envsLimit },
];

export function UsageClient() {
  const { data: u } = useUsage();
  const tokenSeries = u?.samples.map((s) => s.tokens) ?? [];

  return (
    <div className="col gap-5">
      <PageHead
        title="Usage"
        sub="Consumption against your plan limits this cycle."
        actions={
          <Btn variant="outline" icon="download">
            Export
          </Btn>
        }
      />

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
          gap: 14,
        }}
      >
        {METRICS.map((m) => {
          const used = u ? m.used(u) : null;
          const limit = u ? m.limit(u) : null;
          const p = used !== null ? pct(used, limit) : 0;
          return (
            <div key={m.label} className="card card-pad col gap-3">
              <span className="muted" style={{ fontSize: 12.5, fontWeight: 600 }}>
                {m.label}
              </span>
              <div className="row gap-1" style={{ alignItems: "baseline" }}>
                <span style={{ fontSize: 24, fontWeight: 800 }} className="tnum">
                  {used !== null ? used.toLocaleString() : "—"}
                </span>
                <span className="faint">
                  /{" "}
                  {used !== null ? (typeof limit === "number" ? limit.toLocaleString() : "∞") : "—"}
                </span>
              </div>
              <Progress value={p} tone={toneFor(p)} ariaLabel={`${m.label} usage`} />
            </div>
          );
        })}
      </div>

      <Block>
        <Block.Header>
          <Block.Title>Agent token consumption</Block.Title>
          <Block.Actions>
            <Badge>Last {tokenSeries.length} weeks</Badge>
          </Block.Actions>
        </Block.Header>
        <Block.Body>
          {u ? (
            tokenSeries.length > 0 ? (
              <>
                <Bars data={tokenSeries} ariaLabel="Agent token consumption" />
                <div className="row between faint" style={{ fontSize: 11, marginTop: 8 }}>
                  <span>{tokenSeries.length} weeks ago</span>
                  <span>Now</span>
                </div>
              </>
            ) : (
              <Block.Empty
                title="No token data yet"
                description="Token usage shows here once agents start running."
              />
            )
          ) : (
            <Block.Loading />
          )}
        </Block.Body>
      </Block>
    </div>
  );
}
