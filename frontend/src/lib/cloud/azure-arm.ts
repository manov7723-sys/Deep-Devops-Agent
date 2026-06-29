/**
 * Azure Resource Manager (ARM) REST helpers.
 *
 * App-managed Azure access: everything here uses a service-principal access
 * token (minted by `getAzureAccessToken` from credentials stored on the
 * CloudProvider) and the public ARM endpoint — NO local `az` CLI and no host
 * login. This is the Azure equivalent of the GCP token + Compute REST helpers,
 * so the same code path works on a server or behind a mobile client.
 *
 * Transport: Node's raw HTTPS client (`node:https`), NOT global `fetch`.
 * Next.js patches `globalThis.fetch` for caching/instrumentation, and that
 * wrapper was mangling ARM POST *action* calls (GET worked, POST returned a
 * bogus "404: Page Not Found"). Using the raw client bypasses the patch.
 */
import { request as httpsRequest } from "node:https";
import { getAksAadToken } from "@/lib/cloud/azure";

const ARM = "https://management.azure.com";

type RawResponse = { status: number; statusText: string; location: string | null; text: string };

/** One HTTPS round-trip via node:https — bypasses Next's patched global fetch. */
function rawHttps(
  urlStr: string,
  opts: { method: string; headers: Record<string, string>; body?: string },
): Promise<RawResponse> {
  return new Promise((resolve, reject) => {
    let u: URL;
    try {
      u = new URL(urlStr);
    } catch {
      reject(new Error(`Bad URL: ${urlStr}`));
      return;
    }
    const req = httpsRequest(
      {
        protocol: u.protocol,
        hostname: u.hostname,
        port: u.port || 443,
        path: `${u.pathname}${u.search}`,
        method: opts.method,
        headers: opts.headers,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            statusText: res.statusMessage ?? "",
            location: (res.headers.location as string | undefined) ?? null,
            text: data,
          }),
        );
      },
    );
    req.on("error", reject);
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function armFetch(
  token: string,
  path: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string },
): Promise<{ ok: true; data: unknown } | { ok: false; error: string }> {
  const method = (init?.method ?? "GET").toUpperCase();
  // Re-attach the bearer token on every hop (we follow redirects manually so a
  // regional redirect can't drop the Authorization header).
  const reqHeaders: Record<string, string> = { Authorization: `Bearer ${token}`, Accept: "application/json", ...(init?.headers ?? {}) };
  const trail: string[] = [];
  let url = `${ARM}${path}`;
  let res: RawResponse;
  try {
    for (let hop = 0; ; hop++) {
      const host = (() => { try { return new URL(url).host; } catch { return url; } })();
      trail.push(`${method} ${host}`);
      res = await rawHttps(url, { method, headers: reqHeaders, body: init?.body });
      if ((res.status === 301 || res.status === 302 || res.status === 307 || res.status === 308) && res.location && hop < 4) {
        const nextUrl = res.location.startsWith("http") ? res.location : `${ARM}${res.location}`;
        console.error(`[azure-arm] ${res.status} redirect ${method} -> ${nextUrl}`);
        url = nextUrl;
        continue;
      }
      break;
    }
  } catch (err) {
    return { ok: false, error: `Network error reaching Azure: ${err instanceof Error ? err.message : "unknown"}` };
  }
  if (res.status < 200 || res.status >= 300) {
    const body = res.text;
    const host = (() => { try { return new URL(url).host; } catch { return url; } })();
    console.error(
      `[azure-arm] ${method} ${ARM}${path} -> ${res.status} ${res.statusText}` +
        ` (final host: ${host}; hops: ${trail.join(" → ")}) :: ${body.slice(0, 300)}`,
    );
    // Surface the ARM error message (e.g. AuthorizationFailed, NotFound).
    let msg = `Azure returned ${res.status}`;
    try {
      const j = JSON.parse(body) as { error?: { message?: string; code?: string } };
      if (j.error?.message) msg = j.error.message;
      else if (j.error?.code) msg = j.error.code;
    } catch {
      // Non-JSON body: embed the request trail so it's visible in the UI.
      msg = `${res.status} ${res.statusText || ""} "${body.slice(0, 80)}" [host=${host}, hops=${trail.join(" → ")}]`;
    }
    return { ok: false, error: msg };
  }
  try {
    return { ok: true, data: JSON.parse(res.text || "{}") };
  } catch {
    return { ok: true, data: {} };
  }
}

/** Decode an Azure access token (JWT) to reveal which identity the app is
 *  acting as — a user (upn/email) or a service principal (appid). Best-effort. */
function tokenIdentity(jwt: string): string {
  try {
    const payload = JSON.parse(Buffer.from(jwt.split(".")[1] ?? "", "base64").toString("utf8")) as {
      upn?: string; unique_name?: string; email?: string; appid?: string; app_displayname?: string; oid?: string; idtyp?: string;
    };
    if (payload.upn || payload.unique_name || payload.email) return `user ${payload.upn || payload.unique_name || payload.email}`;
    if (payload.appid) return `service principal ${payload.app_displayname ? `"${payload.app_displayname}" ` : ""}(appid ${payload.appid})`;
    return payload.oid ? `identity ${payload.oid}` : "unknown identity";
  } catch {
    return "unknown identity";
  }
}

/** Parse the resource group out of an ARM resource id. */
function rgFromId(id: string): string {
  const m = id.match(/\/resourceGroups\/([^/]+)/i);
  return m ? m[1] : "";
}

export type AksClusterInfo = { name: string; resourceGroup: string; location: string };

/**
 * List every AKS cluster in the subscription (name + resource group + location)
 * — the REST equivalent of `az aks list`. Read-only, works over OAuth. Powers
 * the "pick a resource group, pick a cluster" dropdowns.
 */
export async function listAksClusters(
  token: string,
  subscriptionId: string,
): Promise<{ ok: true; clusters: AksClusterInfo[] } | { ok: false; error: string }> {
  const r = await armFetch(token, `/subscriptions/${subscriptionId.trim()}/providers/Microsoft.ContainerService/managedClusters?api-version=${AKS_API_VERSIONS[1]}`);
  if (!r.ok) return { ok: false, error: r.error };
  const list = (r.data as { value?: Array<{ name?: string; id?: string; location?: string }> }).value ?? [];
  return {
    ok: true,
    clusters: list.map((c) => ({ name: c.name ?? "", resourceGroup: rgFromId(c.id ?? ""), location: c.location ?? "" })),
  };
}

/**
 * Find an AKS cluster by NAME across all resource groups in the subscription —
 * the REST equivalent of `az aks list --query "[?name=='X']"`. Lets the user
 * connect by cluster name alone; we auto-detect its resource group. Read-only,
 * works over OAuth (unlike the credential fetch).
 */
export async function findAksClusterByName(
  token: string,
  subscriptionId: string,
  clusterName: string,
): Promise<{ ok: true; resourceGroup: string; location: string } | { ok: false; error: string }> {
  const r = await armFetch(token, `/subscriptions/${subscriptionId.trim()}/providers/Microsoft.ContainerService/managedClusters?api-version=${AKS_API_VERSIONS[1]}`);
  if (!r.ok) return { ok: false, error: r.error };
  const list = (r.data as { value?: Array<{ name?: string; id?: string; location?: string }> }).value ?? [];
  const want = clusterName.trim().toLowerCase();
  const match = list.find((c) => (c.name ?? "").toLowerCase() === want);
  if (!match) {
    const names = list.map((c) => c.name).filter(Boolean).join(", ");
    return { ok: false, error: `No AKS cluster named "${clusterName}" in this subscription.${names ? ` Found: ${names}.` : " No clusters found."}` };
  }
  return { ok: true, resourceGroup: rgFromId(match.id ?? ""), location: match.location ?? "" };
}

/** The tenant that owns a subscription (needed to mint a tenant-scoped token
 *  for personal-account owners). Null on failure. */
export async function getSubscriptionTenant(token: string, subscriptionId: string): Promise<string | null> {
  const r = await armFetch(token, `/subscriptions/${subscriptionId}?api-version=2020-01-01`);
  if (!r.ok) return null;
  return (r.data as { tenantId?: string }).tenantId ?? null;
}

export type AzureResourceGroup = { name: string; location: string };
export type AzureSubnet = { name: string; id: string; addressPrefix: string };
export type AzureVnet = { name: string; resourceGroup: string; location: string; subnets: AzureSubnet[] };

export async function listAzureResourceGroups(
  token: string,
  subscriptionId: string,
): Promise<{ ok: true; resourceGroups: AzureResourceGroup[] } | { ok: false; error: string }> {
  const r = await armFetch(token, `/subscriptions/${subscriptionId}/resourcegroups?api-version=2021-04-01`);
  if (!r.ok) return r;
  const value = (r.data as { value?: Array<{ name?: string; location?: string }> }).value ?? [];
  return { ok: true, resourceGroups: value.map((g) => ({ name: g.name ?? "", location: g.location ?? "" })) };
}

export async function listAzureVnets(
  token: string,
  subscriptionId: string,
): Promise<{ ok: true; vnets: AzureVnet[] } | { ok: false; error: string }> {
  const r = await armFetch(
    token,
    `/subscriptions/${subscriptionId}/providers/Microsoft.Network/virtualNetworks?api-version=2023-09-01`,
  );
  if (!r.ok) return r;
  const value = (r.data as {
    value?: Array<{
      id?: string; name?: string; location?: string;
      properties?: { subnets?: Array<{ id?: string; name?: string; properties?: { addressPrefix?: string } }> };
    }>;
  }).value ?? [];
  const vnets: AzureVnet[] = value.map((v) => ({
    name: v.name ?? "",
    resourceGroup: rgFromId(v.id ?? ""),
    location: v.location ?? "",
    subnets: (v.properties?.subnets ?? []).map((s) => ({
      name: s.name ?? "",
      id: s.id ?? "",
      addressPrefix: s.properties?.addressPrefix ?? "",
    })),
  }));
  return { ok: true, vnets };
}

/**
 * Fetch an AKS cluster's kubeconfig via ARM (no `az`). Admin credentials are
 * cert-based and self-contained, so `kubectl` works with no extra plugin; if
 * local accounts are disabled we fall back to user credentials.
 */
// api-versions to try for the list-credentials actions (newest first). The
// action exists across all of these; trying a few guards against a version that
// a given tenant/cluster hasn't surfaced.
const AKS_API_VERSIONS = ["2024-09-01", "2024-05-01", "2024-02-01", "2023-10-01"];

/** Ask Azure for the newest stable api-version of managedClusters (null on failure). */
async function latestManagedClustersApiVersion(token: string, subscriptionId: string): Promise<string | null> {
  const r = await armFetch(token, `/subscriptions/${subscriptionId}/providers/Microsoft.ContainerService?api-version=2022-12-01`);
  if (!r.ok) return null;
  const rt = (r.data as { resourceTypes?: Array<{ resourceType?: string; apiVersions?: string[] }> }).resourceTypes ?? [];
  const mc = rt.find((t) => t.resourceType === "managedClusters");
  // apiVersions are returned newest-first; skip preview versions.
  return mc?.apiVersions?.find((v) => !v.includes("preview")) ?? null;
}

/**
 * Build a self-contained, token-based kubeconfig from an Entra/AAD cluster's
 * (exec-based) user kubeconfig: keep its CA + server, mint an AKS-scoped token
 * from the stored service principal, and drop the kubelogin exec block. Result
 * works with plain `kubectl` server-side — no kubelogin, no `az`.
 */
async function toTokenKubeconfig(
  userYaml: string,
  cloudProviderId: string,
): Promise<{ ok: true; kubeconfig: string } | { ok: false; error: string }> {
  const ca = userYaml.match(/certificate-authority-data:\s*([A-Za-z0-9+/=]+)/)?.[1];
  const server = userYaml.match(/server:\s*(\S+)/)?.[1];
  if (!ca || !server) return { ok: false, error: "couldn't parse the cluster CA/server from the kubeconfig" };
  const tok = await getAksAadToken(cloudProviderId);
  if (!tok.ok) return { ok: false, error: `couldn't mint an AAD token for the cluster: ${tok.error}` };
  const kubeconfig = `apiVersion: v1
kind: Config
clusters:
- cluster:
    certificate-authority-data: ${ca}
    server: ${server}
  name: aks
contexts:
- context:
    cluster: aks
    user: aks-aad
  name: aks
current-context: aks
users:
- name: aks-aad
  user:
    token: ${tok.accessToken}
`;
  return { ok: true, kubeconfig };
}

export async function getAksKubeconfig(
  token: string,
  subscriptionId: string,
  resourceGroup: string,
  clusterName: string,
  cloudProviderId: string,
): Promise<{ ok: true; kubeconfig: string; mode: "admin" | "user" } | { ok: false; error: string }> {
  const rg = resourceGroup.trim();
  const name = clusterName.trim();
  const base = `/subscriptions/${subscriptionId.trim()}/resourceGroups/${encodeURIComponent(rg)}/providers/Microsoft.ContainerService/managedClusters/${encodeURIComponent(name)}`;
  const where = `resource group "${rg}", subscription ${subscriptionId.trim()}`;

  // 1 — Confirm the cluster exists in THIS subscription/RG, so a wrong name or a
  // cluster that lives in a different subscription gives a precise error.
  const found = await armFetch(token, `${base}?api-version=${AKS_API_VERSIONS[1]}`);
  if (!found.ok) {
    return { ok: false, error: `Couldn't find AKS cluster "${name}" in ${where}. Azure said: ${found.error}` };
  }
  // Inspect the cluster's state — Azure refuses to issue a kubeconfig for a
  // cluster that isn't fully provisioned, returning a misleading 404 on the
  // credential actions. Short-circuit with a clear, actionable message.
  const props = (found.data as { id?: string; properties?: { provisioningState?: string; powerState?: { code?: string } } }).properties;
  const provisioning = props?.provisioningState ?? "Unknown";
  const power = props?.powerState?.code ?? "Unknown";
  const state = `provisioningState=${provisioning}, powerState=${power}`;
  console.error(`[azure-arm] AKS GET ok: ${(found.data as { id?: string }).id ?? "(no id)"} (${state})`);

  if (power === "Stopped") {
    return { ok: false, error: `AKS cluster "${name}" is stopped. Start it (Azure Portal → the cluster → Start, or \`az aks start -g ${rg} -n ${name}\`), then connect again.` };
  }
  if (provisioning !== "Succeeded") {
    const failed = provisioning === "Failed";
    return {
      ok: false,
      error: failed
        ? `AKS cluster "${name}" is in a Failed provisioning state, so Azure won't issue its kubeconfig. The cluster didn't finish creating — open it in the Azure Portal (the cluster → Diagnose and solve problems / Activity log) to see why, then repair it (\`az aks update -g ${rg} -n ${name}\`) or delete and recreate it. Once it shows "Succeeded", connect again.`
        : `AKS cluster "${name}" isn't ready yet (provisioningState=${provisioning}). Wait until it shows "Succeeded", then connect again.`,
    };
  }

  const extract = (data: unknown): string | null => {
    const kc = (data as { kubeconfigs?: Array<{ value?: string }> }).kubeconfigs?.[0]?.value;
    if (!kc) return null;
    try {
      return Buffer.from(kc, "base64").toString("utf8");
    } catch {
      return null;
    }
  };

  // ARM list-action POSTs expect a JSON content-type + (empty) body; a bodyless
  // POST can make the gateway return a bare "404: Page Not Found".
  const post = (path: string) =>
    armFetch(token, path, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });

  // Use the api-version Azure currently advertises for managedClusters (so a
  // retired hardcoded version can't be the cause), then the static fallbacks.
  const liveVersion = await latestManagedClustersApiVersion(token, subscriptionId.trim());
  const versions = liveVersion ? [liveVersion, ...AKS_API_VERSIONS.filter((v) => v !== liveVersion)] : AKS_API_VERSIONS;

  // 2 — Fetch the kubeconfig. Try USER credentials first (granted by the
  // least-privilege "Azure Kubernetes Service Cluster User Role"), then ADMIN
  // (needs the Cluster Admin Role). Entra/AAD clusters return an exec
  // (kubelogin) kubeconfig — convert it to a self-contained token kubeconfig;
  // cert-based ones pass through as-is.
  let lastErr = "no response";
  const tryCreds = async (action: string, v: string): Promise<{ kubeconfig: string } | null> => {
    const res = await post(`${base}/${action}?api-version=${v}`);
    if (!res.ok) { lastErr = res.error; return null; }
    const kc = extract(res.data);
    if (!kc) { lastErr = "empty kubeconfig"; return null; }
    if (/\bexec:/.test(kc)) {
      const conv = await toTokenKubeconfig(kc, cloudProviderId);
      if (conv.ok) return { kubeconfig: conv.kubeconfig };
      lastErr = conv.error;
      return null;
    }
    return { kubeconfig: kc };
  };

  for (const v of versions) {
    // ARM credential actions are SINGULAR (listClusterUserCredential); the plural
    // form returns a bare "404: Page Not Found" from the gateway.
    const user = await tryCreds("listClusterUserCredential", v);
    if (user) return { ok: true, kubeconfig: user.kubeconfig, mode: "user" };
    const admin = await tryCreds("listClusterAdminCredential", v);
    if (admin) return { ok: true, kubeconfig: admin.kubeconfig, mode: "admin" };
  }

  // Diagnose: a non-JSON "Page Not Found" can't come from Azure's API. Fire a
  // benign control POST (Resource Graph) — if it's ALSO blocked, the network
  // path (VPN/proxy/security software on the host) is dropping POSTs to Azure,
  // not the app. On a real deployed server this call works.
  let diagnosis = "";
  if (/page not found/i.test(lastErr) || /\b404\b/.test(lastErr)) {
    const control = await armFetch(token, `/providers/Microsoft.ResourceGraph/resources?api-version=2021-03-01`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscriptions: [subscriptionId.trim()], query: "Resources | limit 1" }),
    });
    const who = tokenIdentity(token);
    diagnosis = control.ok
      ? ` (Note: other Azure POST calls succeed, so this is specific to the credential action. The app is acting as: ${who}. If that's a service principal / not the cluster owner, it lacks the 'listClusterAdminCredentials' permission — grant it 'Azure Kubernetes Service Cluster Admin Role'. If that IS the owner, this is a code/Azure routing issue, not permissions.)`
      : ` (Note: even a harmless Azure POST is being blocked the same way [${control.error}] — a VPN/proxy/security tool on the machine running this server is intercepting POST requests to Azure. The app code is correct; it will work on a deployed server.)`;
  }

  return {
    ok: false,
    error: `Found the cluster (${state}) but couldn't fetch its kubeconfig. Azure said: ${lastErr}${diagnosis}`,
  };
}
