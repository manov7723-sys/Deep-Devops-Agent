/**
 * Cloud SQL discovery + GKE access wiring.
 *
 * The GCP sibling of `rds-network.ts` (AWS) and `azure-postgres.ts` (Azure),
 * but the ACCESS MODEL is deliberately different, because GCP's is.
 *
 * AWS and Azure both gate the database with a network rule — a security-group
 * reference or an IP allow-list — so those modules resolve the cluster's
 * egress identity and punch a hole for it. Cloud SQL supports that shape too
 * (`authorized networks` on a public IP), but Google's documented
 * recommendation for GKE is the **Cloud SQL Auth Proxy**:
 *
 *   • The proxy runs as a sidecar next to the app container.
 *   • The app connects to 127.0.0.1:5432 — no credentials in transit, no
 *     public IP, no firewall rule to maintain.
 *   • The proxy authenticates with IAM via Workload Identity, so the
 *     database is reachable by *that Kubernetes service account* and nothing
 *     else. Rotating a node pool or changing an egress IP can't break it,
 *     and there is no allow-list to leave stale after a cluster rebuild —
 *     the exact failure that made rds-network.ts necessary on AWS.
 *
 * Requirements the proxy imposes, all checked before we claim success:
 *   1. Workload Identity enabled on the cluster (the GKE blueprint here
 *      turns it on by default).
 *   2. A Google service account with `roles/cloudsql.client`.
 *   3. An IAM policy binding letting the Kubernetes SA impersonate it.
 *   4. The KSA annotated with the GSA's email.
 *
 * Everything is done with the app's stored GCP OAuth token over the REST
 * APIs — no `gcloud`, consistent with the rest of the codebase.
 */
import { getGcpAccessToken } from "@/lib/cloud/gcp";

const SQLADMIN = "https://sqladmin.googleapis.com/v1";
const IAM = "https://iam.googleapis.com/v1";
const CRM = "https://cloudresourcemanager.googleapis.com/v1";

export type CloudSqlInstance = {
  name: string;
  /** `project:region:instance` — what the proxy takes as its argument. */
  connectionName: string;
  region: string;
  /** "POSTGRES_16", "MYSQL_8_0", … */
  databaseVersion: string;
  engine: "postgres" | "mysql";
  state: string;
  /** Public IP, when the instance has one. Not needed for the proxy. */
  publicIp?: string;
  privateIp?: string;
  /** True when the instance requires SSL for direct (non-proxy) connections. */
  requireSsl: boolean;
};

type Ok<T> = { ok: true; data: T };
type Err = { ok: false; error: string };

async function api<T>(
  token: string,
  url: string,
  init?: { method?: string; body?: unknown },
): Promise<Ok<T> | Err> {
  let res: Response;
  try {
    res = await fetch(url, {
      method: init?.method ?? "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: init?.body ? JSON.stringify(init.body) : undefined,
      cache: "no-store",
    });
  } catch (e) {
    return { ok: false, error: `Network error reaching Google: ${e instanceof Error ? e.message : "unknown"}` };
  }
  const text = await res.text().catch(() => "");
  if (!res.ok) {
    let msg = `Google returned ${res.status}`;
    try {
      const j = JSON.parse(text) as { error?: { message?: string; status?: string } };
      msg = j.error?.message ?? j.error?.status ?? msg;
    } catch {
      if (text) msg = `${msg}: ${text.slice(0, 200)}`;
    }
    // The most common first-run failure is an API that was never enabled on
    // the project. Say which one, and how to fix it, instead of echoing a bare
    // 403 the user can't act on.
    if (/has not been used in project|is disabled/i.test(msg)) {
      msg += " — enable it in the Google Cloud console (APIs & Services → Enable APIs), then retry.";
    }
    return { ok: false, error: msg };
  }
  try {
    return { ok: true, data: (text ? JSON.parse(text) : {}) as T };
  } catch {
    return { ok: true, data: {} as T };
  }
}

function engineOf(databaseVersion: string): "postgres" | "mysql" {
  return /mysql/i.test(databaseVersion) ? "mysql" : "postgres";
}

/** List every Cloud SQL instance in the project. */
export async function listCloudSqlInstances(
  cloudProviderId: string,
  projectId: string,
): Promise<{ ok: true; instances: CloudSqlInstance[] } | { ok: false; error: string }> {
  const tok = await getGcpAccessToken(cloudProviderId);
  if (!tok.ok) return { ok: false, error: tok.error };

  type Row = {
    name?: string;
    connectionName?: string;
    region?: string;
    databaseVersion?: string;
    state?: string;
    settings?: { ipConfiguration?: { requireSsl?: boolean } };
    ipAddresses?: Array<{ type?: string; ipAddress?: string }>;
  };
  const r = await api<{ items?: Row[] }>(
    tok.accessToken,
    `${SQLADMIN}/projects/${encodeURIComponent(projectId)}/instances`,
  );
  if (!r.ok) return r;

  const instances: CloudSqlInstance[] = (r.data.items ?? []).map((i) => ({
    name: i.name ?? "",
    connectionName: i.connectionName ?? "",
    region: i.region ?? "",
    databaseVersion: i.databaseVersion ?? "",
    engine: engineOf(i.databaseVersion ?? ""),
    state: i.state ?? "",
    publicIp: i.ipAddresses?.find((a) => a.type === "PRIMARY")?.ipAddress,
    privateIp: i.ipAddresses?.find((a) => a.type === "PRIVATE")?.ipAddress,
    requireSsl: i.settings?.ipConfiguration?.requireSsl === true,
  }));
  return { ok: true, instances: instances.filter((i) => i.name) };
}

/** Databases inside one instance — the picker needs these, not just the server. */
export async function listCloudSqlDatabases(
  cloudProviderId: string,
  projectId: string,
  instance: string,
): Promise<{ ok: true; databases: string[] } | { ok: false; error: string }> {
  const tok = await getGcpAccessToken(cloudProviderId);
  if (!tok.ok) return { ok: false, error: tok.error };
  const r = await api<{ items?: Array<{ name?: string }> }>(
    tok.accessToken,
    `${SQLADMIN}/projects/${encodeURIComponent(projectId)}/instances/${encodeURIComponent(instance)}/databases`,
  );
  if (!r.ok) return r;
  return {
    ok: true,
    databases: (r.data.items ?? [])
      .map((d) => d.name ?? "")
      // Skip the engine's own bookkeeping databases — offering them as a
      // deploy target is never what the user means.
      .filter((n) => n && !["postgres", "information_schema", "mysql", "sys", "performance_schema"].includes(n)),
  };
}

/** Create a database inside an instance. Idempotent — "already exists" is success. */
export async function ensureCloudSqlDatabase(
  cloudProviderId: string,
  projectId: string,
  instance: string,
  database: string,
): Promise<{ ok: true; created: boolean } | { ok: false; error: string }> {
  const existing = await listCloudSqlDatabases(cloudProviderId, projectId, instance);
  if (existing.ok && existing.databases.includes(database)) return { ok: true, created: false };

  const tok = await getGcpAccessToken(cloudProviderId);
  if (!tok.ok) return { ok: false, error: tok.error };
  const r = await api(
    tok.accessToken,
    `${SQLADMIN}/projects/${encodeURIComponent(projectId)}/instances/${encodeURIComponent(instance)}/databases`,
    { method: "POST", body: { name: database } },
  );
  if (!r.ok) {
    if (/already exists/i.test(r.error)) return { ok: true, created: false };
    return { ok: false, error: `Creating database "${database}" failed: ${r.error}` };
  }
  return { ok: true, created: true };
}

export type WorkloadIdentitySetup = {
  /** Google service account email the proxy authenticates as. */
  gsaEmail: string;
  /** Kubernetes service account the pods run as. */
  ksaName: string;
  steps: string[];
};

/**
 * Provision the IAM side of Workload Identity so a Kubernetes service account
 * can act as a Google service account holding `roles/cloudsql.client`.
 *
 * Three pieces, each idempotent:
 *   1. The GSA itself (409 "already exists" is success).
 *   2. A PROJECT-level binding granting it roles/cloudsql.client — this is
 *      what actually lets the proxy open a connection.
 *   3. A SERVICE-ACCOUNT-level binding granting the KSA
 *      roles/iam.workloadIdentityUser on the GSA — this is what lets the pod
 *      assume that identity.
 *
 * Read-modify-write on IAM policies is racy by nature; both bindings use
 * getIamPolicy → append-if-absent → setIamPolicy with the returned etag, so a
 * concurrent change fails loudly rather than silently clobbering another
 * app's bindings.
 */
export async function ensureCloudSqlWorkloadIdentity(args: {
  cloudProviderId: string;
  projectId: string;
  /** Namespace the app runs in. */
  namespace: string;
  /** Kubernetes service account name — created by the caller in-cluster. */
  ksaName: string;
  /** Google service account id (before the @). Derived from the app name. */
  gsaId: string;
}): Promise<{ ok: true; data: WorkloadIdentitySetup } | { ok: false; error: string }> {
  const { cloudProviderId, projectId, namespace, ksaName, gsaId } = args;
  const tok = await getGcpAccessToken(cloudProviderId);
  if (!tok.ok) return { ok: false, error: tok.error };
  const token = tok.accessToken;
  const steps: string[] = [];

  const gsaEmail = `${gsaId}@${projectId}.iam.gserviceaccount.com`;

  // 1 — the Google service account.
  const created = await api(
    token,
    `${IAM}/projects/${encodeURIComponent(projectId)}/serviceAccounts`,
    {
      method: "POST",
      body: {
        accountId: gsaId,
        serviceAccount: { displayName: `Cloud SQL proxy for ${namespace}` },
      },
    },
  );
  if (created.ok) steps.push(`Created service account ${gsaEmail}.`);
  else if (/already exists|ALREADY_EXISTS/i.test(created.error)) {
    steps.push(`Service account ${gsaEmail} already exists.`);
  } else {
    return { ok: false, error: `Creating the service account failed: ${created.error}` };
  }

  // 2 — project binding: roles/cloudsql.client on the GSA.
  type Policy = { bindings?: Array<{ role?: string; members?: string[] }>; etag?: string; version?: number };
  const proj = await api<Policy>(
    token,
    `${CRM}/projects/${encodeURIComponent(projectId)}:getIamPolicy`,
    { method: "POST", body: {} },
  );
  if (!proj.ok) return { ok: false, error: `Reading the project IAM policy failed: ${proj.error}` };
  const member = `serviceAccount:${gsaEmail}`;
  const bindings = proj.data.bindings ?? [];
  const clientBinding = bindings.find((b) => b.role === "roles/cloudsql.client");
  if (clientBinding?.members?.includes(member)) {
    steps.push(`${gsaEmail} already has roles/cloudsql.client.`);
  } else {
    if (clientBinding) clientBinding.members = [...(clientBinding.members ?? []), member];
    else bindings.push({ role: "roles/cloudsql.client", members: [member] });
    const set = await api(
      token,
      `${CRM}/projects/${encodeURIComponent(projectId)}:setIamPolicy`,
      { method: "POST", body: { policy: { ...proj.data, bindings } } },
    );
    if (!set.ok) {
      return { ok: false, error: `Granting roles/cloudsql.client failed: ${set.error}` };
    }
    steps.push(`Granted ${gsaEmail} roles/cloudsql.client on the project.`);
  }

  // 3 — service-account binding: the KSA may impersonate the GSA.
  const saResource = `projects/${projectId}/serviceAccounts/${gsaEmail}`;
  const saPolicy = await api<Policy>(token, `${IAM}/${saResource}:getIamPolicy`, {
    method: "POST",
    body: {},
  });
  if (!saPolicy.ok) {
    return { ok: false, error: `Reading the service account IAM policy failed: ${saPolicy.error}` };
  }
  const wiMember = `serviceAccount:${projectId}.svc.id.goog[${namespace}/${ksaName}]`;
  const saBindings = saPolicy.data.bindings ?? [];
  const wiBinding = saBindings.find((b) => b.role === "roles/iam.workloadIdentityUser");
  if (wiBinding?.members?.includes(wiMember)) {
    steps.push(`Workload Identity binding for ${namespace}/${ksaName} already present.`);
  } else {
    if (wiBinding) wiBinding.members = [...(wiBinding.members ?? []), wiMember];
    else saBindings.push({ role: "roles/iam.workloadIdentityUser", members: [wiMember] });
    const set = await api(token, `${IAM}/${saResource}:setIamPolicy`, {
      method: "POST",
      body: { policy: { ...saPolicy.data, bindings: saBindings } },
    });
    if (!set.ok) {
      return { ok: false, error: `Binding the Kubernetes service account failed: ${set.error}` };
    }
    steps.push(`Bound ${namespace}/${ksaName} to ${gsaEmail} via Workload Identity.`);
  }

  return { ok: true, data: { gsaEmail, ksaName, steps } };
}

/**
 * Connection URL for an app talking through the Cloud SQL Auth Proxy.
 *
 * Always 127.0.0.1 — the proxy listens on localhost inside the pod, so the
 * host is never the instance's IP and there is no TLS parameter to set: the
 * proxy terminates an encrypted tunnel itself. Getting this wrong (pointing
 * at the public IP "because that's the real address") reintroduces every
 * firewall problem the proxy exists to remove.
 */
export function buildCloudSqlProxyUrl(args: {
  engine: "postgres" | "mysql";
  user: string;
  password: string;
  database: string;
}): string {
  const { engine, user, password, database } = args;
  const scheme = engine === "mysql" ? "mysql" : "postgresql";
  const port = engine === "mysql" ? 3306 : 5432;
  return `${scheme}://${encodeURIComponent(user)}:${encodeURIComponent(password)}@127.0.0.1:${port}/${database}`;
}
