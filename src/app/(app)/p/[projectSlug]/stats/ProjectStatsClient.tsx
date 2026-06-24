"use client";

import { useRouter, useSearchParams, usePathname } from "next/navigation";
import type { Route } from "next";
import { Block, Btn, Icon, PageHead, StatusDot, TileGrid } from "@/components/ui";
import { EnvFilter, type EnvFilterValue } from "@/components/domain/EnvFilter";
import { CloudStatsCard } from "@/components/domain/CloudStatsCard";
import { ObservabilityKpi } from "@/components/domain/ObservabilityKpi";
import { useProjectCloud, useProjectObservability } from "@/hooks/queries/project";
import type { CloudCategory } from "@/lib/legacy-types";

type Tab = CloudCategory | "observability";

const TABS: Array<{ value: Tab; label: string }> = [
  { value: "compute", label: "Compute" },
  { value: "network", label: "Network" },
  { value: "storage", label: "Storage" },
  { value: "data", label: "Databases" },
  { value: "observability", label: "Observability" },
];

export function ProjectStatsClient({ slug }: { slug: string }) {
  const router = useRouter();
  const pathname = usePathname();
  const sp = useSearchParams();
  const tab = (sp.get("tab") as Tab | null) ?? "compute";
  const env = (sp.get("env") as EnvFilterValue | null) ?? "all";

  function setTab(next: Tab) {
    const p = new URLSearchParams(sp);
    p.set("tab", next);
    const q = p.toString();
    router.replace((q ? `${pathname}?${q}` : pathname) as Route);
  }

  return (
    <div className="col gap-5">
      <PageHead
        title="Cloud stats"
        sub="Every provisioned service with live metrics, grouped by type."
        actions={
          <Btn variant="outline" icon="refresh">
            Refresh
          </Btn>
        }
        tabs={TABS}
        tabValue={tab}
        onTabChange={(v) => setTab(v as Tab)}
      />
      <EnvFilter />

      {tab === "observability" ? <ObservabilityPanel slug={slug} env={env} /> : <CloudTab slug={slug} cat={tab} env={env} />}
    </div>
  );
}

function CloudTab({ slug, cat, env }: { slug: string; cat: CloudCategory; env: EnvFilterValue }) {
  const { data: resources } = useProjectCloud(slug, cat, env);
  if (!resources) {
    return (
      <Block>
        <Block.Loading />
      </Block>
    );
  }
  if (resources.length === 0) {
    return (
      <Block>
        <Block.Empty
          icon="cloud"
          title="No services here"
          description="No resources match this environment filter."
        />
      </Block>
    );
  }
  return (
    <TileGrid minTile={340}>
      {resources.map((r) => (
        <CloudStatsCard key={r.id} resource={r} />
      ))}
    </TileGrid>
  );
}

function ObservabilityPanel({ slug, env }: { slug: string; env: EnvFilterValue }) {
  const { data } = useProjectObservability(slug, env);
  if (!data) {
    return (
      <Block>
        <Block.Loading />
      </Block>
    );
  }
  return (
    <div className="col gap-4">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14 }}>
        {data.kpis.map((k) => (
          <ObservabilityKpi key={k.id} kpi={k} />
        ))}
      </div>
      <div className="dda-proj-dash-grid">
        <Block>
          <Block.Header>
            <Block.Title>
              Prometheus —{" "}
              {data.integrations?.prometheus?.connected
                ? data.integrations.prometheus.reachable
                  ? "scraping"
                  : "unreachable"
                : "not connected"}
            </Block.Title>
            <Block.Actions>
              <StatusDot
                tone={
                  data.integrations?.prometheus?.connected
                    ? data.integrations.prometheus.reachable
                      ? "ok"
                      : "warn"
                    : "danger"
                }
                label={
                  data.integrations?.prometheus?.connected
                    ? data.integrations.prometheus.reachable
                      ? "live"
                      : data.integrations.prometheus.error ?? "unreachable"
                    : "not connected"
                }
              />
            </Block.Actions>
          </Block.Header>
          <Block.Body>
            {!data.integrations?.prometheus?.connected ? (
              <ConnectIntegrationCta slug={slug} provider="Prometheus" />
            ) : data.prometheus.length === 0 ? (
              <span className="muted" style={{ fontSize: 13 }}>
                No scrape targets recorded yet. They'll appear here once Prometheus reports them.
              </span>
            ) : (
              <div className="col gap-3">
                {(data.prometheus as Array<{ name: string; series?: number }>).map((t) => (
                  <div key={t.name} className="row between">
                    <span className="row gap-2">
                      <span className="dot ok" />
                      {t.name}
                    </span>
                    <span className="mono faint" style={{ fontSize: 12 }}>{t.series ?? 0} series</span>
                  </div>
                ))}
              </div>
            )}
          </Block.Body>
        </Block>
        <Block>
          <Block.Header>
            <Block.Title>Grafana dashboards</Block.Title>
            <Block.Actions>
              {data.integrations?.grafana?.baseUrl ? (
                <a
                  className="btn ghost sm"
                  style={{ textDecoration: "none" }}
                  href={data.integrations.grafana.baseUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Icon name="ext" size={14} /> Open Grafana
                </a>
              ) : (
                <StatusDot tone="danger" label="not connected" />
              )}
            </Block.Actions>
          </Block.Header>
          <Block.Body>
            {!data.integrations?.grafana?.connected ? (
              <ConnectIntegrationCta slug={slug} provider="Grafana" />
            ) : data.grafana.length === 0 ? (
              <span className="muted" style={{ fontSize: 13 }}>
                No dashboards saved yet. Add via the Grafana API — they'll appear here.
              </span>
            ) : (
              <div className="col gap-2">
                {(data.grafana as Array<unknown>).map((g: unknown, i: number) => {
                  const dashUrl =
                    (g as { url?: string }).url ?? data.integrations?.grafana?.baseUrl;
                  const title = typeof g === "string" ? g : (g as { title?: string }).title ?? "Dashboard";
                  return (
                    <a
                      key={i}
                      href={dashUrl ?? "#"}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="row between dda-grafana-row"
                      style={{
                        padding: "10px 12px",
                        background: "var(--surface-2)",
                        borderRadius: 9,
                        cursor: "pointer",
                        border: "none",
                        color: "inherit",
                        fontFamily: "inherit",
                        width: "100%",
                        textDecoration: "none",
                      }}
                    >
                      <span className="row gap-2" style={{ fontSize: 13, fontWeight: 600 }}>
                        <Icon name="grafana" size={15} style={{ color: "var(--warn)" }} />
                        {title}
                      </span>
                      <Icon name="chevR" size={15} style={{ color: "var(--text-faint)" }} />
                    </a>
                  );
                })}
              </div>
            )}
          </Block.Body>
        </Block>
      </div>
    </div>
  );
}

function ConnectIntegrationCta({ slug, provider }: { slug: string; provider: string }) {
  return (
    <div className="col gap-2" style={{ alignItems: "flex-start" }}>
      <span className="muted" style={{ fontSize: 13 }}>
        Connect {provider} from <b>Settings → Integrations</b> to see live data here.
      </span>
      <a
        className="btn outline sm"
        style={{ textDecoration: "none" }}
        href={`/p/${slug}/settings?tab=integrations`}
      >
        <Icon name="link" size={14} />
        Connect {provider}
      </a>
    </div>
  );
}
