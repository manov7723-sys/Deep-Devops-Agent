import { prisma } from "@/lib/db/prisma";
import { decryptSecret } from "@/lib/auth/crypto";
import { getKubeconfigForEnv } from "@/lib/runner/creds";
import { runStage } from "@/lib/runner/exec";
import type { Tool } from "./types";

/**
 * Force a Terminating namespace to finish deleting when it's blocked by a
 * hanging finalizer. The standalone chat counterpart to the auto-heal block
 * baked into every CD workflow — same three stages, callable from the agent
 * loop when the user surfaces a "stuck namespace" error outside a workflow run.
 *
 * WHY THIS EXISTS (2026-08 incident):
 * A namespace stuck Terminating rejects every subsequent `kubectl apply` into
 * it with "unable to create new content in namespace X because it is being
 * terminated". Root cause is nearly always a hanging finalizer on a
 * LoadBalancer Service (LB deleted out-of-band → controller can't confirm
 * cleanup → finalizer never removes → namespace never terminates → deploys
 * blocked forever) or a PersistentVolumeClaim (EBS/PD delete failed). The
 * standard workaround is `kubectl patch svc/... -p '{"metadata":{"finalizers":
 * null}}' --type=merge` + (if still stuck) `kubectl replace --raw
 * /api/v1/namespaces/X/finalize`, which requires shelling out — this tool
 * does it server-side so the agent never has to hand a kubectl command to the
 * user.
 *
 * Three stages, tried in order:
 *   1. Wait 30s for a natural deletion to finish.
 *   2. Force-clear finalizers on every Service + PVC in the namespace.
 *   3. Force-clear the namespace's own `.spec.finalizers` via the
 *      /finalize subresource (kubernetes' documented force-delete for
 *      stuck namespaces).
 *
 * Safe: force-clearing Service finalizers only orphans a cloud LB — never
 * kills a pod or loses data. Namespace-finalizer removal is the same
 * operation `kubectl` docs recommend. Reports exactly what was done.
 */
export const unstickTerminatingNamespaceTool: Tool<
  { envKey: string; namespace: string },
  {
    envKey: string;
    namespace: string;
    finalPhase: "gone" | "Active";
    stagesRun: string[];
    clearedResources: string[];
    forceRemovedNamespaceFinalizer: boolean;
    message: string;
  }
> = {
  name: "unstick_terminating_namespace",
  description:
    "Force a stuck Terminating namespace to finish deleting when a hanging finalizer (usually on a LoadBalancer Service or PVC whose cloud resource was deleted out-of-band) is blocking it. Use as soon as a deploy fails with 'unable to create new content in namespace X because it is being terminated', or when `kubectl get ns X` sits in Terminating for over a minute. The app CAN do this itself — do NOT tell the user to run `kubectl patch` or `kubectl replace --raw /finalize`; call this tool and report what happened. Runs three stages (natural wait → clear Service/PVC finalizers → force-clear namespace finalizer via /finalize) and stops as soon as the namespace is gone. Safe and idempotent (calling on an Active namespace is a no-op).",
  inputSchema: {
    type: "object",
    properties: {
      envKey: {
        type: "string",
        description: "Env whose cluster the namespace lives on.",
      },
      namespace: {
        type: "string",
        description: "The stuck namespace name (e.g. 'deep-devops-agent').",
      },
    },
    required: ["envKey", "namespace"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const env = await prisma.env.findFirst({
      where: { projectId: ctx.projectId, key: input.envKey },
      select: { id: true, cloudProviderId: true, kubeconfigRef: true },
    });
    if (!env) return { ok: false, error: `Env "${input.envKey}" not found on this project.` };
    if (!env.kubeconfigRef) {
      return {
        ok: false,
        error:
          `Env "${input.envKey}" has no kubeconfig wired. ` +
          `Connect the cluster first (Environments → Connect cluster).`,
      };
    }
    // Sanity-check the encrypted blob decrypts — the actual kubeconfig used
    // by `runStage` comes from `getKubeconfigForEnv` (writes to a temp file
    // + returns a cleanup). Catching decrypt failure here yields a clearer
    // error than a downstream kubectl "context not found".
    try {
      decryptSecret(env.kubeconfigRef);
    } catch {
      return {
        ok: false,
        error: `Could not decrypt env "${input.envKey}"'s stored kubeconfig — reconnect the cluster.`,
      };
    }

    const kc = await getKubeconfigForEnv(env.id);
    if (!kc.ok) {
      return {
        ok: false,
        error: `Could not resolve kubeconfig for env "${input.envKey}" (${kc.message}).`,
      };
    }

    const kubeconfigPath = kc.handle.path;
    const ns = input.namespace;
    const stagesRun: string[] = [];
    const clearedResources: string[] = [];
    let forceRemovedNamespaceFinalizer = false;

    try {
      // Helpers
      const kubectl = async (args: string[], opts?: { swallowError?: boolean }) => {
        const r = await runStage({
          command: "kubectl",
          args: ["--kubeconfig", kubeconfigPath, ...args],
          cwd: process.cwd(),
          env: process.env as Record<string, string>,
          timeoutMs: 30_000,
          maxBufferBytes: 2 * 1024 * 1024,
        });
        if (!opts?.swallowError && r.exitCode !== 0) {
          throw new Error(`kubectl ${args.join(" ")} failed: ${r.stderr.slice(-200)}`);
        }
        return r;
      };
      const phase = async (): Promise<"" | "Active" | "Terminating"> => {
        const r = await kubectl(
          ["get", "namespace", ns, "-o", "jsonpath={.status.phase}"],
          { swallowError: true },
        );
        if (r.exitCode !== 0) return "";
        const p = r.stdout.trim();
        return p === "Active" || p === "Terminating" ? p : "";
      };

      // Preflight — is the namespace even in a state that needs fixing?
      const initial = await phase();
      if (initial === "") {
        return {
          ok: true,
          output: {
            envKey: input.envKey,
            namespace: ns,
            finalPhase: "gone" as const,
            stagesRun: ["preflight: namespace does not exist"],
            clearedResources,
            forceRemovedNamespaceFinalizer,
            message: `Namespace "${ns}" does not exist — nothing to unstick.`,
          },
        };
      }
      if (initial === "Active") {
        return {
          ok: true,
          output: {
            envKey: input.envKey,
            namespace: ns,
            finalPhase: "Active" as const,
            stagesRun: ["preflight: namespace is Active"],
            clearedResources,
            forceRemovedNamespaceFinalizer,
            message: `Namespace "${ns}" is Active — no unstick needed.`,
          },
        };
      }

      // Stage 1 — natural wait (30s)
      stagesRun.push("stage 1: waiting 30s for natural termination");
      for (let i = 0; i < 15; i++) {
        const p = await phase();
        if (p === "") break;
        await new Promise((r) => setTimeout(r, 2000));
      }

      // Stage 2 — clear finalizers on Services + PVCs
      if ((await phase()) === "Terminating") {
        stagesRun.push("stage 2: clearing finalizers on Services and PVCs");
        for (const kind of ["svc", "pvc"]) {
          const list = await kubectl(
            ["get", kind, "-n", ns, "-o", "name"],
            { swallowError: true },
          );
          if (list.exitCode !== 0) continue;
          const resources = list.stdout
            .split("\n")
            .map((l) => l.trim())
            .filter(Boolean);
          for (const res of resources) {
            await kubectl(
              [
                "patch",
                res,
                "-n",
                ns,
                "-p",
                '{"metadata":{"finalizers":null}}',
                "--type=merge",
              ],
              { swallowError: true },
            );
            clearedResources.push(res);
          }
        }
        for (let i = 0; i < 15; i++) {
          const p = await phase();
          if (p === "") break;
          await new Promise((r) => setTimeout(r, 2000));
        }
      }

      // Stage 3 — /finalize subresource
      if ((await phase()) === "Terminating") {
        stagesRun.push("stage 3: force-clearing namespace's own finalizer via /finalize");
        const nsJson = await kubectl(["get", "namespace", ns, "-o", "json"], {
          swallowError: true,
        });
        if (nsJson.exitCode === 0) {
          try {
            const parsed = JSON.parse(nsJson.stdout) as {
              apiVersion?: string;
              kind?: string;
              metadata?: { name?: string };
              spec?: Record<string, unknown>;
            };
            const cleared = {
              apiVersion: parsed.apiVersion ?? "v1",
              kind: parsed.kind ?? "Namespace",
              metadata: { name: parsed.metadata?.name ?? ns },
              spec: { ...(parsed.spec ?? {}), finalizers: [] },
            };
            // `kubectl replace --raw` needs the payload on stdin — runStage
            // has no stdin plumbing, so temp-file + `-f <path>` is the
            // equivalent that keeps the code inside the existing exec helpers.
            const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
            const { join } = await import("node:path");
            const { tmpdir } = await import("node:os");
            const dir = await mkdtemp(join(tmpdir(), "dda-nsfinal-"));
            const payloadPath = join(dir, "ns.json");
            try {
              await writeFile(payloadPath, JSON.stringify(cleared));
              const r = await kubectl(
                [
                  "replace",
                  "--raw",
                  `/api/v1/namespaces/${ns}/finalize`,
                  "-f",
                  payloadPath,
                ],
                { swallowError: true },
              );
              if (r.exitCode === 0) forceRemovedNamespaceFinalizer = true;
            } finally {
              await rm(dir, { recursive: true, force: true }).catch(() => {});
            }
          } catch {
            /* JSON parse failed — leave forceRemovedNamespaceFinalizer=false */
          }
        }
        await new Promise((r) => setTimeout(r, 3000));
      }

      const finalP = await phase();
      if (finalP === "") {
        return {
          ok: true,
          output: {
            envKey: input.envKey,
            namespace: ns,
            finalPhase: "gone" as const,
            stagesRun,
            clearedResources,
            forceRemovedNamespaceFinalizer,
            message:
              clearedResources.length || forceRemovedNamespaceFinalizer
                ? `Namespace "${ns}" is now deleted after force-clearing ${clearedResources.length} resource finalizer(s)${forceRemovedNamespaceFinalizer ? " + the namespace's own finalizer" : ""}. Note: any cloud LB previously backing a LoadBalancer Service is now orphaned in AWS — the agent already deleted it earlier, but if you re-see it, delete via AWS console or aws elbv2 delete-load-balancer.`
                : `Namespace "${ns}" finished terminating naturally.`,
          },
        };
      }
      return {
        ok: false,
        error:
          `Namespace "${ns}" is STILL ${finalP} after all three heal stages. This is rare — likely an admission webhook or a CRD finalizer we don't handle here. Run: kubectl describe ns ${ns} and kubectl get all -n ${ns} to see what's left, then delete/patch it by kind. Stages tried: ${stagesRun.join(" | ")}. Cleared: ${clearedResources.join(", ") || "none"}.`,
      };
    } finally {
      await kc.handle.cleanup().catch(() => {});
    }
  },
};
