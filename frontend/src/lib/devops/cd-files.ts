/**
 * CD files the agent writes into the repo (GitOps-style), separate from the CI
 * (build+push) workflow:
 *   • k8s/manifest.yaml               — the Deployment + Service (+ Ingress).
 *   • .github/workflows/deploy.yml    — the CD workflow that applies them.
 *
 * The CD workflow authenticates to the cluster with a `KUBECONFIG_B64` GitHub
 * secret (base64 of the kubeconfig) and runs `kubectl apply`. It triggers on a
 * push that changes the manifests (so merging the agent's PR deploys) and via
 * manual dispatch — i.e. AFTER the CI workflow has pushed the image.
 */
import { buildDeployManifest, sanitizeAppName, type DeploySpec } from "./deploy-manifest";

export type GeneratedFile = { path: string; content: string };

/** Normalise a repo folder path: strip leading/trailing slashes; default "k8s". */
export function normalizeManifestDir(raw?: string): string {
  const p = (raw || "k8s").trim().replace(/^\/+|\/+$/g, "");
  return p || "k8s";
}

/** The Kubernetes manifest file (single multi-doc YAML) under the chosen dir. */
export function deployManifestFile(spec: DeploySpec, manifestDir?: string): GeneratedFile {
  const dir = normalizeManifestDir(manifestDir);
  return { path: `${dir}/manifest.yaml`, content: buildDeployManifest(spec).yaml };
}

/** The CD GitHub Actions workflow that applies the manifests in `manifestDir`. */
export function cdWorkflowFile(opts: {
  appName: string;
  namespace: string;
  manifestDir?: string;
}): GeneratedFile {
  const app = sanitizeAppName(opts.appName);
  const ns = opts.namespace || "default";
  const dir = normalizeManifestDir(opts.manifestDir);
  const content = `name: Deploy to Kubernetes (CD)

# Runs AFTER the image is built & pushed by the CI workflow. Applies the
# committed manifests to the cluster. Set repo secret KUBECONFIG_B64 to the
# base64 of your kubeconfig (the app can set this for you).
on:
  workflow_dispatch: {}
  push:
    branches: [main, master]
    paths:
      - "${dir}/**"
      - ".github/workflows/deploy.yml"

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up kubectl
        uses: azure/setup-kubectl@v4

      - name: Configure cluster access
        run: |
          mkdir -p "$HOME/.kube"
          printf '%s' "\${{ secrets.KUBECONFIG_B64 }}" | base64 -d > "$HOME/.kube/config"
          kubectl config current-context

      - name: Apply manifests
        # Prefer manifest.yaml — deploy_my_app writes exactly that file, and
        # applying the whole dir picks up any stale *.yaml (e.g. a
        # hand-committed service.yaml from an older scaffold) that
        # alphabetically-sorts AFTER it and silently overrides the freshly
        # generated resource (that's how a ClusterIP + ALB deploy became a
        # LoadBalancer + NLB in the 2026-08 incident). Fall back to the dir
        # for repos whose manifests are still split across multiple files.
        run: |
          if [ -f "${dir}/manifest.yaml" ]; then
            kubectl apply -n ${ns} -f "${dir}/manifest.yaml"
          else
            kubectl apply -n ${ns} -f "${dir}/"
          fi

      - name: Wait for rollout
        run: kubectl rollout status deployment/${app} -n ${ns} --timeout=180s

      - name: Rollback on failed rollout
        if: failure()
        run: |
          echo "::warning::Rollout of ${app} failed its health check — rolling back to the previous revision."
          kubectl rollout undo deployment/${app} -n ${ns}
          kubectl rollout status deployment/${app} -n ${ns} --timeout=120s
`;
  return { path: ".github/workflows/deploy.yml", content };
}

/** Both CD files (manifest + workflow) the agent commits together. */
export function buildCdFiles(spec: DeploySpec, manifestDir?: string): GeneratedFile[] {
  return [
    deployManifestFile(spec, manifestDir),
    cdWorkflowFile({ appName: spec.appName, namespace: spec.namespace, manifestDir }),
  ];
}
