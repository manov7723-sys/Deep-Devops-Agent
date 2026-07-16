/**
 * Jenkins REST client — everything the agent needs to drive a user's Jenkins
 * server without them touching the Jenkins UI after the one-time connect.
 *
 * Auth: HTTP Basic with username + API token (from AppSecret). The user creates
 * an API token once from their Jenkins user profile; we store it encrypted and
 * hit /api/json endpoints from server-side code.
 *
 * NOTE: Jenkins uses CSRF crumbs on POSTs. We fetch a crumb per request via
 * /crumbIssuer/api/json and include it in the header — no session state needed.
 */
import { prisma } from "@/lib/db/prisma";
import { decryptSecret } from "@/lib/auth/crypto";

export type JenkinsConn = {
  baseUrl: string; // trailing slash trimmed
  username: string;
  apiToken: string;
};

/**
 * Load a project's stored Jenkins connection. Returns null if not connected;
 * throws only when the encrypted token can't be decrypted (indicates key
 * rotation / DB corruption — surface loudly).
 */
export async function getJenkinsConnection(projectId: string): Promise<JenkinsConn | null> {
  const rows = await prisma.appSecret.findMany({
    where: { projectId, key: { in: ["jenkins_url", "jenkins_username", "jenkins_token"] } },
    select: { key: true, valueRef: true },
  });
  const url = rows.find((r) => r.key === "jenkins_url")?.valueRef;
  const username = rows.find((r) => r.key === "jenkins_username")?.valueRef;
  const encToken = rows.find((r) => r.key === "jenkins_token")?.valueRef;
  if (!url || !username || !encToken) return null;
  return {
    baseUrl: url.replace(/\/+$/, ""),
    // Username is stored plain (not sensitive); URL likewise.
    username,
    apiToken: decryptSecret(encToken),
  };
}

type CrumbResponse = { crumb: string; crumbRequestField: string };

/**
 * Fetch a CSRF crumb. Jenkins issues one via /crumbIssuer; some hardened
 * setups disable CSRF entirely, in which case we return null and skip the
 * header. Either way non-fatal — the caller proceeds without a crumb.
 */
async function getCrumb(conn: JenkinsConn): Promise<{ header: string; value: string } | null> {
  const url = `${conn.baseUrl}/crumbIssuer/api/json`;
  try {
    const res = await fetch(url, { headers: authHeaders(conn), cache: "no-store" });
    if (!res.ok) return null;
    const j = (await res.json()) as CrumbResponse;
    if (!j.crumb || !j.crumbRequestField) return null;
    return { header: j.crumbRequestField, value: j.crumb };
  } catch {
    return null;
  }
}

function authHeaders(conn: JenkinsConn): Record<string, string> {
  const b64 = Buffer.from(`${conn.username}:${conn.apiToken}`).toString("base64");
  return { Authorization: `Basic ${b64}`, Accept: "application/json" };
}

async function post(
  conn: JenkinsConn,
  path: string,
  body?: { xml?: string; form?: Record<string, string> },
): Promise<{ ok: true; status: number; headers: Headers; body: string } | { ok: false; error: string; status?: number }> {
  const crumb = await getCrumb(conn);
  const headers: Record<string, string> = { ...authHeaders(conn) };
  if (crumb) headers[crumb.header] = crumb.value;
  let bodyStr: string | undefined;
  if (body?.xml) {
    headers["Content-Type"] = "application/xml";
    bodyStr = body.xml;
  } else if (body?.form) {
    headers["Content-Type"] = "application/x-www-form-urlencoded";
    bodyStr = new URLSearchParams(body.form).toString();
  }
  let res: Response;
  try {
    res = await fetch(`${conn.baseUrl}${path}`, { method: "POST", headers, body: bodyStr, cache: "no-store" });
  } catch (err) {
    return { ok: false, error: `Network error: ${err instanceof Error ? err.message : "unknown"}` };
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    return { ok: false, error: `Jenkins ${res.status}: ${t.slice(0, 400) || res.statusText}`, status: res.status };
  }
  const text = await res.text();
  return { ok: true, status: res.status, headers: res.headers, body: text };
}

async function getJson<T>(
  conn: JenkinsConn,
  path: string,
): Promise<{ ok: true; data: T } | { ok: false; error: string; status?: number }> {
  let res: Response;
  try {
    res = await fetch(`${conn.baseUrl}${path}`, { headers: authHeaders(conn), cache: "no-store" });
  } catch (err) {
    return { ok: false, error: `Network error: ${err instanceof Error ? err.message : "unknown"}` };
  }
  if (!res.ok) {
    return { ok: false, error: `Jenkins ${res.status} ${res.statusText}`, status: res.status };
  }
  return { ok: true, data: (await res.json()) as T };
}

/** GET /api/json — the cheapest possible auth + connectivity probe. */
export async function verifyJenkins(conn: JenkinsConn): Promise<
  { ok: true; version: string | null; user: string } | { ok: false; error: string }
> {
  const r = await getJson<{ mode: string; nodeName: string }>(conn, "/api/json?tree=mode,nodeName");
  if (!r.ok) return { ok: false, error: r.error };
  // whoAmI confirms the token is valid for THIS user (not just anonymous).
  const who = await getJson<{ name: string; authenticated: boolean }>(conn, "/whoAmI/api/json");
  if (!who.ok) return { ok: false, error: who.error };
  if (!who.data.authenticated || !who.data.name || who.data.name === "anonymous") {
    return { ok: false, error: "Jenkins accepted the request but returned anonymous — token is wrong or expired." };
  }
  return { ok: true, version: null, user: who.data.name };
}

/**
 * Create-or-update a job (pipeline) with the given config.xml. Idempotent:
 * if the job exists we update its config; otherwise we create it.
 */
export async function ensureJob(
  conn: JenkinsConn,
  jobName: string,
  configXml: string,
): Promise<{ ok: true; created: boolean; url: string } | { ok: false; error: string }> {
  const jobUrl = `${conn.baseUrl}/job/${encodeURIComponent(jobName)}`;
  // Does it exist?
  const existing = await getJson<{ name: string }>(conn, `/job/${encodeURIComponent(jobName)}/api/json?tree=name`);
  if (existing.ok) {
    const upd = await post(conn, `/job/${encodeURIComponent(jobName)}/config.xml`, { xml: configXml });
    if (!upd.ok) return { ok: false, error: `Updating job "${jobName}": ${upd.error}` };
    return { ok: true, created: false, url: jobUrl };
  }
  // Not found — create.
  const create = await post(conn, `/createItem?name=${encodeURIComponent(jobName)}`, { xml: configXml });
  if (!create.ok) return { ok: false, error: `Creating job "${jobName}": ${create.error}` };
  return { ok: true, created: true, url: jobUrl };
}

/**
 * Trigger a build. Returns the queue item URL — the caller polls that to
 * discover the eventual build number, then polls the build for status.
 */
export async function triggerBuild(
  conn: JenkinsConn,
  jobName: string,
  parameters?: Record<string, string>,
): Promise<{ ok: true; queueUrl: string } | { ok: false; error: string }> {
  const hasParams = parameters && Object.keys(parameters).length > 0;
  const path = hasParams
    ? `/job/${encodeURIComponent(jobName)}/buildWithParameters`
    : `/job/${encodeURIComponent(jobName)}/build`;
  const res = await post(conn, path, hasParams ? { form: parameters } : undefined);
  if (!res.ok) return { ok: false, error: res.error };
  // 201 Created with a Location header pointing at the queue item.
  const loc = res.headers.get("location");
  if (!loc) return { ok: false, error: "Jenkins accepted the build but returned no queue URL." };
  return { ok: true, queueUrl: loc };
}

/**
 * Wait until the queue item is assigned a build number (or the queue rejects it).
 * Polls every 2s up to `timeoutMs` (default 60s).
 */
export async function resolveBuildNumber(
  conn: JenkinsConn,
  queueUrl: string,
  timeoutMs = 60_000,
): Promise<{ ok: true; buildNumber: number; buildUrl: string } | { ok: false; error: string }> {
  // queueUrl points at ..../queue/item/<id>/ — its api/json returns { executable: { number, url } } once picked up.
  const apiPath = queueUrl.replace(/\/+$/, "") + "/api/json";
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    let r: Response;
    try {
      r = await fetch(apiPath, { headers: authHeaders(conn), cache: "no-store" });
    } catch {
      await new Promise((res) => setTimeout(res, 2000));
      continue;
    }
    if (r.ok) {
      const j = (await r.json()) as { cancelled?: boolean; why?: string; executable?: { number: number; url: string } };
      if (j.cancelled) return { ok: false, error: "Build was cancelled from the queue." };
      if (j.executable) return { ok: true, buildNumber: j.executable.number, buildUrl: j.executable.url };
    }
    await new Promise((res) => setTimeout(res, 2000));
  }
  return { ok: false, error: "Timed out waiting for Jenkins to pick up the build." };
}

/**
 * Poll a build until it finishes. Returns the final result (SUCCESS / FAILURE /
 * UNSTABLE / ABORTED) + duration + a chunk of console output.
 */
export async function waitForBuild(
  conn: JenkinsConn,
  jobName: string,
  buildNumber: number,
  timeoutMs = 30 * 60_000,
): Promise<
  | { ok: true; result: string; durationMs: number; url: string; consoleTail: string }
  | { ok: false; error: string }
> {
  const start = Date.now();
  const buildBase = `/job/${encodeURIComponent(jobName)}/${buildNumber}`;
  while (Date.now() - start < timeoutMs) {
    const r = await getJson<{ building: boolean; result: string | null; duration: number; url: string }>(
      conn,
      `${buildBase}/api/json?tree=building,result,duration,url`,
    );
    if (r.ok && r.data.building === false && r.data.result) {
      // Grab the last ~8KB of console output for the caller's log stream.
      let tail = "";
      try {
        const cr = await fetch(`${conn.baseUrl}${buildBase}/consoleText`, {
          headers: authHeaders(conn),
          cache: "no-store",
        });
        if (cr.ok) {
          const text = await cr.text();
          tail = text.slice(-8_000);
        }
      } catch {
        /* non-fatal */
      }
      return {
        ok: true,
        result: r.data.result,
        durationMs: r.data.duration,
        url: r.data.url || `${conn.baseUrl}${buildBase}/`,
        consoleTail: tail,
      };
    }
    await new Promise((res) => setTimeout(res, 5000));
  }
  return { ok: false, error: "Timed out waiting for the build to finish." };
}

/**
 * Store or replace a credential in the system store. Jenkins credentials
 * live in /credentials/store/system/domain/_/ and are addressable by id.
 * Common kinds:
 *   - "usernamePassword" for docker/registry logins, git tokens
 *   - "string" (Secret text) for AWS access keys, API tokens
 *   - "file" (Secret file) for kubeconfigs — needs a base64 payload
 */
export async function upsertCredentialString(
  conn: JenkinsConn,
  id: string,
  description: string,
  secret: string,
): Promise<{ ok: true } | { ok: false; error: string }> {
  const xml = `<?xml version="1.0" encoding="UTF-8"?>
<org.jenkinsci.plugins.plaincredentials.impl.StringCredentialsImpl>
  <scope>GLOBAL</scope>
  <id>${escapeXml(id)}</id>
  <description>${escapeXml(description)}</description>
  <secret>${escapeXml(secret)}</secret>
</org.jenkinsci.plugins.plaincredentials.impl.StringCredentialsImpl>`;
  // Try update first (idempotent), then create if not found.
  const upd = await post(conn, `/credentials/store/system/domain/_/credential/${encodeURIComponent(id)}/config.xml`, { xml });
  if (upd.ok) return { ok: true };
  const create = await post(conn, `/credentials/store/system/domain/_/createCredentials`, { xml });
  if (!create.ok) return { ok: false, error: `Upserting credential "${id}": ${create.error}` };
  return { ok: true };
}

function escapeXml(s: string): string {
  return s.replace(/[<>&'"]/g, (c) =>
    c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === "&" ? "&amp;" : c === "'" ? "&apos;" : "&quot;",
  );
}
