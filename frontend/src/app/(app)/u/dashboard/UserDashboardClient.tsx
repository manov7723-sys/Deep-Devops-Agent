"use client";

import Link from "next/link";
import type { Route } from "next";
import { Badge, Block, Btn, PageHead, RowList, Stat, UsageBar } from "@/components/ui";
import { ProjectCard } from "@/components/domain/ProjectCard";
import { useProjects, type Project } from "@/hooks/queries/projects";
import { usePlan, useUsage } from "@/hooks/queries/me";

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
                  {subscription ? formatPriceCents(subscription.basePriceCents, subscription.currency) : "—"}
                </span>
                <span className="muted">{subscription ? "/ month" : ""}</span>
              </div>
              <p className="muted" style={{ fontSize: 13 }}>
                {subscription
                  ? subscription.renewsLabel ??
                    (subscription.currentPeriodEnd
                      ? `Renews ${new Date(subscription.currentPeriodEnd).toLocaleDateString()}`
                      : `Status: ${subscription.status}`)
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
