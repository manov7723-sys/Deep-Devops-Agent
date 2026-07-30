/**
 * Azure Database for PostgreSQL / MySQL (Flexible Server) — discovery and
 * network reachability from an AKS cluster.
 *
 * The Azure counterpart of `rds-network.ts`. Same contract, same failure it
 * exists to prevent: a database Secret written into the cluster while the
 * database's firewall still rejects every packet from the nodes, producing
 * "Can't reach database server" that reads like an outage but is one rule.
 *
 * AZURE'S NETWORKING MODEL differs from AWS in a way that shapes this file:
 *   • AWS  — security groups reference each OTHER. Open the DB's SG to the
 *            node SG and any node IP works forever.
 *   • Azure — Flexible Server in PUBLIC access mode allows by IP RANGE only.
 *            There is no "allow this cluster" primitive, so we must resolve
 *            the cluster's OUTBOUND IPs (the ones its egress load balancer
 *            SNATs through) and allow those explicitly.
 *   • Azure — Flexible Server in PRIVATE (VNet-integrated) mode has no
 *            firewall rules at all; reachability depends on the AKS VNet
 *            being the same VNet or peered to it. We detect that case and
 *            report it rather than pretending a rule would help.
 *
 * All calls use the app's stored Azure credentials + the ARM REST API — no
 * `az` CLI, consistent with the rest of the codebase.
 */
import { getAzureAccessToken } from "@/lib/cloud/azure";

const ARM = "https://management.azure.com";
// GA api-versions. Preview versions were used here initially and produced
// opaque ARM 500s ("An unexpected error occured... Tracking ID: ...") on the
// firewallRules PUT; the GA versions carry the same fields
// (`network.publicNetworkAccess`, the firewallRules child resource) and are
// stable across tenants.
const PG_API = "2022-12-01";
const MYSQL_API = "2023-06-30";
const AKS_API = "2024-02-01";

export type AzurePgServer = {
  name: string;
  resourceGroup: string;
  location: string;
  /** "postgres" | "mysql" — drives port, URL scheme and admin DB name. */
  engine: "postgres" | "mysql";
  /** FQDN clients connect to, e.g. mydb.postgres.database.azure.com. */
  fqdn: string;
  /** Admin login name the server was created with. */
  adminUser: string;
  version: string;
  /** "Enabled" = public access + firewall rules; "Disabled" = VNet-integrated. */
  publicAccess: boolean;
  /** Present when the server is VNet-integrated (private access). */
  delegatedSubnetId?: string;
  state: string;
};

type ArmOk<T> = { ok: true; data: T };
type ArmErr = { ok: false; error: string };

async function arm<T>(token: string, path: string, init?: RequestInit): Promise<ArmOk<T> | ArmErr> {
  let res: Response;
  try {
    res = await fetch(`${ARM}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        ...(init?.body ? { "Content-Type": "application/json" } : {}),
        ...(init?.headers ?? {}),
      },
      cache: "no-store",
    });
  } catch (e) {
    return { ok: false, error: `Network error reaching Azure: ${e instanceof Error ? e.message : "unknown"}` };
  }
  const text = await res.text().catch(() => "");
  if (res.status < 200 || res.status >= 300) {
    let msg = `Azure returned ${res.status}`;
    try {
      const j = JSON.parse(text) as { error?: { message?: string; code?: string } };
      msg = j.error?.message ?? j.error?.code ?? msg;
    } catch {
      if (text) msg = `${msg}: ${text.slice(0, 200)}`;
    }
    return { ok: false, error: msg };
  }
  try {
    return { ok: true, data: (text ? JSON.parse(text) : {}) as T };
  } catch {
    return { ok: true, data: {} as T };
  }
}

function rgFromId(id: string): string {
  return id.match(/\/resourceGroups\/([^/]+)/i)?.[1] ?? "";
}

/**
 * List every PostgreSQL AND MySQL Flexible Server in the subscription. Both
 * engines are returned in one list because the connect UI treats them
 * identically apart from port + URL scheme — same as the AWS RDS picker,
 * which also spans both.
 */
export async function listAzureDatabaseServers(
  cloudProviderId: string,
  subscriptionId: string,
): Promise<{ ok: true; servers: AzurePgServer[] } | { ok: false; error: string }> {
  const tok = await getAzureAccessToken(cloudProviderId);
  if (!tok.ok) return { ok: false, error: tok.error };

  type Row = {
    id?: string;
    name?: string;
    location?: string;
    properties?: {
      fullyQualifiedDomainName?: string;
      administratorLogin?: string;
      version?: string;
      state?: string;
      network?: { publicNetworkAccess?: string; delegatedSubnetResourceId?: string };
    };
  };

  const servers: AzurePgServer[] = [];
  const sources: Array<["postgres" | "mysql", string, string]> = [
    ["postgres", "Microsoft.DBforPostgreSQL", PG_API],
    ["mysql", "Microsoft.DBforMySQL", MYSQL_API],
  ];

  const errors: string[] = [];
  for (const [engine, provider, apiVersion] of sources) {
    const r = await arm<{ value?: Row[] }>(
      tok.accessToken,
      `/subscriptions/${subscriptionId}/providers/${provider}/flexibleServers?api-version=${apiVersion}`,
    );
    if (!r.ok) {
      // One engine failing (e.g. provider not registered on the subscription)
      // must not hide the other's results — collect and continue.
      errors.push(`${engine}: ${r.error}`);
      continue;
    }
    for (const s of r.data.value ?? []) {
      const p = s.properties ?? {};
      servers.push({
        name: s.name ?? "",
        resourceGroup: rgFromId(s.id ?? ""),
        location: s.location ?? "",
        engine,
        fqdn: p.fullyQualifiedDomainName ?? "",
        adminUser: p.administratorLogin ?? "",
        version: p.version ?? "",
        publicAccess: (p.network?.publicNetworkAccess ?? "Enabled") === "Enabled",
        delegatedSubnetId: p.network?.delegatedSubnetResourceId || undefined,
        state: p.state ?? "",
      });
    }
  }

  if (servers.length === 0 && errors.length === sources.length) {
    return { ok: false, error: `Couldn't list database servers — ${errors.join("; ")}` };
  }
  return { ok: true, servers: servers.filter((s) => s.name) };
}

/**
 * The public IPs an AKS cluster egresses through.
 *
 * AKS SNATs all outbound pod traffic through its egress load balancer's
 * effective outbound IPs. Those are the addresses a database firewall
 * actually sees — NOT the node IPs, NOT the pod CIDR. Allowing anything else
 * produces a rule that looks correct and blocks every connection.
 */
export async function getAksOutboundIps(
  cloudProviderId: string,
  subscriptionId: string,
  resourceGroup: string,
  clusterName: string,
): Promise<{ ok: true; ips: string[] } | { ok: false; error: string }> {
  const tok = await getAzureAccessToken(cloudProviderId);
  if (!tok.ok) return { ok: false, error: tok.error };

  const cluster = await arm<{
    properties?: {
      networkProfile?: {
        loadBalancerProfile?: {
          effectiveOutboundIPs?: Array<{ id?: string }>;
        };
      };
    };
  }>(
    tok.accessToken,
    `/subscriptions/${subscriptionId}/resourceGroups/${encodeURIComponent(
      resourceGroup,
    )}/providers/Microsoft.ContainerService/managedClusters/${encodeURIComponent(clusterName)}?api-version=${AKS_API}`,
  );
  if (!cluster.ok) return { ok: false, error: `Couldn't read the AKS cluster: ${cluster.error}` };

  const ipResourceIds = (
    cluster.data.properties?.networkProfile?.loadBalancerProfile?.effectiveOutboundIPs ?? []
  )
    .map((o) => o.id)
    .filter((id): id is string => !!id);

  if (ipResourceIds.length === 0) {
    return {
      ok: false,
      error:
        "The cluster reports no effective outbound IPs. It may use a NAT gateway or user-defined routing, in which case the egress address must be allowed on the database manually.",
    };
  }

  // Each entry is a publicIPAddresses resource id — resolve to the actual IP.
  const ips: string[] = [];
  for (const id of ipResourceIds) {
    const pip = await arm<{ properties?: { ipAddress?: string } }>(
      tok.accessToken,
      `${id}?api-version=2023-09-01`,
    );
    const ip = pip.ok ? pip.data.properties?.ipAddress : undefined;
    if (ip) ips.push(ip);
  }
  if (ips.length === 0) {
    return { ok: false, error: "Resolved the cluster's outbound IP resources but none carried an address yet." };
  }
  return { ok: true, ips };
}

export type PgNetworkFix =
  | {
      ok: true;
      /** True when a firewall rule was actually created. */
      changed: boolean;
      /** IPs that are now allowed. */
      allowedIps: string[];
      /** Rules that already existed and needed no change. */
      alreadyAllowed: string[];
      message: string;
      warnings: string[];
    }
  | { ok: false; error: string };

/**
 * Make a Flexible Server reachable from an AKS cluster by allowing the
 * cluster's outbound IPs through the server firewall.
 *
 * Deliberately narrow, mirroring rds-network.ts:
 *   • One /32 rule per outbound IP — never 0.0.0.0/0.
 *   • Purely additive. Existing rules (including stale ones from a previous
 *     cluster) are left alone; revoking is a human judgement call.
 *   • Private-access servers are detected and reported, not "fixed" — a
 *     firewall rule does nothing for a VNet-integrated server, and silently
 *     succeeding there would be worse than saying so.
 */
export async function ensurePostgresReachableFromAks(args: {
  cloudProviderId: string;
  subscriptionId: string;
  server: AzurePgServer;
  clusterResourceGroup: string;
  clusterName: string;
}): Promise<PgNetworkFix> {
  const { cloudProviderId, subscriptionId, server, clusterResourceGroup, clusterName } = args;
  const warnings: string[] = [];

  if (!server.publicAccess) {
    return {
      ok: false,
      error:
        `"${server.name}" uses PRIVATE access (VNet integration), so firewall rules don't apply. ` +
        `Reachability depends on the AKS cluster's VNet being the same as, or peered with, the ` +
        `server's VNet${server.delegatedSubnetId ? ` (${server.delegatedSubnetId})` : ""}. ` +
        `Peer the VNets, then connect again — the Secret write and Deployment wiring will work unchanged.`,
    };
  }

  const tok = await getAzureAccessToken(cloudProviderId);
  if (!tok.ok) return { ok: false, error: tok.error };

  const egress = await getAksOutboundIps(
    cloudProviderId,
    subscriptionId,
    clusterResourceGroup,
    clusterName,
  );
  if (!egress.ok) return { ok: false, error: egress.error };

  const provider = server.engine === "mysql" ? "Microsoft.DBforMySQL" : "Microsoft.DBforPostgreSQL";
  const apiVersion = server.engine === "mysql" ? MYSQL_API : PG_API;
  const base = `/subscriptions/${subscriptionId}/resourceGroups/${encodeURIComponent(
    server.resourceGroup,
  )}/providers/${provider}/flexibleServers/${encodeURIComponent(server.name)}`;

  // Existing rules — so a repeat connect is a no-op instead of churning ARM.
  const existing = await arm<{
    value?: Array<{ name?: string; properties?: { startIpAddress?: string; endIpAddress?: string } }>;
  }>(tok.accessToken, `${base}/firewallRules?api-version=${apiVersion}`);
  const allowedAlready = new Set<string>();
  if (existing.ok) {
    for (const r of existing.data.value ?? []) {
      const s = r.properties?.startIpAddress;
      const e = r.properties?.endIpAddress;
      if (s && e && s === e) allowedAlready.add(s);
      // A rule spanning a range (or 0.0.0.0-255.255.255.255) is reported as a
      // warning: it already grants access, but far more broadly than we would.
      if (s && e && s !== e) {
        warnings.push(`Existing rule "${r.name}" allows the range ${s}–${e}, which is broader than a single cluster IP.`);
      }
    }
  }

  // A Flexible Server rejects firewall-rule writes while it is still
  // provisioning or applying another change, and reports that as an OPAQUE
  // ARM 500 ("An unexpected error occured... Tracking ID: ...") rather than a
  // state error. Wait for Ready before writing, so a connect attempted right
  // after server creation doesn't fail for a reason the message never
  // explains. Bounded — if it never settles we still try, and surface the
  // real error.
  const readyDeadline = Date.now() + 90_000;
  for (;;) {
    const state = await arm<{ properties?: { state?: string } }>(
      tok.accessToken,
      `${base}?api-version=${apiVersion}`,
    );
    const s = state.ok ? state.data.properties?.state : undefined;
    if (!s || s === "Ready") break;
    if (Date.now() > readyDeadline) {
      warnings.push(
        `Server reported state "${s}" rather than "Ready" after 90s; attempted the firewall rule anyway.`,
      );
      break;
    }
    await new Promise((r) => setTimeout(r, 5_000));
  }

  const allowedIps: string[] = [];
  const alreadyAllowed: string[] = [];
  for (const ip of egress.ips) {
    if (allowedAlready.has(ip)) {
      alreadyAllowed.push(ip);
      continue;
    }
    // Rule names are limited to alphanumerics + hyphens; dots aren't valid.
    const ruleName = `aks-${clusterName}-${ip.replace(/\./g, "-")}`.slice(0, 79);

    // Retry the PUT — ARM returns a transient 500 when another operation on
    // the server is still in flight (backup config, HA setup, a concurrent
    // rule write). Three attempts with backoff covers the realistic window
    // without hanging the request.
    let put = await arm(
      tok.accessToken,
      `${base}/firewallRules/${encodeURIComponent(ruleName)}?api-version=${apiVersion}`,
      {
        method: "PUT",
        body: JSON.stringify({ properties: { startIpAddress: ip, endIpAddress: ip } }),
      },
    );
    for (let attempt = 1; attempt < 3 && !put.ok; attempt++) {
      // Only worth retrying a transient/conflict shape; a 403 or a bad name
      // fails identically every time.
      if (!/unexpected error|conflict|another operation|try again|500|429/i.test(put.error)) break;
      await new Promise((r) => setTimeout(r, 8_000 * attempt));
      put = await arm(
        tok.accessToken,
        `${base}/firewallRules/${encodeURIComponent(ruleName)}?api-version=${apiVersion}`,
        {
          method: "PUT",
          body: JSON.stringify({ properties: { startIpAddress: ip, endIpAddress: ip } }),
        },
      );
    }
    if (!put.ok) {
      return {
        ok: false,
        error:
          `Creating the firewall rule for ${ip} failed after 3 attempts: ${put.error}. ` +
          `Add it manually with: az postgres flexible-server firewall-rule create ` +
          `--resource-group ${server.resourceGroup} --name ${server.name} ` +
          `--rule-name ${ruleName} --start-ip-address ${ip} --end-ip-address ${ip}`,
      };
    }
    allowedIps.push(ip);
  }

  const changed = allowedIps.length > 0;
  return {
    ok: true,
    changed,
    allowedIps,
    alreadyAllowed,
    warnings,
    message: changed
      ? `Allowed ${allowedIps.join(", ")} on "${server.name}" so the cluster's pods can reach it.`
      : `"${server.name}" already allowed the cluster's outbound IP(s) ${alreadyAllowed.join(", ")} — no change needed.`,
  };
}

/**
 * Allow-list PostgreSQL extensions on a Flexible Server.
 *
 * WHY THIS EXISTS (2026-07 incident):
 * Azure blocks EVERY Postgres extension unless it is named in the server's
 * `azure.extensions` parameter. A Prisma schema declaring
 * `extensions = [vector]` therefore fails its very FIRST migration statement:
 *
 *     ERROR: extension "vector" is not allow-listed for "azure_pg_admin" users
 *
 * The migration aborts before creating a single table, so the app comes up
 * against an empty database and every query 500s with "table does not exist".
 * Re-running the migration changes nothing — the wall is server config, not
 * the migration.
 *
 * AWS RDS allows pgvector out of the box, so this class of failure is
 * invisible until the same app is deployed to Azure.
 *
 * The parameter is a COMMA-SEPARATED list and setting it REPLACES the whole
 * value, so we merge with whatever is already allowed rather than clobbering
 * another app's extensions on a shared server. No restart required —
 * `azure.extensions` is dynamic.
 */
export async function allowPostgresExtensions(args: {
  cloudProviderId: string;
  subscriptionId: string;
  server: AzurePgServer;
  /** Extension names from the app's schema, e.g. ["vector", "postgis"]. */
  extensions: string[];
}): Promise<
  { ok: true; changed: boolean; allowed: string[]; message: string } | { ok: false; error: string }
> {
  const { cloudProviderId, subscriptionId, server, extensions } = args;
  const wanted = extensions.map((e) => e.trim().toLowerCase()).filter(Boolean);
  if (wanted.length === 0) {
    return { ok: true, changed: false, allowed: [], message: "No extensions required." };
  }

  const tok = await getAzureAccessToken(cloudProviderId);
  if (!tok.ok) return { ok: false, error: tok.error };

  const provider = server.engine === "mysql" ? "Microsoft.DBforMySQL" : "Microsoft.DBforPostgreSQL";
  const apiVersion = server.engine === "mysql" ? MYSQL_API : PG_API;
  const paramPath =
    `/subscriptions/${subscriptionId}/resourceGroups/${encodeURIComponent(server.resourceGroup)}` +
    `/providers/${provider}/flexibleServers/${encodeURIComponent(server.name)}` +
    `/configurations/azure.extensions?api-version=${apiVersion}`;

  const current = await arm<{ properties?: { value?: string } }>(tok.accessToken, paramPath);
  const already = (current.ok ? (current.data.properties?.value ?? "") : "")
    .split(",")
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);

  const missing = wanted.filter((e) => !already.includes(e));
  if (missing.length === 0) {
    return {
      ok: true,
      changed: false,
      allowed: already,
      message: `Extensions already allow-listed: ${wanted.join(", ")}.`,
    };
  }

  const merged = [...already, ...missing];
  const put = await arm(tok.accessToken, paramPath, {
    method: "PUT",
    body: JSON.stringify({ properties: { value: merged.join(","), source: "user-override" } }),
  });
  if (!put.ok) {
    return {
      ok: false,
      error:
        `Couldn't allow-list ${missing.join(", ")} on "${server.name}": ${put.error}. ` +
        `Set it manually: Portal → ${server.name} → Server parameters → azure.extensions → tick ${missing.join(", ").toUpperCase()}.`,
    };
  }
  return {
    ok: true,
    changed: true,
    allowed: merged,
    message: `Allow-listed ${missing.join(", ")} on "${server.name}" (required by the app's schema).`,
  };
}

/** Build the connection URL the app's Secret will carry. */
export function buildAzureDbUrl(args: {
  engine: "postgres" | "mysql";
  fqdn: string;
  user: string;
  password: string;
  database: string;
}): string {
  const { engine, fqdn, user, password, database } = args;
  const scheme = engine === "mysql" ? "mysql" : "postgresql";
  const port = engine === "mysql" ? 3306 : 5432;
  // Azure Flexible Server requires TLS by default; without sslmode the driver
  // negotiates plaintext and the server closes the connection with a message
  // that doesn't mention TLS at all.
  const suffix = engine === "mysql" ? "?ssl=true" : "?sslmode=require";
  return `${scheme}://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${fqdn}:${port}/${database}${suffix}`;
}
