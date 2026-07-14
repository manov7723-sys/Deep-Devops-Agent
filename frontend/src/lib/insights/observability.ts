/**
 * Observability surface — KPIs (cached display rows), Prometheus targets,
 * Grafana dashboards. Real metric pulls happen out-of-band; this layer just
 * stores the snapshot used by the project Stats screen.
 */
import type {
  GrafanaDashboard,
  HealthStatus,
  ObservabilityKpi,
  PrometheusTarget,
  TargetStatus,
} from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

export type KpiRow = {
  id: string;
  envKey: string | null;
  name: string;
  value: string;
  unit: string | null;
  tone: HealthStatus;
  series: number[];
  capturedAt: string;
};

function kpiRow(k: ObservabilityKpi, envKeyById: Map<string, string>): KpiRow {
  return {
    id: k.id,
    envKey: k.envId ? (envKeyById.get(k.envId) ?? null) : null,
    name: k.name,
    value: k.value,
    unit: k.unit,
    tone: k.tone,
    series: k.series,
    capturedAt: k.capturedAt.toISOString(),
  };
}

async function envKeyLookup(projectId: string): Promise<Map<string, string>> {
  const envs = await prisma.env.findMany({
    where: { projectId },
    select: { id: true, key: true },
  });
  return new Map(envs.map((e) => [e.id, e.key]));
}

export async function listKpis(projectId: string, envId?: string): Promise<KpiRow[]> {
  const [rows, lookup] = await Promise.all([
    prisma.observabilityKpi.findMany({
      where: { projectId, ...(envId ? { envId } : {}) },
      orderBy: { capturedAt: "desc" },
    }),
    envKeyLookup(projectId),
  ]);
  return rows.map((k) => kpiRow(k, lookup));
}

export type CreateKpiArgs = {
  projectId: string;
  envId?: string;
  name: string;
  value: string;
  unit?: string;
  tone: HealthStatus;
  series: number[];
};

export async function createKpi(args: CreateKpiArgs): Promise<KpiRow> {
  const created = await prisma.observabilityKpi.create({
    data: {
      projectId: args.projectId,
      envId: args.envId ?? null,
      name: args.name,
      value: args.value,
      unit: args.unit ?? null,
      tone: args.tone,
      series: args.series,
    },
  });
  const lookup = await envKeyLookup(args.projectId);
  return kpiRow(created, lookup);
}

export type TargetRow = {
  id: string;
  name: string;
  status: TargetStatus;
  series: number | null;
  createdAt: string;
};

function targetRow(t: PrometheusTarget): TargetRow {
  return {
    id: t.id,
    name: t.name,
    status: t.status,
    series: t.series,
    createdAt: t.createdAt.toISOString(),
  };
}

export async function listTargets(projectId: string): Promise<TargetRow[]> {
  const rows = await prisma.prometheusTarget.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(targetRow);
}

export async function createTarget(
  projectId: string,
  args: { name: string; status: TargetStatus; series?: number },
): Promise<TargetRow> {
  const created = await prisma.prometheusTarget.create({
    data: {
      projectId,
      name: args.name,
      status: args.status,
      series: args.series ?? null,
    },
  });
  return targetRow(created);
}

export type DashboardRow = {
  id: string;
  title: string;
  url: string | null;
  createdAt: string;
};

function dashboardRow(d: GrafanaDashboard): DashboardRow {
  return {
    id: d.id,
    title: d.title,
    url: d.url,
    createdAt: d.createdAt.toISOString(),
  };
}

export async function listDashboards(projectId: string): Promise<DashboardRow[]> {
  const rows = await prisma.grafanaDashboard.findMany({
    where: { projectId },
    orderBy: { createdAt: "desc" },
  });
  return rows.map(dashboardRow);
}

export async function createDashboard(
  projectId: string,
  args: { title: string; url?: string },
): Promise<DashboardRow> {
  const created = await prisma.grafanaDashboard.create({
    data: { projectId, title: args.title, url: args.url ?? null },
  });
  return dashboardRow(created);
}
