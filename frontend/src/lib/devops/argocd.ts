/**
 * ArgoCD (GitOps) support for the deploy wizard.
 *
 * ─────────────────────────────────────────────────────────────────────────
 * WHY GITOPS CHANGES THE PIPELINE SHAPE
 * ─────────────────────────────────────────────────────────────────────────
 * ArgoCD reconciles the cluster against GIT — it does not watch the container
 * registry. That has two consequences our normal pipeline violates:
 *
 *   1. A `:latest` tag can never trigger a deploy. If the manifest in git says
 *      `:latest` and never changes, git never changes, so Argo has nothing to
 *      sync. The new image sits in ECR forever. Under GitOps the image tag MUST
 *      be immutable (we use the git SHA) and the manifest MUST be updated in
 *      git for a rollout to happen.
 *
 *   2. A CD workflow that runs `kubectl apply` FIGHTS Argo. Argo sees the
 *      out-of-band change as drift and reverts it (or flaps between the two).
 *      So when Argo is enabled we do NOT generate a CD workflow at all —
 *      Argo owns cluster state, full stop.
 *
 * The resulting flow:
 *
 *   push code
 *     → CI builds the image, tags it <git-sha>, pushes to ECR
 *     → CI rewrites the tag in k8s/<env>/…/manifest.yaml and commits back
 *     → Argo notices the git commit and syncs the cluster   ← the deploy
 *
 * The commit-back is what makes the SHA visible to Argo. The alternative,
 * ArgoCD Image Updater watching ECR directly, removes that step but adds a
 * component with fiddly registry auth — deliberately not used here.
 */

export const ARGOCD_NAMESPACE = "argocd";
/** Chart version pinned so repeat applies are deterministic. */
export const ARGOCD_CHART_VERSION = "7.6.12";

export type ArgoAppSpec = {
  /** Argo Application name — one per deployed service. */
  name: string;
  /** Repo the manifests live in, e.g. https://github.com/owner/repo.git */
  repoUrl: string;
  /** Branch Argo tracks. */
  branch: string;
  /** Path inside the repo holding the manifests for this service. */
  path: string;
  /** Namespace the workload is deployed into. */
  destinationNamespace: string;
};

/**
 * Argo Application CR.
 *
 * `automated.prune` + `selfHeal` are what make this true GitOps: anything
 * deleted from git is deleted from the cluster, and manual `kubectl` edits are
 * reverted. That is the point of the mode — half-automated sync would leave
 * exactly the drift GitOps exists to remove.
 *
 * CreateNamespace=true so the first sync doesn't fail on a namespace that
 * only exists in the manifest.
 */
export function buildArgoApplication(spec: ArgoAppSpec): string {
  return `apiVersion: argoproj.io/v1alpha1
kind: Application
metadata:
  name: ${spec.name}
  namespace: ${ARGOCD_NAMESPACE}
  labels:
    app.kubernetes.io/managed-by: deepagent
  finalizers:
    # Ensures deleting the Application also removes the workloads it created,
    # rather than orphaning them in the cluster.
    - resources-finalizer.argocd.argoproj.io
spec:
  project: default
  source:
    repoURL: ${spec.repoUrl}
    targetRevision: ${spec.branch}
    path: ${spec.path}
  destination:
    server: https://kubernetes.default.svc
    namespace: ${spec.destinationNamespace}
  syncPolicy:
    automated:
      prune: true      # delete cluster resources removed from git
      selfHeal: true   # revert manual kubectl changes back to git state
    syncOptions:
      - CreateNamespace=true
    retry:
      limit: 3
      backoff:
        duration: 10s
        factor: 2
        maxDuration: 2m
`;
}

/**
 * Is ArgoCD already running on this cluster?
 *
 * Install is per-CLUSTER, not per-app — a second app deploying to the same
 * cluster must reuse the existing installation rather than reinstall over it.
 */
export async function detectArgoCd(kubeconfigPath: string): Promise<boolean> {
  const { runStage } = await import("@/lib/runner/exec");
  const PATH = [process.env.PATH ?? "", "/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]
    .filter(Boolean)
    .join(":");
  try {
    const res = await runStage({
      command: "kubectl",
      args: [
        "get",
        "deployment",
        "argocd-server",
        "-n",
        ARGOCD_NAMESPACE,
        "-o",
        "jsonpath={.status.readyReplicas}",
      ],
      cwd: process.cwd(),
      env: { PATH, KUBECONFIG: kubeconfigPath },
      timeoutMs: 20_000,
    });
    return res.exitCode === 0 && Number(res.stdout.trim() || "0") > 0;
  } catch {
    return false;
  }
}

export type ArgoInstallResult =
  | { ok: true; installed: boolean; adminPassword?: string; note: string }
  | { ok: false; error: string };

/**
 * Install ArgoCD via Helm if it isn't already present, then read the initial
 * admin password.
 *
 * Exposure is deliberately NOT configured: the server stays ClusterIP and is
 * reached with `kubectl port-forward`. Putting the Argo UI on a public ALB by
 * default would expose a cluster-admin-capable control plane to the internet
 * behind a generated password — an opt-in decision, not a side effect of
 * ticking "use GitOps" in a deploy wizard.
 */
export async function ensureArgoCd(args: {
  kubeconfigPath: string;
  execEnv: Record<string, string>;
}): Promise<ArgoInstallResult> {
  const { runStage } = await import("@/lib/runner/exec");
  const env = { ...args.execEnv, KUBECONFIG: args.kubeconfigPath };

  const already = await detectArgoCd(args.kubeconfigPath);
  if (!already) {
    const repoAdd = await runStage({
      command: "helm",
      args: ["repo", "add", "argo", "https://argoproj.github.io/argo-helm"],
      cwd: process.cwd(),
      env,
      timeoutMs: 60_000,
    });
    if (repoAdd.exitCode !== 0 && !/already exists/i.test(repoAdd.stderr)) {
      return { ok: false, error: `helm repo add failed: ${repoAdd.stderr.slice(-300)}` };
    }
    await runStage({
      command: "helm",
      args: ["repo", "update", "argo"],
      cwd: process.cwd(),
      env,
      timeoutMs: 120_000,
    });

    const install = await runStage({
      command: "helm",
      args: [
        "upgrade",
        "--install",
        "argocd",
        "argo/argo-cd",
        "-n",
        ARGOCD_NAMESPACE,
        "--create-namespace",
        "--version",
        ARGOCD_CHART_VERSION,
        // Insecure = terminate TLS at the ingress/port-forward rather than in
        // argocd-server. Without it the server redirects http→https and a
        // port-forward shows a TLS error.
        "--set",
        "configs.params.server\\.insecure=true",
        "--wait",
        "--timeout",
        "10m",
      ],
      cwd: process.cwd(),
      env,
      timeoutMs: 660_000,
    });
    if (install.exitCode !== 0) {
      return { ok: false, error: `ArgoCD install failed: ${install.stderr.slice(-400)}` };
    }
  }

  // Initial admin password lives in a Secret the chart creates. It may be
  // absent if an operator already rotated it — not an error.
  let adminPassword: string | undefined;
  const pw = await runStage({
    command: "kubectl",
    args: [
      "get",
      "secret",
      "argocd-initial-admin-secret",
      "-n",
      ARGOCD_NAMESPACE,
      "-o",
      "jsonpath={.data.password}",
    ],
    cwd: process.cwd(),
    env,
    timeoutMs: 30_000,
  });
  if (pw.exitCode === 0 && pw.stdout.trim()) {
    adminPassword = Buffer.from(pw.stdout.trim(), "base64").toString("utf8");
  }

  return {
    ok: true,
    installed: !already,
    adminPassword,
    note: already
      ? "ArgoCD was already running on this cluster — reused it."
      : `ArgoCD ${ARGOCD_CHART_VERSION} installed into the "${ARGOCD_NAMESPACE}" namespace.`,
  };
}

/**
 * Apply the Argo Application CR(s) to the cluster.
 *
 * Applied server-side rather than left in git because the Application is the
 * *bootstrap*: it is what tells Argo to start watching the repo. Committing it
 * without applying it would leave a file nothing reads.
 */
export async function applyArgoApplications(args: {
  kubeconfigPath: string;
  execEnv: Record<string, string>;
  manifests: string[];
}): Promise<{ ok: true; applied: number } | { ok: false; error: string }> {
  const { runStage } = await import("@/lib/runner/exec");
  const { mkdtemp, writeFile, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const env = { ...args.execEnv, KUBECONFIG: args.kubeconfigPath };
  const dir = await mkdtemp(join(tmpdir(), "dda-argo-"));
  try {
    const file = join(dir, "applications.yaml");
    await writeFile(file, args.manifests.join("---\n"), { mode: 0o600 });
    const res = await runStage({
      command: "kubectl",
      args: ["apply", "-f", file],
      cwd: dir,
      env,
      timeoutMs: 60_000,
    });
    if (res.exitCode !== 0) {
      return { ok: false, error: `Applying Argo Application failed: ${res.stderr.slice(-300)}` };
    }
    return { ok: true, applied: args.manifests.length };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

/** How to reach the Argo UI — printed in the deploy summary. */
export function argoAccessInstructions(adminPassword?: string): string {
  return (
    `kubectl port-forward svc/argocd-server -n ${ARGOCD_NAMESPACE} 8080:80  →  http://localhost:8080` +
    (adminPassword ? `  ·  user: admin  ·  password: ${adminPassword}` : "") +
    "  (the UI is ClusterIP-only by design — a cluster-admin control plane should not be published to the internet by default)"
  );
}
