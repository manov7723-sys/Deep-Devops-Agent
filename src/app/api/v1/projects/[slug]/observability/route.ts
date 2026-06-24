import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { listDashboards, listKpis, listTargets } from "@/lib/insights/observability";
import { getIntegrationCredentials } from "@/lib/integrations/integrations";

const PROBE_TIMEOUT_MS = 2_000;

type ProbeResult = {
  connected: boolean;
  reachable: boolean;
  baseUrl?: string;
  endpoint?: string;
  error?: string;
};

/**
 * Project observability data — Prisma rows + a live probe of the configured
 * Prometheus/Grafana endpoints (creds come from the project's Integrations
 * tab). Failed probes return `reachable: false` with the error; they DO NOT
 * abort the response.
 *
 * The hook expects `prometheus` (formerly `targets`) so the client can keep
 * doing `data.prometheus.map(...)` without a separate rename.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const projectId = gate.access.project.id;
  const envKey = new URL(req.url).searchParams.get("env");
  let envId: string | undefined;
  if (envKey && envKey !== "all") {
    const env = await envBySlugAndKey(projectId, envKey);
    if (!env) {
      return NextResponse.json({
        kpis: [],
        prometheus: [],
        grafana: [],
        integrations: {
          prometheus: { connected: false, reachable: false },
          grafana: { connected: false, reachable: false },
        },
      });
    }
    envId = env.id;
  }

  const [kpis, prometheusTargets, grafanaDashboards, promCreds, grafCreds] = await Promise.all([
    listKpis(projectId, envId),
    listTargets(projectId),
    listDashboards(projectId),
    getIntegrationCredentials(projectId, "prometheus"),
    getIntegrationCredentials(projectId, "grafana"),
  ]);

  const [prometheus, grafana] = await Promise.all([
    probePrometheus(promCreds),
    probeGrafana(grafCreds),
  ]);

  return NextResponse.json({
    kpis,
    prometheus: prometheusTargets,
    grafana: grafanaDashboards,
    integrations: { prometheus, grafana },
  });
}

async function probePrometheus(
  creds: Awaited<ReturnType<typeof getIntegrationCredentials>>,
): Promise<ProbeResult> {
  if (!creds) return { connected: false, reachable: false };
  const endpoint = creds.credentials.endpoint?.replace(/\/$/, "") ?? "";
  if (!endpoint) return { connected: true, reachable: false, error: "no_endpoint_credential" };
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (creds.credentials.bearer_token) {
      headers.Authorization = `Bearer ${creds.credentials.bearer_token}`;
    }
    const res = await fetch(`${endpoint}/-/healthy`, {
      headers,
      signal: ctl.signal,
      cache: "no-store",
    });
    clearTimeout(timer);
    return {
      connected: true,
      reachable: res.ok,
      endpoint,
      error: res.ok ? undefined : `http_${res.status}`,
    };
  } catch (err) {
    return {
      connected: true,
      reachable: false,
      endpoint,
      error: err instanceof Error ? err.name : "fetch_failed",
    };
  }
}

async function probeGrafana(
  creds: Awaited<ReturnType<typeof getIntegrationCredentials>>,
): Promise<ProbeResult> {
  if (!creds) return { connected: false, reachable: false };
  const baseUrl = creds.credentials.base_url?.replace(/\/$/, "") ?? "";
  if (!baseUrl) return { connected: true, reachable: false, error: "no_base_url_credential" };
  try {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), PROBE_TIMEOUT_MS);
    const headers: Record<string, string> = { Accept: "application/json" };
    if (creds.credentials.api_key) {
      headers.Authorization = `Bearer ${creds.credentials.api_key}`;
    }
    const res = await fetch(`${baseUrl}/api/health`, {
      headers,
      signal: ctl.signal,
      cache: "no-store",
    });
    clearTimeout(timer);
    return {
      connected: true,
      reachable: res.ok,
      baseUrl,
      error: res.ok ? undefined : `http_${res.status}`,
    };
  } catch (err) {
    return {
      connected: true,
      reachable: false,
      baseUrl,
      error: err instanceof Error ? err.name : "fetch_failed",
    };
  }
}
