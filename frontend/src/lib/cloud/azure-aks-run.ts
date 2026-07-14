/**
 * Operate an AKS cluster WITHOUT a kubeconfig, via Azure's `runCommand` action
 * (the ARM equivalent of `az aks command invoke`). Azure runs the command in an
 * ephemeral pod inside the cluster and returns the output — so the agent can
 * drive AKS using only the project's stored Azure token (OAuth or service
 * principal), sidestepping the `listClusterAdminCredentials` block that fails
 * for personal-account owners.
 *
 * Transport is node:https (not global fetch) to avoid Next's fetch patch.
 */
import { request as httpsRequest } from "node:https";
import { getAzureAccessToken } from "./azure";
import { getSubscriptionTenant, findAksClusterByName } from "./azure-arm";

const ARM_HOST = "management.azure.com";
const RUNCMD_API = "2024-05-01";

type RawResp = { status: number; location: string | null; asyncOp: string | null; text: string };

function https(method: string, urlStr: string, token: string, body?: unknown): Promise<RawResp> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve) => {
    let u: URL;
    try {
      u = new URL(urlStr);
    } catch {
      resolve({ status: 0, location: null, asyncOp: null, text: "bad url" });
      return;
    }
    const req = httpsRequest(
      {
        hostname: u.hostname,
        port: 443,
        path: `${u.pathname}${u.search}`,
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/json",
          ...(payload
            ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
            : {}),
        },
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (c) => (data += c));
        res.on("end", () =>
          resolve({
            status: res.statusCode ?? 0,
            location: (res.headers.location as string | undefined) ?? null,
            asyncOp: (res.headers["azure-asyncoperation"] as string | undefined) ?? null,
            text: data,
          }),
        );
      },
    );
    req.on("error", (e) =>
      resolve({ status: 0, location: null, asyncOp: null, text: `network error: ${e.message}` }),
    );
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export type AksRunResult =
  { ok: true; logs: string; exitCode: number } | { ok: false; error: string };

/** Pull a {logs, exitCode} command result out of an ARM response body, if present. */
function parseResult(text: string): AksRunResult | null {
  try {
    const j = JSON.parse(text) as {
      status?: string;
      properties?: { provisioningState?: string; exitCode?: number; logs?: string };
    };
    const p = j.properties;
    if (p && (p.provisioningState === "Succeeded" || typeof p.logs === "string")) {
      return { ok: true, logs: p.logs ?? "", exitCode: p.exitCode ?? 0 };
    }
  } catch {
    /* not JSON / not a result */
  }
  return null;
}

function errMessage(status: number, text: string): string {
  try {
    const j = JSON.parse(text) as { error?: { message?: string; code?: string } };
    if (j.error?.message) return j.error.message;
    if (j.error?.code) return j.error.code;
  } catch {
    /* non-JSON */
  }
  return `Azure returned ${status}${text ? `: ${text.slice(0, 200)}` : ""}`;
}

/**
 * Run a shell command (e.g. `kubectl get pods -A`) on an AKS cluster via ARM.
 * Returns the command's stdout/stderr (logs) and exit code.
 */
export async function aksRunCommand(
  providerId: string,
  subscriptionId: string,
  resourceGroup: string,
  clusterName: string,
  command: string,
): Promise<AksRunResult> {
  // Get an ARM token, scoped to the subscription's tenant when we can resolve it.
  const base = await getAzureAccessToken(providerId);
  if (!base.ok) return { ok: false, error: base.error };
  let token = base.accessToken;
  const sub = subscriptionId.trim();
  const tenant = await getSubscriptionTenant(token, sub);
  if (tenant) {
    const scoped = await getAzureAccessToken(providerId, tenant);
    if (scoped.ok) token = scoped.accessToken;
  }

  const cluster = clusterName.trim();
  // Auto-detect the resource group from the cluster name when not provided
  // (the REST equivalent of `az aks list --query "[?name=='X']"`).
  let rg = resourceGroup.trim();
  if (!rg) {
    const found = await findAksClusterByName(token, sub, cluster);
    if (!found.ok) return { ok: false, error: found.error };
    rg = found.resourceGroup;
  }
  const url =
    `https://${ARM_HOST}/subscriptions/${sub}/resourceGroups/${encodeURIComponent(rg)}` +
    `/providers/Microsoft.ContainerService/managedClusters/${encodeURIComponent(cluster)}/runCommand?api-version=${RUNCMD_API}`;

  const post = await https("POST", url, token, { command });

  // Some clusters return the result synchronously (200).
  if (post.status === 200) {
    const r = parseResult(post.text);
    if (r) return r;
  }
  if (![200, 201, 202].includes(post.status)) {
    return { ok: false, error: errMessage(post.status, post.text) };
  }

  // Async: poll the operation/result URL until it resolves.
  const pollUrl = post.asyncOp || post.location;
  if (!pollUrl) {
    return (
      parseResult(post.text) ?? {
        ok: false,
        error: "runCommand was accepted but Azure returned no result URL.",
      }
    );
  }
  const deadline = Date.now() + 180_000;
  while (Date.now() < deadline) {
    await sleep(3000);
    const p = await https("GET", pollUrl, token);
    if (p.status === 202) continue;
    if (p.status === 200) {
      const r = parseResult(p.text);
      if (r) return r;
      try {
        const j = JSON.parse(p.text) as {
          status?: string;
          properties?: { exitCode?: number; logs?: string };
        };
        if (j.status === "Succeeded") {
          return {
            ok: true,
            logs: j.properties?.logs ?? "(command succeeded; no output)",
            exitCode: j.properties?.exitCode ?? 0,
          };
        }
        if (j.status === "Failed" || j.status === "Canceled")
          return { ok: false, error: `runCommand ${j.status}` };
      } catch {
        /* keep polling */
      }
      continue;
    }
    return { ok: false, error: errMessage(p.status, p.text) };
  }
  return { ok: false, error: "Timed out waiting for the AKS command result (>3 min)." };
}

// ── "Connection by reference" marker ─────────────────────────────────────────
// When we can't fetch a real kubeconfig (e.g. personal-account owners), we store
// this marker as the env's kubeconfig blob instead. The kubectl resolver detects
// it and routes commands through runCommand — so the env still shows "connected"
// and every agent tool works, without a kubeconfig.
const AKS_RUNCMD_MARKER = "aks-runcommand";

export type AksRunMarker = { subscriptionId: string; resourceGroup: string; clusterName: string };

export function buildAksRunMarker(m: AksRunMarker): string {
  return JSON.stringify({ ddaClusterConnection: AKS_RUNCMD_MARKER, ...m });
}

/** Returns the marker fields if `blob` is an AKS run-command marker, else null. */
export function parseAksRunMarker(blob: string): AksRunMarker | null {
  try {
    const j = JSON.parse(blob) as {
      ddaClusterConnection?: string;
      subscriptionId?: string;
      resourceGroup?: string;
      clusterName?: string;
    };
    if (
      j?.ddaClusterConnection === AKS_RUNCMD_MARKER &&
      j.subscriptionId &&
      j.resourceGroup &&
      j.clusterName
    ) {
      return {
        subscriptionId: j.subscriptionId,
        resourceGroup: j.resourceGroup,
        clusterName: j.clusterName,
      };
    }
  } catch {
    /* a real kubeconfig (YAML), not a marker */
  }
  return null;
}
