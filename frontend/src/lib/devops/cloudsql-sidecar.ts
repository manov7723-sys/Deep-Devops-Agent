/**
 * Inject the Cloud SQL Auth Proxy into a namespace's Deployments.
 *
 * The GKE counterpart of `wire-secret-to-workloads.ts`. That module attaches a
 * Secret; this one attaches a whole sidecar container plus the service-account
 * identity it authenticates with — because on GCP the recommended path to a
 * database is a proxy process, not a network rule.
 *
 * What a wired Deployment ends up with:
 *   • `serviceAccountName: <ksa>` — the KSA bound to a Google service account
 *     that holds roles/cloudsql.client (see gcp-cloudsql.ts).
 *   • a `cloud-sql-proxy` container listening on 127.0.0.1:5432 (or 3306).
 *   • the app container unchanged, reading DATABASE_URL from the Secret,
 *     which points at 127.0.0.1.
 *
 * Idempotent: a Deployment that already has the sidecar is left alone apart
 * from a rollout restart, so re-running Connect picks up rotated credentials
 * without duplicating containers.
 */
import { runStage } from "@/lib/runner/exec";

export type SidecarOutcome = {
  deployment: string;
  status: "patched" | "already" | "failed";
  message?: string;
};

/**
 * Pinned proxy image. Floating tags on an infrastructure sidecar mean a pod
 * restart can silently change the component that brokers every database
 * connection — a bad property for something in the data path. Bump
 * deliberately.
 */
const PROXY_IMAGE = "gcr.io/cloud-sql-connectors/cloud-sql-proxy:2.14.1";

/** Create (or update) the Kubernetes service account the proxy runs as. */
export async function ensureProxyServiceAccount(args: {
  kubeconfigPath: string;
  execEnv: Record<string, string>;
  namespace: string;
  ksaName: string;
  /** Google service account the KSA impersonates — goes on the annotation. */
  gsaEmail: string;
}): Promise<{ ok: true } | { ok: false; error: string }> {
  const { kubeconfigPath, execEnv, namespace, ksaName, gsaEmail } = args;
  const env = { ...execEnv, KUBECONFIG: kubeconfigPath };
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");

  const dir = await mkdtemp(join(tmpdir(), "dda-ksa-"));
  try {
    // The annotation is the entire link between the KSA and the GSA — without
    // it the proxy runs as the node's default identity and fails with a
    // permission error that names neither service account.
    const manifest = `apiVersion: v1
kind: ServiceAccount
metadata:
  name: ${ksaName}
  namespace: ${namespace}
  annotations:
    iam.gke.io/gcp-service-account: ${gsaEmail}
  labels:
    app.kubernetes.io/managed-by: deepagent
`;
    const file = join(dir, "ksa.yaml");
    await writeFile(file, manifest, { mode: 0o600 });
    const res = await runStage({
      command: "kubectl",
      args: ["apply", "-f", file],
      cwd: dir,
      env,
      timeoutMs: 60_000,
    });
    if (res.exitCode !== 0) {
      return { ok: false, error: `Applying the service account failed: ${res.stderr.slice(-300)}` };
    }
    return { ok: true };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/**
 * Add the proxy sidecar + service account to every Deployment in a namespace.
 *
 * Uses a strategic-merge patch rather than a JSON Patch: `containers` is a
 * merge-keyed list (`name`), so a patch naming `cloud-sql-proxy` inserts it if
 * absent and updates it in place if present. A JSON Patch `add` to
 * `/containers/-` would append a duplicate on every re-run.
 */
export async function injectCloudSqlProxy(args: {
  kubeconfigPath: string;
  execEnv: Record<string, string>;
  namespace: string;
  ksaName: string;
  /** `project:region:instance`. */
  connectionName: string;
  engine: "postgres" | "mysql";
}): Promise<{ ok: true; outcomes: SidecarOutcome[] } | { ok: false; error: string }> {
  const { kubeconfigPath, execEnv, namespace, ksaName, connectionName, engine } = args;
  const env = { ...execEnv, KUBECONFIG: kubeconfigPath };
  const port = engine === "mysql" ? 3306 : 5432;

  const list = await runStage({
    command: "kubectl",
    args: ["get", "deployments", "-n", namespace, "-o", "json"],
    cwd: process.cwd(),
    env,
    timeoutMs: 30_000,
  });
  if (list.exitCode !== 0) {
    return { ok: false, error: `Could not list deployments: ${list.stderr.slice(-300)}` };
  }

  let parsed: {
    items?: Array<{
      metadata?: { name?: string };
      spec?: {
        template?: {
          spec?: {
            serviceAccountName?: string;
            containers?: Array<{ name?: string }>;
          };
        };
      };
    }>;
  };
  try {
    parsed = JSON.parse(list.stdout);
  } catch {
    return { ok: false, error: "kubectl returned non-JSON when listing deployments." };
  }

  const outcomes: SidecarOutcome[] = [];
  for (const dep of parsed.items ?? []) {
    const name = dep.metadata?.name;
    if (!name) continue;
    const podSpec = dep.spec?.template?.spec;
    const hasProxy = (podSpec?.containers ?? []).some((c) => c.name === "cloud-sql-proxy");
    const hasKsa = podSpec?.serviceAccountName === ksaName;

    if (hasProxy && hasKsa) {
      // Still roll — the Secret's DATABASE_URL may have changed, and pods read
      // Secret values only at container start.
      const restart = await runStage({
        command: "kubectl",
        args: ["rollout", "restart", "deployment", name, "-n", namespace],
        cwd: process.cwd(),
        env,
        timeoutMs: 30_000,
      });
      outcomes.push({
        deployment: name,
        status: "already",
        message:
          restart.exitCode === 0
            ? "proxy already present — rolled pods to pick up current credentials"
            : `proxy already present, restart failed: ${restart.stderr.slice(-200)}`,
      });
      continue;
    }

    // `--private-ip` is deliberately NOT set: it requires the instance to have
    // a private IP AND the cluster to be VPC-native with access to it. The
    // default (public path, IAM-authenticated, TLS) works on every cluster
    // shape, which is the property we want from a one-click connect.
    const patch = {
      spec: {
        template: {
          spec: {
            serviceAccountName: ksaName,
            containers: [
              {
                name: "cloud-sql-proxy",
                image: PROXY_IMAGE,
                args: [
                  `--port=${port}`,
                  // Bind to loopback only — the proxy must never be reachable
                  // from outside the pod.
                  "--address=127.0.0.1",
                  // Exit non-zero if the connection can't be established, so a
                  // broken proxy surfaces as CrashLoopBackOff rather than an
                  // app that hangs on every query.
                  "--exit-zero-on-sigterm=false",
                  connectionName,
                ],
                securityContext: {
                  runAsNonRoot: true,
                  allowPrivilegeEscalation: false,
                },
                resources: {
                  requests: { cpu: "50m", memory: "64Mi" },
                  limits: { memory: "128Mi" },
                },
              },
            ],
          },
        },
      },
    };

    const res = await runStage({
      command: "kubectl",
      args: [
        "patch",
        "deployment",
        name,
        "-n",
        namespace,
        "--type",
        "strategic",
        "-p",
        JSON.stringify(patch),
      ],
      cwd: process.cwd(),
      env,
      timeoutMs: 60_000,
    });
    outcomes.push(
      res.exitCode === 0
        ? { deployment: name, status: "patched", message: "Cloud SQL proxy sidecar added" }
        : { deployment: name, status: "failed", message: res.stderr.slice(-200) },
    );
  }

  if (outcomes.length === 0) {
    return {
      ok: false,
      error: `No Deployments found in namespace "${namespace}" — deploy the app first, then connect the database.`,
    };
  }
  return { ok: true, outcomes };
}
