/**
 * Per-env `kubectl port-forward` manager for in-cluster Grafana.
 *
 * We deliberately do NOT use the kube API-server service-proxy
 * (`/api/v1/namespaces/…/services/…/proxy`): that proxy injects an
 * `X-Forwarded-Prefix` header, and Grafana prepends it to its sub-path, so the
 * embedded Grafana emits asset URLs under the API-server proxy path and the
 * browser can't load them ("failed to load application files").
 *
 * `kubectl port-forward` instead opens a direct, authenticated TCP tunnel to the
 * Grafana pod with no injected prefix — Grafana sees only our clean sub-path, so
 * serve_from_sub_path + root_url resolve correctly. It still reuses the stored
 * kubeconfig for auth (no TLS/CA juggling in Node).
 *
 * Tunnels are cached per env and reaped after idle. The decrypted kubeconfig
 * tempfile is kept alive for the tunnel's lifetime and cleaned on reap.
 */
import { spawn, type ChildProcessByStdio } from "node:child_process";
import type { Readable } from "node:stream";
import { prisma } from "@/lib/db/prisma";
import { getKubeconfigForEnv, kubeExecEnv } from "@/lib/runner/creds";
import { NS, GRAFANA_SVC, GRAFANA_PORT } from "@/lib/observability/cluster-monitoring";

/**
 * Prometheus service name + port (mirrors the constants in cluster-monitoring
 * so a single change moves both the Grafana and Prometheus proxies). Kept here
 * to avoid a cluster-monitoring → kube-proxy → cluster-monitoring import cycle
 * that would kick in if we imported these from that module.
 */
const PROM_SVC_LOCAL = "monitoring-kube-prometheus-prometheus";
const PROM_PORT_LOCAL = "9090";

const IDLE_MS = 5 * 60_000; // reap a proxy this long after its last use
const START_TIMEOUT_MS = 15_000;

type Proc = ChildProcessByStdio<null, Readable, Readable>;

type Entry = {
  port: number;
  proc: Proc;
  cleanupKubeconfig: () => Promise<void>;
  lastUsed: number;
  reaper: NodeJS.Timeout;
};

// Module-level cache — survives across requests in the long-running Node server.
// Keyed by `${envId}:${kind}` so an env can hold BOTH a Grafana and a Prometheus
// tunnel without them competing for the same slot.
type ProxyKind = "grafana" | "prometheus";
const proxies = new Map<string, Entry>();
// In-flight starts, so concurrent requests for the same env share one spawn.
const starting = new Map<string, Promise<Entry>>();

function key(envId: string, kind: ProxyKind) {
  return `${envId}:${kind}`;
}

function scheduleReap(k: string, entry: Entry) {
  clearTimeout(entry.reaper);
  entry.reaper = setTimeout(() => {
    if (Date.now() - entry.lastUsed >= IDLE_MS) void kill(k);
    else scheduleReap(k, entry);
  }, IDLE_MS + 1_000);
  // Don't keep the process alive just for the reaper.
  entry.reaper.unref?.();
}

async function kill(k: string) {
  const entry = proxies.get(k);
  if (!entry) return;
  proxies.delete(k);
  clearTimeout(entry.reaper);
  try {
    entry.proc.kill("SIGTERM");
  } catch {
    /* already gone */
  }
  await entry.cleanupKubeconfig().catch(() => {});
}

async function start(envId: string, kind: ProxyKind): Promise<Entry> {
  const env = await prisma.env.findUnique({
    where: { id: envId },
    select: { cloudProviderId: true },
  });
  const kcfg = await getKubeconfigForEnv(envId);
  if (!kcfg.ok) throw new Error(kcfg.message);

  const svc = kind === "grafana" ? GRAFANA_SVC : PROM_SVC_LOCAL;
  const svcPort = kind === "grafana" ? GRAFANA_PORT : PROM_PORT_LOCAL;
  const k = key(envId, kind);

  let entry: Entry;
  try {
    const childEnv = await kubeExecEnv(kcfg.handle.path, env?.cloudProviderId ?? null);
    // Port-forward straight to the service; `:N` lets kubectl pick a free
    // local port, which it prints as "Forwarding from 127.0.0.1:PORT -> …".
    // Cast env through unknown: the strict NodeJS.ProcessEnv type demands a
    // NODE_ENV key we deliberately don't pass (same workaround as runStage).
    const proc = spawn(
      "kubectl",
      ["port-forward", "-n", NS, `svc/${svc}`, `:${svcPort}`, "--address=127.0.0.1"],
      {
        env: childEnv as unknown as NodeJS.ProcessEnv,
        stdio: ["ignore", "pipe", "pipe"],
      },
    ) as Proc;

    const port = await new Promise<number>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("kubectl port-forward did not start in time.")),
        START_TIMEOUT_MS,
      );
      let buf = "";
      const onData = (chunk: Buffer) => {
        buf += chunk.toString();
        const m = buf.match(/Forwarding from 127\.0\.0\.1:(\d+)/);
        if (m) {
          clearTimeout(timer);
          proc.stdout?.off("data", onData);
          resolve(Number(m[1]));
        }
      };
      proc.stdout?.on("data", onData);
      proc.stderr?.on("data", (c: Buffer) => {
        // kubectl prints fatal auth/exec errors to stderr before forwarding.
        const s = c.toString();
        if (/error|forbidden|unable|not found|ENOENT/i.test(s)) {
          clearTimeout(timer);
          reject(new Error(s.split("\n")[0]?.slice(0, 200) || "kubectl port-forward failed."));
        }
      });
      proc.on("error", (e) => {
        clearTimeout(timer);
        reject(
          e.message.includes("ENOENT") ? new Error("`kubectl` isn't installed on the server.") : e,
        );
      });
      proc.on("exit", (code) => {
        clearTimeout(timer);
        reject(new Error(`kubectl port-forward exited (code ${code}).`));
      });
    });

    entry = {
      port,
      proc,
      cleanupKubeconfig: kcfg.handle.cleanup,
      lastUsed: Date.now(),
      reaper: setTimeout(() => {}, 0),
    };
    // If the proxy dies later, drop it from the cache so the next request respawns.
    proc.on("exit", () => {
      if (proxies.get(k) === entry) proxies.delete(k);
      void kcfg.handle.cleanup().catch(() => {});
    });
    proxies.set(k, entry);
    scheduleReap(k, entry);
  } catch (e) {
    await kcfg.handle.cleanup().catch(() => {});
    throw e;
  }
  return entry;
}

async function getBase(envId: string, kind: ProxyKind): Promise<string> {
  const k = key(envId, kind);
  const existing = proxies.get(k);
  if (existing && !existing.proc.killed) {
    existing.lastUsed = Date.now();
    return `http://127.0.0.1:${existing.port}`;
  }
  let pending = starting.get(k);
  if (!pending) {
    pending = start(envId, kind).finally(() => starting.delete(k));
    starting.set(k, pending);
  }
  const entry = await pending;
  entry.lastUsed = Date.now();
  return `http://127.0.0.1:${entry.port}`;
}

/** Get (or start) the local base URL of an authenticated port-forward to Grafana. */
export async function getGrafanaForwardBase(envId: string): Promise<string> {
  return getBase(envId, "grafana");
}

/**
 * Get (or start) the local base URL of an authenticated port-forward to
 * Prometheus. We port-forward instead of hitting the kube API-server service
 * proxy (`/api/v1/namespaces/…/services/…:9090/proxy`) because that proxy
 * silently hangs on some EKS clusters for the Prometheus service specifically
 * (Grafana on the same mechanism works fine — proven with kubectl locally).
 * Symptom: metrics panels + Query Prometheus all timed out with zero
 * explanation; the same PromQL against `http://127.0.0.1:<pf-port>/api/v1/…`
 * returns instantly.
 */
export async function getPrometheusForwardBase(envId: string): Promise<string> {
  return getBase(envId, "prometheus");
}
