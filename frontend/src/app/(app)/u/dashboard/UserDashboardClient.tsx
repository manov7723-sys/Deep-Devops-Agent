"use client";

import Link from "next/link";
import type { Route } from "next";
import { Badge, Block, Icon, PageHead, RowList, Stat, UsageBar } from "@/components/ui";
import { ProjectCard } from "@/components/domain/ProjectCard";
import { useProjects, type Project } from "@/hooks/queries/projects";
import { usePlan, useUsage } from "@/hooks/queries/me";

/**
 * Turn an ISO timestamp into a short human string ("2h ago", "yesterday",
 * "Mar 5"). Zero deps — good enough for a dashboard glance without pulling
 * in date-fns for one caller.
 */
function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const sec = Math.max(0, Math.floor(diffMs / 1000));
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.floor(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)}h ago`;
  if (sec < 86400 * 2) return "yesterday";
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)}d ago`;
  return new Date(iso).toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function formatPriceCents(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

export function UserDashboardClient({ firstName }: { firstName: string }) {
  const { data: projects } = useProjects();
  const { data: usage } = useUsage();
  const { data: subscription } = usePlan();

  const activeProjects = projects?.length ?? 0;
  const totalEnvs = projects?.reduce((s, p) => s + p.envCount, 0) ?? 0;

  return (
    <div className="col gap-5">
      <PageHead
        title={`Welcome back, ${firstName}`}
        sub="Your workspace across all projects and environments."
        actions={
          <Link href={"/u/projects?new=1&step=1" as Route} className="btn primary">
            New project
          </Link>
        }
      />

      <div className="dda-stat-row">
        <Stat
          label="Active projects"
          value={activeProjects}
          icon="projects"
          sub={`${totalEnvs} environments total`}
        />
        <Stat label="Deploys this month" value="312" icon="rocket" trend={{ up: true, v: "12%" }} />
        <Stat
          label="Agent runs"
          value={usage ? `${(usage.agentRunsUsed / 1000).toFixed(1)}k` : "—"}
          icon="bot"
          sub={
            usage && typeof usage.agentRunsLimit === "number"
              ? `of ${(usage.agentRunsLimit / 1000).toFixed(0)}k included`
              : undefined
          }
        />
        <Stat
          label="Cloud spend"
          value="$12.1k"
          icon="dollar"
          trend={{ up: true, v: "5%" }}
          sub="across 3 projects"
        />
      </div>

      {/* Quick actions — one-click entry points that each land in an existing flow. */}
      <div className="row gap-2 wrap">
        <Link href={"/u/projects?new=1&step=1" as Route} className="btn outline">
          <Icon name="rocket" size={14} /> Create a new project
        </Link>
        <Link href={"/u/settings" as Route} className="btn outline">
          <Icon name="users" size={14} /> Invite a teammate
        </Link>
        <Link href={"/u/projects" as Route} className="btn outline">
          <Icon name="cloud" size={14} /> Connect a cloud account
        </Link>
        <Link href={"/u/subscription" as Route} className="btn outline">
          <Icon name="card" size={14} /> Upgrade plan
        </Link>
      </div>

      <Block>
        <Block.Header>
          <Block.Title>Your projects</Block.Title>
          <Block.Actions>
            <Link href={"/u/projects" as Route} className="btn ghost sm">
              All projects →
            </Link>
          </Block.Actions>
        </Block.Header>
        {projects ? (
          <RowList<Project>
            items={projects}
            getKey={(p) => p.id}
            renderItem={(p) => <ProjectCard project={p} variant="row" />}
          />
        ) : (
          <Block.Loading />
        )}
      </Block>

      {/*
        Recent activity — derived from the projects list's own updatedAt
        (server bumps it on any material change: deploys, env changes, cloud
        connects, etc). Zero new endpoint; the 5 most-recently-touched projects
        double as a cross-project activity glance.
      */}
      <Block>
        <Block.Header>
          <Block.Title>Recent activity</Block.Title>
        </Block.Header>
        <Block.Body>
          {projects ? (
            projects.length === 0 ? (
              <Block.Empty
                title="No activity yet"
                description="Create your first project to start seeing deploys, chat, and cloud events here."
              />
            ) : (
              <div className="col gap-2">
                {[...projects]
                  .sort(
                    (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
                  )
                  .slice(0, 5)
                  .map((p) => (
                    <Link
                      key={p.id}
                      href={`/p/${p.slug}/dashboard` as Route}
                      className="row gap-3"
                      style={{
                        alignItems: "center",
                        padding: "8px 10px",
                        borderRadius: 8,
                        textDecoration: "none",
                        color: "inherit",
                      }}
                    >
                      <span
                        style={{
                          width: 28,
                          height: 28,
                          borderRadius: 6,
                          background: `hsl(${p.colorHue}, 60%, 55%)`,
                          color: "white",
                          display: "grid",
                          placeItems: "center",
                          fontWeight: 700,
                          fontSize: 12.5,
                          flex: "none",
                        }}
                      >
                        {p.name[0]?.toUpperCase() ?? "P"}
                      </span>
                      <div className="col" style={{ gap: 1, flex: 1, minWidth: 0 }}>
                        <b style={{ fontSize: 12.5 }}>{p.name}</b>
                        <span className="muted" style={{ fontSize: 11.5 }}>
                          {p.envCount} env{p.envCount === 1 ? "" : "s"} ·{" "}
                          {p.cloud.length ? p.cloud.join(", ") : "no cloud yet"}
                        </span>
                      </div>
                      <span className="muted" style={{ fontSize: 11, flex: "none" }}>
                        {relativeTime(p.updatedAt)}
                      </span>
                    </Link>
                  ))}
              </div>
            )
          ) : (
            <Block.Loading />
          )}
        </Block.Body>
      </Block>

      <div className="dda-dash-grid">
        <Block>
          <Block.Header>
            <Block.Title>Usage this cycle</Block.Title>
            <Block.Actions>
              <Link href={"/u/usage" as Route} className="btn ghost sm">
                Details
              </Link>
            </Block.Actions>
          </Block.Header>
          <Block.Body>
            {usage ? (
              <div className="col gap-4">
                <UsageBar
                  label="Agent runs"
                  used={usage.agentRunsUsed}
                  limit={usage.agentRunsLimit ?? "unlimited"}
                />
                <UsageBar
                  label="Deploys"
                  used={usage.deploysUsed}
                  limit={usage.deploysLimit ?? "unlimited"}
                />
                <UsageBar
                  label="Seats"
                  used={usage.seatsUsed}
                  limit={usage.seatsLimit ?? "unlimited"}
                />
              </div>
            ) : (
              <Block.Empty
                title="No usage yet"
                description="Start an agent or ship a deploy to populate this."
              />
            )}
          </Block.Body>
        </Block>

        <Block>
          <Block.Header>
            <Block.Title>Plan</Block.Title>
            <Block.Actions>
              {subscription && <Badge tone="accent">{subscription.planName}</Badge>}
            </Block.Actions>
          </Block.Header>
          <Block.Body>
            <div className="col gap-3">
              <div className="row gap-2" style={{ alignItems: "baseline" }}>
                <span style={{ fontSize: 28, fontWeight: 800 }}>
                  {subscription
                    ? formatPriceCents(subscription.basePriceCents, subscription.currency)
                    : "—"}
                </span>
                <span className="muted">{subscription ? "/ month" : ""}</span>
              </div>
              <p className="muted" style={{ fontSize: 13 }}>
                {subscription
                  ? (subscription.renewsLabel ??
                    (subscription.currentPeriodEnd
                      ? `Renews ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}`
                      : `Status: ${subscription.status}`))
                  : "You're not subscribed yet. Pick a plan to unlock the full agent tier."}
              </p>
              <div className="row gap-2">
                <Link href={"/u/subscription" as Route} className="btn outline grow">
                  Manage plan
                </Link>
                <Link href={"/u/subscription" as Route} className="btn primary">
                  {subscription ? "Upgrade" : "Choose plan"}
                </Link>
              </div>
            </div>
          </Block.Body>
        </Block>
      </div>
    </div>
  );
}
