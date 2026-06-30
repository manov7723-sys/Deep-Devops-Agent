/**
 * Azure Monitor alerts for an AKS cluster — the Azure equivalent of the AWS
 * CloudWatch alarms feature. All server-side via ARM REST with the stored
 * Service-Principal / OAuth token (no `az` CLI, no host login).
 *
 * Node metrics live on the managed-cluster resource (namespace
 * Microsoft.ContainerService/managedClusters):
 *   node_cpu_usage_percentage, node_memory_working_set_percentage,
 *   node_disk_usage_percentage
 * (CPU is always available; memory/disk need the cluster's monitoring enabled.)
 *
 * We PUT an action group (email) + one metric alert per metric, wired together.
 */
import { prisma } from "@/lib/db/prisma";
import { decryptSecret } from "@/lib/auth/crypto";
import { getAzureAccessToken } from "@/lib/cloud/azure";
import { listAksClusters } from "@/lib/cloud/azure-arm";

/** Best-effort AKS cluster name from the env's kubeconfig (AKS current-context = cluster name). */
export async function aksClusterFromEnv(envId: string): Promise<string | null> {
  const env = await prisma.env.findUnique({ where: { id: envId }, select: { kubeconfigRef: true } });
  if (!env?.kubeconfigRef) return null;
  try {
    const kc = decryptSecret(env.kubeconfigRef);
    const ctx = kc.match(/current-context:\s*([A-Za-z0-9._-]+)/)?.[1];
    return ctx ?? kc.match(/clusters:[\s\S]*?name:\s*([A-Za-z0-9._-]+)/)?.[1] ?? null;
  } catch {
    return null;
  }
}

const ARM = "https://management.azure.com";

export type AzureMetricKey = "cpu" | "memory" | "disk";

export const AZURE_METRICS: Record<AzureMetricKey, { label: string; metric: string; threshold: number }> = {
  cpu: { label: "Node CPU %", metric: "node_cpu_usage_percentage", threshold: 80 },
  memory: { label: "Node memory %", metric: "node_memory_working_set_percentage", threshold: 80 },
  disk: { label: "Node disk %", metric: "node_disk_usage_percentage", threshold: 80 },
};

type Arm = { ok: true; data: Record<string, unknown> } | { ok: false; error: string };

async function arm(token: string, path: string, method = "GET", body?: unknown): Promise<Arm> {
  let res: Response;
  try {
    res = await fetch(`${ARM}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", Accept: "application/json" },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) {
    return { ok: false, error: `Network error reaching Azure: ${e instanceof Error ? e.message : "error"}` };
  }
  const text = await res.text();
  let data: Record<string, unknown> = {};
  try {
    data = text ? (JSON.parse(text) as Record<string, unknown>) : {};
  } catch {
    data = { raw: text };
  }
  if (!res.ok) {
    const msg = (data?.error as { message?: string })?.message || text.slice(0, 300) || `HTTP ${res.status}`;
    return { ok: false, error: msg };
  }
  return { ok: true, data };
}

/**
 * Ensure the Microsoft.Insights resource provider is registered on the
 * subscription (required for action groups / metric alerts). Idempotent —
 * triggers registration if needed and waits until it's "Registered".
 */
async function ensureInsightsRegistered(token: string, subscription: string): Promise<{ ok: boolean; error?: string }> {
  const path = `/subscriptions/${subscription}/providers/Microsoft.Insights?api-version=2021-04-01`;
  const cur = await arm(token, path);
  if (!cur.ok) return { ok: false, error: cur.error };
  const state = (cur.data as { registrationState?: string }).registrationState;
  if (state === "Registered") return { ok: true };

  const reg = await arm(token, `/subscriptions/${subscription}/providers/Microsoft.Insights/register?api-version=2021-04-01`, "POST");
  if (!reg.ok) {
    if (/authorization|forbidden|does not have permission/i.test(reg.error)) {
      return { ok: false, error: `Can't auto-register Microsoft.Insights — the app's identity lacks permission. Register it once in the Azure portal (Subscription → Resource providers → Microsoft.Insights → Register), or grant the SP Contributor. (${reg.error})` };
    }
    return { ok: false, error: `Could not register Microsoft.Insights: ${reg.error}` };
  }
  // Poll until registered (usually 10–60s).
  for (let i = 0; i < 18; i++) {
    await new Promise((r) => setTimeout(r, 5_000));
    const c = await arm(token, path);
    if (c.ok && (c.data as { registrationState?: string }).registrationState === "Registered") return { ok: true };
  }
  return { ok: false, error: "Microsoft.Insights is still registering — wait a minute and click Set up alarms again." };
}

/** Resolve an env's Azure subscription + find the AKS cluster's resource group + region. */
async function resolveAks(cloudProviderId: string, clusterName: string, resourceGroup?: string) {
  const tok = await getAzureAccessToken(cloudProviderId);
  if (!tok.ok) return { ok: false as const, error: tok.error };
  const cp = await prisma.cloudProvider.findUnique({ where: { id: cloudProviderId }, select: { accountRef: true } });
  const subscription = cp?.accountRef?.trim();
  if (!subscription) return { ok: false as const, error: "No Azure subscription on the cloud provider." };

  const list = await listAksClusters(tok.accessToken, subscription);
  if (!list.ok) return { ok: false as const, error: list.error };
  const cluster = list.clusters.find(
    (c) => c.name === clusterName && (!resourceGroup || c.resourceGroup.toLowerCase() === resourceGroup.toLowerCase()),
  );
  if (!cluster) return { ok: false as const, error: `AKS cluster "${clusterName}" not found in subscription ${subscription}.` };
  const aksId = `/subscriptions/${subscription}/resourceGroups/${cluster.resourceGroup}/providers/Microsoft.ContainerService/managedClusters/${clusterName}`;
  return { ok: true as const, token: tok.accessToken, subscription, resourceGroup: cluster.resourceGroup, location: cluster.location, aksId };
}

export type AzureAlarmResult = { key: AzureMetricKey; label: string; name: string; ok: boolean; error?: string };
export type AzureSetupResult = {
  ok: boolean;
  clusterName: string;
  resourceGroup?: string;
  subscription?: string;
  emailWired: boolean;
  alarms: AzureAlarmResult[];
  error?: string;
};

/** Create/ensure an email action group + metric alerts for the AKS cluster. */
export async function setupAzureAksAlarms(opts: {
  cloudProviderId: string;
  clusterName: string;
  resourceGroup?: string;
  email?: string;
  metrics: AzureMetricKey[];
}): Promise<AzureSetupResult> {
  const r = await resolveAks(opts.cloudProviderId, opts.clusterName, opts.resourceGroup);
  if (!r.ok) return { ok: false, clusterName: opts.clusterName, emailWired: false, alarms: [], error: r.error };
  const { token, subscription, resourceGroup, aksId } = r;

  // Action groups + metric alerts require the Microsoft.Insights provider.
  const reg = await ensureInsightsRegistered(token, subscription);
  if (!reg.ok) return { ok: false, clusterName: opts.clusterName, resourceGroup, subscription, emailWired: false, alarms: [], error: reg.error };

  let actionGroupId: string | undefined;
  if (opts.email) {
    const agName = `dda-aks-${opts.clusterName}-ag`.slice(0, 250);
    const ag = await arm(
      token,
      `/subscriptions/${subscription}/resourceGroups/${resourceGroup}/providers/microsoft.insights/actionGroups/${agName}?api-version=2023-01-01`,
      "PUT",
      {
        location: "Global",
        properties: {
          groupShortName: "ddaalarm",
          enabled: true,
          emailReceivers: [{ name: "email", emailAddress: opts.email, useCommonAlertSchema: true }],
        },
      },
    );
    if (!ag.ok) return { ok: false, clusterName: opts.clusterName, resourceGroup, subscription, emailWired: false, alarms: [], error: `Action group failed: ${ag.error}` };
    actionGroupId = (ag.data as { id?: string }).id;
  }

  const alarms: AzureAlarmResult[] = [];
  for (const key of opts.metrics) {
    const def = AZURE_METRICS[key];
    const name = `dda-aks-${opts.clusterName}-${key}`.slice(0, 250);
    const put = await arm(
      token,
      `/subscriptions/${subscription}/resourceGroups/${resourceGroup}/providers/microsoft.insights/metricAlerts/${name}?api-version=2018-03-01`,
      "PUT",
      {
        location: "global",
        properties: {
          description: `${def.label} > ${def.threshold}% on AKS ${opts.clusterName}`,
          severity: 2,
          enabled: true,
          scopes: [aksId],
          // Fastest Azure allows: evaluate every 1 min over a 1-min window so
          // alerts fire ~1-3 min after a node crosses the threshold (plus Azure
          // platform-metric ingestion latency, which is inherent).
          evaluationFrequency: "PT1M",
          windowSize: "PT1M",
          autoMitigate: true,
          criteria: {
            "odata.type": "Microsoft.Azure.Monitor.SingleResourceMultipleMetricCriteria",
            allOf: [
              {
                name: "cond1",
                metricNamespace: "Microsoft.ContainerService/managedClusters",
                metricName: def.metric,
                operator: "GreaterThan",
                threshold: def.threshold,
                timeAggregation: "Average",
                criterionType: "StaticThresholdCriterion",
                // Evaluate PER NODE (split on the node dimension) so a single
                // saturated node trips the alert — without this, Azure averages
                // across all nodes and one hot node gets diluted by idle ones
                // (matches the per-instance behaviour of the EKS alarms).
                dimensions: [{ name: "node", operator: "Include", values: ["*"] }],
              },
            ],
          },
          actions: actionGroupId ? [{ actionGroupId }] : [],
        },
      },
    );
    alarms.push({ key, label: def.label, name, ok: put.ok, error: put.ok ? undefined : put.error });
  }

  return { ok: alarms.some((a) => a.ok), clusterName: opts.clusterName, resourceGroup, subscription, emailWired: !!actionGroupId, alarms };
}

export type AzureAlarmInfo = { name: string; metric: string; enabled: boolean };

/** List this app's metric alerts for an AKS cluster (for the persistent UI summary). */
export async function listAzureAksAlarms(
  cloudProviderId: string,
  clusterName: string,
  resourceGroup?: string,
): Promise<{ ok: true; alarms: AzureAlarmInfo[] } | { ok: false; error: string }> {
  const r = await resolveAks(cloudProviderId, clusterName, resourceGroup);
  if (!r.ok) return { ok: false, error: r.error };
  const list = await arm(r.token, `/subscriptions/${r.subscription}/resourceGroups/${r.resourceGroup}/providers/microsoft.insights/metricAlerts?api-version=2018-03-01`);
  if (!list.ok) return { ok: false, error: list.error };
  const value = ((list.data as { value?: Array<{ name?: string; properties?: { enabled?: boolean; criteria?: { allOf?: Array<{ metricName?: string }> } } }> }).value) ?? [];
  const prefix = `dda-aks-${clusterName}-`;
  const alarms = value
    .filter((a) => (a.name ?? "").startsWith(prefix))
    .map((a) => ({ name: a.name ?? "", metric: a.properties?.criteria?.allOf?.[0]?.metricName ?? "", enabled: a.properties?.enabled ?? false }));
  return { ok: true, alarms };
}

export type AzureAlarmState = { name: string; metric: string; state: "ALARM" | "OK" };

/** Rule name is the last segment of the alert-rule resource id. */
function ruleNameFromId(id: string): string {
  return (id || "").split("/").pop() ?? "";
}

/**
 * Read which of this app's AKS metric alerts are currently FIRING — the Azure
 * equivalent of describeEksAlarmStates. Cross-references our configured metric
 * alert rules (dda-aks-<cluster>-*) against Azure's Alerts Management API
 * (the live fired-alert instances). A rule with a Fired, not-Closed instance is
 * ALARM; otherwise OK.
 */
export async function describeAksAlertStates(
  cloudProviderId: string,
  clusterName: string,
  resourceGroup?: string,
): Promise<{ ok: true; alarms: AzureAlarmState[] } | { ok: false; error: string }> {
  const r = await resolveAks(cloudProviderId, clusterName, resourceGroup);
  if (!r.ok) return { ok: false, error: r.error };
  const { token, subscription, resourceGroup: rg } = r;

  // Our configured metric-alert rules for this cluster.
  const rulesRes = await arm(
    token,
    `/subscriptions/${subscription}/resourceGroups/${rg}/providers/microsoft.insights/metricAlerts?api-version=2018-03-01`,
  );
  if (!rulesRes.ok) return { ok: false, error: rulesRes.error };
  const prefix = `dda-aks-${clusterName}-`;
  const rules = (
    ((rulesRes.data as { value?: Array<{ name?: string; properties?: { criteria?: { allOf?: Array<{ metricName?: string }> } } }> }).value) ?? []
  )
    .filter((a) => (a.name ?? "").startsWith(prefix))
    .map((a) => ({ name: a.name ?? "", metric: a.properties?.criteria?.allOf?.[0]?.metricName ?? "" }));

  // Currently-fired alert instances in the subscription (last day). If this
  // call fails we treat all rules as OK rather than erroring the whole sync.
  const firedNames = new Set<string>();
  const firedRes = await arm(
    token,
    `/subscriptions/${subscription}/providers/Microsoft.AlertsManagement/alerts?api-version=2019-05-05-preview&monitorCondition=Fired&timeRange=1d`,
  );
  if (firedRes.ok) {
    const alerts =
      ((firedRes.data as { value?: Array<{ properties?: { essentials?: { alertRule?: string; monitorCondition?: string; alertState?: string } } }> }).value) ?? [];
    for (const al of alerts) {
      const e = al.properties?.essentials;
      if (e?.monitorCondition === "Fired" && e.alertState !== "Closed") {
        firedNames.add(ruleNameFromId(e.alertRule ?? ""));
      }
    }
  }

  const alarms: AzureAlarmState[] = rules.map((rule) => ({
    name: rule.name,
    metric: rule.metric,
    state: firedNames.has(rule.name) ? "ALARM" : "OK",
  }));
  return { ok: true, alarms };
}
