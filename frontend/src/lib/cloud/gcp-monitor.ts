/**
 * GCP Cloud Monitoring alerting for a GKE cluster — the GCP equivalent of the
 * CloudWatch / Azure Monitor alarm features. Server-side via the Cloud
 * Monitoring REST API with the stored OAuth token (no `gcloud`). GKE node
 * metrics are auto-collected (no agent), so CPU/memory/disk just work.
 *
 *   email     → an email notification channel (reused if it exists)
 *   per metric→ an alert policy on the GKE node metric, wired to the channel
 */
import { prisma } from "@/lib/db/prisma";
import { decryptSecret } from "@/lib/auth/crypto";
import { getGcpAccessToken } from "@/lib/cloud/gcp";

const MON = "https://monitoring.googleapis.com/v3";

// GKE exposes node CPU/memory as clean allocatable_utilization ratios. There is
// no equivalent node disk-% metric (only ephemeral_storage used/total bytes), so
// disk is omitted for GCP rather than shipping a metric that doesn't resolve.
export type GcpMetricKey = "cpu" | "memory";

export const GCP_METRICS: Record<
  GcpMetricKey,
  { label: string; metric: string; threshold: number }
> = {
  cpu: {
    label: "Node CPU %",
    metric: "kubernetes.io/node/cpu/allocatable_utilization",
    threshold: 0.8,
  },
  memory: {
    label: "Node memory %",
    metric: "kubernetes.io/node/memory/allocatable_utilization",
    threshold: 0.8,
  },
};

type Gcp = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };

async function gcp(token: string, path: string, method = "GET", body?: unknown): Promise<Gcp> {
  let res: Response;
  try {
    res = await fetch(`${MON}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return {
      ok: false,
      error: `Network error reaching Google: ${e instanceof Error ? e.message : "error"}`,
    };
  }
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg =
      (data?.error as { message?: string })?.message || text.slice(0, 300) || `HTTP ${res.status}`;
    return { ok: false, error: msg };
  }
  return { ok: true, data };
}

/** Best-effort GKE cluster name from the env's kubeconfig (handles several formats). */
export async function gkeClusterFromEnv(envId: string): Promise<string | null> {
  const env = await prisma.env.findUnique({
    where: { id: envId },
    select: { kubeconfigRef: true },
  });
  if (!env?.kubeconfigRef) return null;
  try {
    const kc = decryptSecret(env.kubeconfigRef);
    // 1) gcloud-style context: gke_<project>_<location>_<cluster>
    const fromCtx = (kc.match(/current-context:\s*(\S+)/)?.[1] ?? "").match(
      /^gke_[^_]+_[^_]+_(.+)$/,
    )?.[1];
    if (fromCtx) return fromCtx;
    // 2) any gke_..._<cluster> token anywhere (cluster/context names).
    const anyGke = kc.match(/\bgke_[^_\s]+_[^_\s]+_([A-Za-z0-9-]+)/)?.[1];
    if (anyGke) return anyGke;
    // 3) the cluster entry name, if it isn't a gke_ ARN form.
    const name = kc.match(/clusters:\s*[\s\S]*?-[\s\S]*?name:\s*([A-Za-z0-9._-]+)/)?.[1];
    if (name && !name.startsWith("gke_")) return name;
    // 4) fall back to the current-context value itself.
    const ctx = kc.match(/current-context:\s*([A-Za-z0-9._-]+)/)?.[1];
    return ctx && !ctx.startsWith("gke_") ? ctx : null;
  } catch {
    return null;
  }
}

async function gcpProject(cloudProviderId: string): Promise<string | null> {
  const cp = await prisma.cloudProvider.findUnique({
    where: { id: cloudProviderId },
    select: { accountRef: true },
  });
  return cp?.accountRef?.trim() || null;
}

/** Find-or-create an email notification channel; returns its resource name. */
async function ensureEmailChannel(
  token: string,
  project: string,
  email: string,
): Promise<{ ok: true; name: string } | { ok: false; error: string }> {
  const list = await gcp(token, `/projects/${project}/notificationChannels`);
  if (list.ok) {
    const existing = (
      (
        list.data as {
          notificationChannels?: Array<{
            name?: string;
            type?: string;
            labels?: { email_address?: string };
          }>;
        }
      ).notificationChannels ?? []
    ).find((c) => c.type === "email" && c.labels?.email_address === email);
    if (existing?.name) return { ok: true, name: existing.name };
  }
  const create = await gcp(token, `/projects/${project}/notificationChannels`, "POST", {
    type: "email",
    displayName: `DeepAgent (${email})`,
    labels: { email_address: email },
    enabled: true,
  });
  if (!create.ok) return { ok: false, error: create.error };
  const name = (create.data as { name?: string }).name;
  return name ? { ok: true, name } : { ok: false, error: "No notification channel name returned." };
}

export type GcpAlarmResult = { key: GcpMetricKey; label: string; ok: boolean; error?: string };
export type GcpSetupResult = {
  ok: boolean;
  clusterName: string;
  project?: string;
  emailWired: boolean;
  alarms: GcpAlarmResult[];
  error?: string;
};

/** Create alert policies (CPU/memory/disk) for a GKE cluster, wired to an email channel. */
export async function setupGkeAlarms(opts: {
  cloudProviderId: string;
  clusterName: string;
  email?: string;
  metrics: GcpMetricKey[];
  /** Per-metric threshold overrides (PERCENT 0–100) from the env's AlertThreshold rules; converted to GCP's 0–1 ratio. */
  thresholdPercents?: Partial<Record<GcpMetricKey, number>>;
}): Promise<GcpSetupResult> {
  const tok = await getGcpAccessToken(opts.cloudProviderId);
  if (!tok.ok)
    return {
      ok: false,
      clusterName: opts.clusterName,
      emailWired: false,
      alarms: [],
      error: tok.error,
    };
  const project = await gcpProject(opts.cloudProviderId);
  if (!project)
    return {
      ok: false,
      clusterName: opts.clusterName,
      emailWired: false,
      alarms: [],
      error: "No GCP project on the cloud provider.",
    };

  let channel: string | undefined;
  if (opts.email) {
    const ch = await ensureEmailChannel(tok.accessToken, project, opts.email);
    if (!ch.ok)
      return {
        ok: false,
        clusterName: opts.clusterName,
        project,
        emailWired: false,
        alarms: [],
        error: `Notification channel failed: ${ch.error}`,
      };
    channel = ch.name;
  }

  // Map existing dda-* policies by display name so re-running replaces (not duplicates).
  const existing = await gcp(tok.accessToken, `/projects/${project}/alertPolicies`);
  const byName = new Map<string, string>();
  if (existing.ok) {
    for (const p of (
      existing.data as { alertPolicies?: Array<{ name?: string; displayName?: string }> }
    ).alertPolicies ?? []) {
      if (p.displayName && p.name) byName.set(p.displayName, p.name);
    }
  }

  const alarms: GcpAlarmResult[] = [];
  for (const key of opts.metrics) {
    // User-configured threshold (percent) overrides the default; GCP uses a 0–1 ratio.
    const base = GCP_METRICS[key];
    const override = opts.thresholdPercents?.[key];
    const def = override != null ? { ...base, threshold: override / 100 } : base;
    const displayName = `dda-gke-${opts.clusterName}-${key}`;
    const prior = byName.get(displayName);
    if (prior) await gcp(tok.accessToken, `/${prior}`, "DELETE");

    const create = await gcp(tok.accessToken, `/projects/${project}/alertPolicies`, "POST", {
      displayName,
      combiner: "OR",
      enabled: true,
      conditions: [
        {
          displayName: `${def.label} > ${Math.round(def.threshold * 100)}%`,
          conditionThreshold: {
            filter: `resource.type="k8s_node" AND metric.type="${def.metric}" AND resource.labels.cluster_name="${opts.clusterName}"`,
            comparison: "COMPARISON_GT",
            thresholdValue: def.threshold,
            duration: "300s",
            trigger: { count: 1 },
            aggregations: [
              {
                alignmentPeriod: "300s",
                perSeriesAligner: "ALIGN_MEAN",
                crossSeriesReducer: "REDUCE_MEAN",
                groupByFields: ['resource.label."cluster_name"'],
              },
            ],
          },
        },
      ],
      notificationChannels: channel ? [channel] : [],
    });
    alarms.push({
      key,
      label: def.label,
      ok: create.ok,
      error: create.ok ? undefined : create.error,
    });
  }

  return {
    ok: alarms.some((a) => a.ok),
    clusterName: opts.clusterName,
    project,
    emailWired: !!channel,
    alarms,
  };
}

export type GcpAlarmInfo = { name: string; displayName: string };

/** List this app's alert policies for a GKE cluster (for the persistent UI summary). */
export async function listGkeAlarms(
  cloudProviderId: string,
  clusterName: string,
): Promise<{ ok: true; alarms: GcpAlarmInfo[] } | { ok: false; error: string }> {
  const tok = await getGcpAccessToken(cloudProviderId);
  if (!tok.ok) return { ok: false, error: tok.error };
  const project = await gcpProject(cloudProviderId);
  if (!project) return { ok: false, error: "No GCP project on the cloud provider." };
  const list = await gcp(tok.accessToken, `/projects/${project}/alertPolicies`);
  if (!list.ok) return { ok: false, error: list.error };
  const prefix = `dda-gke-${clusterName}-`;
  const alarms = (
    (list.data as { alertPolicies?: Array<{ name?: string; displayName?: string }> })
      .alertPolicies ?? []
  )
    .filter((p) => (p.displayName ?? "").startsWith(prefix))
    .map((p) => ({ name: p.name ?? "", displayName: p.displayName ?? "" }));
  return { ok: true, alarms };
}
