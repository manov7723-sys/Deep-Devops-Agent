import { prisma } from "@/lib/db/prisma";
import { getKubeconfigForEnv, kubeExecEnv } from "@/lib/runner/creds";
import { runStage } from "@/lib/runner/exec";
import type { Tool } from "./types";

/**
 * One-shot health check across every layer of a deployed app.
 *
 * WHY THIS EXISTS: debugging a broken deploy has meant asking the user to
 * open DevTools, navigate to a specific tab, look for a specific request,
 * copy its status, then separately kubectl-exec into the pod to check env
 * vars, then check pod logs, then check the LB target group health. Each
 * step is trivial for a DevOps engineer; for a non-DevOps user each is a
 * dead-end. This tool composes all of it and returns one report.
 *
 * Checks, in order:
 *   1. Deployment exists & pods are Ready
 *   2. Pod env has essentials (DATABASE_URL and any user-supplied `expectedEnvKeys`)
 *   3. LoadBalancer / Ingress hostname is externally reachable (HTTP GET)
 *   4. If DATABASE_URL is set: DB is reachable from a pod (`pg_isready` / `nc`)
 *   5. Last N log lines from the pod for context
 *
 * Every check is best-effort: a failure in one layer doesn't abort the
 * others — the caller wants a full picture. Returns a structured verdict
 * per layer plus a human-readable summary the agent can restate to the user.
 */
type Input = {
  envKey: string;
  namespace: string;
  /** Deployment name (e.g. 'deep-devops-agent-frontend'). */
  deployment: string;
  /**
   * Public URL to probe. Optional — when omitted, the tool auto-discovers by
   * reading the Service's `.status.loadBalancer.ingress[0].hostname` or the
   * Ingress's `.status.loadBalancer.ingress[0].hostname`. Pass explicitly if
   * you know a specific path to probe (e.g. `/api/v1/auth/me` for the
   * DeepAgent app).
   */
  probeUrl?: string;
  /**
   * Additional env-var names the deployed app REQUIRES to work. The check
   * reports missing ones by name (values not shown). Always includes
   * DATABASE_URL implicitly.
   */
  expectedEnvKeys?: string[];
};

type LayerVerdict = { name: string; ok: boolean; detail: string };
type Output = {
  namespace: string;
  deployment: string;
  probeUrl: string | null;
  layers: LayerVerdict[];
  summary: string;
  /** Concrete next steps derived from the failing layers. */
  suggestedFixes: string[];
};

export const diagnoseDeployedAppTool: Tool<Input, Output> = {
  name: "diagnose_deployed_app",
  description:
    "One-shot end-to-end health check on a deployed app. Runs 5 layered checks — pod ready, expected env vars present, public URL reachable (HTTP status), DB reachable from pod, and recent log excerpts — and returns a structured verdict for each layer plus a plain-language summary and concrete fix suggestions. Use this WHENEVER the user says 'the app isn't working' or 'my deploy is broken', BEFORE asking them to open DevTools or run kubectl. Composes list_kubernetes_resources + inspect_pod_env + get_kubernetes_logs into one call so the agent can answer 'what's broken?' in a single tool invocation.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: { type: "string" },
      namespace: { type: "string" },
      deployment: {
        type: "string",
        description: "Deployment to diagnose (e.g. 'deep-devops-agent-frontend').",
      },
      probeUrl: {
        type: "string",
        description:
          "Full URL to probe (e.g. 'http://<lb-host>/api/v1/auth/me'). Optional — auto-discovered from the Service/Ingress if omitted. Pass explicitly to check a specific health endpoint.",
      },
      expectedEnvKeys: {
        type: "array",
        items: { type: "string" },
        description:
          "Env-var names the app requires. The check reports missing ones. DATABASE_URL is always checked implicitly.",
      },
    },
    required: ["envKey", "namespace", "deployment"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const env = await prisma.env.findFirst({
      where: { projectId: ctx.projectId, key: input.envKey },
      select: { id: true, cloudProviderId: true },
    });
    if (!env) return { ok: false, error: `Env "${input.envKey}" not found on this project.` };

    const kcfg = await getKubeconfigForEnv(env.id);
    if (!kcfg.ok) return { ok: false, error: kcfg.message };

    const layers: LayerVerdict[] = [];
    const suggestedFixes: string[] = [];

    try {
      const execEnv = await kubeExecEnv(kcfg.handle.path, env.cloudProviderId);
      const kubectl = async (args: string[], timeoutMs = 30_000) =>
        runStage({
          command: "kubectl",
          args: ["--kubeconfig", kcfg.handle.path, ...args],
          cwd: process.cwd(),
          env: execEnv,
          timeoutMs,
          maxBufferBytes: 8 * 1024 * 1024,
        });

      // ── Layer 1: Deployment + Pod readiness ──────────────────────────────
      const podList = await kubectl([
        "get",
        "pods",
        "-n",
        input.namespace,
        "-l",
        `app.kubernetes.io/name=${input.deployment}`,
        "-o",
        "jsonpath={range .items[*]}{.metadata.name}|{.status.phase}|{.status.conditions[?(@.type=='Ready')].status}{'\\n'}{end}",
      ]);
      let podName: string | null = null;
      let podReady = false;
      if (podList.exitCode !== 0 || !podList.stdout.trim()) {
        layers.push({
          name: "pod-ready",
          ok: false,
          detail: `No pods matching deployment "${input.deployment}" in namespace "${input.namespace}".`,
        });
        suggestedFixes.push(
          `No pods for "${input.deployment}". Confirm deploy actually ran, or check the CI/CD workflow status.`,
        );
      } else {
        const rows = podList.stdout
          .split("\n")
          .map((l) => l.trim())
          .filter(Boolean)
          .map((l) => {
            const [name, phase, ready] = l.split("|");
            return { name, phase, ready };
          });
        const ready = rows.find((r) => r.ready === "True");
        const running = rows.find((r) => r.phase === "Running");
        podName = (ready?.name || running?.name || rows[0].name) ?? null;
        podReady = !!ready;
        layers.push({
          name: "pod-ready",
          ok: podReady,
          detail: podReady
            ? `Pod "${podName}" is Ready.`
            : `Pod "${podName}" is ${rows[0].phase}, not Ready (readiness probe failing or still starting).`,
        });
        if (!podReady) {
          suggestedFixes.push(
            `Pod not Ready — fetch logs (get_kubernetes_logs) to see the readiness probe failure; common causes are DB unreachable, missing env vars, or the app not serving the probe path.`,
          );
        }
      }

      // ── Layer 2: Env vars (checked via `env` inside the pod) ─────────────
      const requiredKeys = new Set<string>(["DATABASE_URL", ...(input.expectedEnvKeys ?? [])]);
      let podEnv: Record<string, string> = {};
      if (podName) {
        const envRes = await kubectl(["exec", "-n", input.namespace, podName, "--", "env"]);
        if (envRes.exitCode === 0) {
          for (const line of envRes.stdout.split("\n")) {
            const eq = line.indexOf("=");
            if (eq > 0) podEnv[line.slice(0, eq)] = line.slice(eq + 1);
          }
        } else {
          // Distroless fallback.
          const proc = await kubectl([
            "exec",
            "-n",
            input.namespace,
            podName,
            "--",
            "sh",
            "-c",
            "cat /proc/1/environ | tr '\\0' '\\n'",
          ]);
          if (proc.exitCode === 0) {
            for (const line of proc.stdout.split("\n")) {
              const eq = line.indexOf("=");
              if (eq > 0) podEnv[line.slice(0, eq)] = line.slice(eq + 1);
            }
          }
        }
      }
      const missing = [...requiredKeys].filter((k) => !(k in podEnv));
      layers.push({
        name: "env-vars",
        ok: missing.length === 0 && !!podName,
        detail:
          !podName
            ? "Could not read env — no pod available."
            : missing.length === 0
              ? `All ${requiredKeys.size} required env var(s) present.`
              : `Missing: ${missing.join(", ")}.`,
      });
      if (missing.length && podName) {
        suggestedFixes.push(
          `Missing env vars (${missing.join(", ")}). Wire via apply_app_env_secret OR connect the relevant service (e.g. connect_existing_rds for DATABASE_URL).`,
        );
      }

      // ── Layer 3: Public URL reachability ─────────────────────────────────
      let probeUrl = input.probeUrl?.trim() || null;
      if (!probeUrl) {
        // Auto-discover from Service .status.loadBalancer or Ingress.
        const svc = await kubectl([
          "get",
          "svc",
          input.deployment,
          "-n",
          input.namespace,
          "-o",
          "jsonpath={.status.loadBalancer.ingress[0].hostname}{'|'}{.status.loadBalancer.ingress[0].ip}",
        ]);
        if (svc.exitCode === 0) {
          const [host, ip] = svc.stdout.split("|");
          const target = host?.trim() || ip?.trim();
          if (target) probeUrl = `http://${target}/`;
        }
        if (!probeUrl) {
          const ing = await kubectl([
            "get",
            "ingress",
            input.deployment,
            "-n",
            input.namespace,
            "-o",
            "jsonpath={.status.loadBalancer.ingress[0].hostname}{'|'}{.status.loadBalancer.ingress[0].ip}",
          ]);
          if (ing.exitCode === 0) {
            const [host, ip] = ing.stdout.split("|");
            const target = host?.trim() || ip?.trim();
            if (target) probeUrl = `http://${target}/`;
          }
        }
      }
      if (!probeUrl) {
        layers.push({
          name: "url-reachable",
          ok: false,
          detail: "No LoadBalancer/Ingress hostname yet — service still provisioning.",
        });
        suggestedFixes.push(
          `Public URL not assigned yet. Wait ~2 min for the cloud LB to provision, then re-run this check.`,
        );
      } else {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 10_000);
          const resp = await fetch(probeUrl, {
            method: "GET",
            signal: controller.signal,
            redirect: "manual",
          });
          clearTimeout(timer);
          const status = resp.status;
          const ok = status >= 200 && status < 500; // 4xx is "app is up but rejected the probe" — still healthy
          layers.push({
            name: "url-reachable",
            ok,
            detail: `${probeUrl} → HTTP ${status}. ${status < 400 ? "OK." : status < 500 ? "App is up (client-side response — auth required, not found, etc)." : "Server error — app is failing internally."}`,
          });
          if (!ok) {
            suggestedFixes.push(
              `URL returned HTTP ${status}. Check pod logs (get_kubernetes_logs) for the specific error the app is throwing.`,
            );
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          const isTimeout = /aborted|timeout/i.test(msg);
          layers.push({
            name: "url-reachable",
            ok: false,
            detail: `${probeUrl} → ${isTimeout ? "TIMEOUT after 10s" : msg}. ${isTimeout ? "The LB has an address but nothing responds on port 80 — typically the node SG doesn't allow the pod's target port (for NLB/ALB target-type=ip)." : "Network error."}`,
          });
          suggestedFixes.push(
            isTimeout
              ? `URL times out. Call ensure_workload_reachable(envKey, port=<pod port>) to open the node SG.`
              : `URL is unreachable. Check the LB / DNS resolution for ${probeUrl}.`,
          );
        }
      }

      // ── Layer 4: DB reachability from pod (only if DATABASE_URL present) ─
      if (podName && podEnv.DATABASE_URL) {
        // Parse host+port from postgresql://user:pass@host:port/db
        const m = podEnv.DATABASE_URL.match(/^\s*postgres(?:ql)?:\/\/[^@]*@([^:/\s]+)(?::(\d+))?/i);
        if (m) {
          const host = m[1];
          const port = m[2] || "5432";
          const nc = await kubectl(
            [
              "exec",
              "-n",
              input.namespace,
              podName,
              "--",
              "sh",
              "-c",
              `(command -v pg_isready >/dev/null 2>&1 && pg_isready -h "${host}" -p ${port} -t 5) || (command -v nc >/dev/null 2>&1 && nc -zv -w 5 "${host}" ${port}) || echo NO_TOOL`,
            ],
            15_000,
          );
          const output = `${nc.stdout}\n${nc.stderr}`.trim();
          const ok =
            /accepting connections|open|succeeded/i.test(output) && !/NO_TOOL/.test(output) && nc.exitCode === 0;
          layers.push({
            name: "db-reachable",
            ok,
            detail: ok
              ? `Pod can reach ${host}:${port}.`
              : /NO_TOOL/.test(output)
                ? `Pod image has neither pg_isready nor nc — cannot verify from here. DATABASE_URL host is ${host}:${port}; check the RDS security group manually.`
                : `Pod CANNOT reach ${host}:${port} (${output.slice(-160)}).`,
          });
          if (!ok && !/NO_TOOL/.test(output)) {
            suggestedFixes.push(
              `Pod cannot reach DB host ${host}:${port}. Check RDS security group allows the cluster's node SG on port ${port} (ensure_rds_reachable_from_cluster / rds-network.ts flow).`,
            );
          }
        } else {
          layers.push({
            name: "db-reachable",
            ok: false,
            detail: `DATABASE_URL didn't parse — value doesn't look like postgres://user:pass@host:port/db.`,
          });
        }
      }

      // ── Layer 5: Recent logs (last 30 lines) ─────────────────────────────
      if (podName) {
        const logs = await kubectl(["logs", "-n", input.namespace, podName, "--tail=30"]);
        const tail = logs.exitCode === 0 ? logs.stdout : logs.stderr;
        // Only fail this layer on obvious error patterns; noisy logs are still "ok" for the summary.
        const hasError = /\bERROR\b|FATAL|panic|uncaught|unhandled|Cannot|failed to/i.test(tail);
        layers.push({
          name: "recent-logs",
          ok: !hasError,
          detail: hasError
            ? `Errors seen in last 30 lines. Last 400 chars: ${tail.slice(-400)}`
            : `No obvious errors in last 30 lines.`,
        });
      }

      // ── Summary ──────────────────────────────────────────────────────────
      const failing = layers.filter((l) => !l.ok);
      const summary =
        failing.length === 0
          ? `All ${layers.length} health checks pass for "${input.deployment}" in namespace "${input.namespace}". The app is healthy end-to-end.`
          : `${failing.length}/${layers.length} health check(s) failing for "${input.deployment}": ${failing.map((l) => l.name).join(", ")}. See per-layer detail and suggestedFixes.`;

      return {
        ok: true,
        output: {
          namespace: input.namespace,
          deployment: input.deployment,
          probeUrl,
          layers,
          summary,
          suggestedFixes,
        },
      };
    } finally {
      await kcfg.handle.cleanup().catch(() => {});
    }
  },
};
