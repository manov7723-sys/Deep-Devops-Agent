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
  /**
   * When provided, scopes the deploy job to a GitHub Actions **environment**
   * (dev / staging / prod). GitHub Actions then resolves `${{ secrets.* }}`
   * against that environment's secrets first, falling back to repo secrets
   * for anything not defined there (KUBECONFIG_B64 typically stays at the
   * repo level). Enables Required Reviewers + wait-timer promotion gates on
   * the environment settings page — the built-in way to gate a prod deploy.
   */
  envKey?: string;
  /**
   * Application env var names to lift out of GitHub environment secrets and
   * materialize as a Kubernetes Secret named `app-env` right before the
   * manifest is applied. The generated manifest's Deployment already
   * envFroms `app-env` (with `optional: true`), so a var landing here shows
   * up in the pod's environment on the next roll — no extra manifest edit.
   *
   * Only names in this list are read from `${{ secrets.<NAME> }}`. GitHub
   * Actions doesn't expose "all secrets" as a loopable map — we have to
   * enumerate every name we intend to forward. Leave empty to skip the
   * materialization step (backward-compatible with the previous shape).
   */
  envSecretVars?: string[];
}): GeneratedFile {
  const app = sanitizeAppName(opts.appName);
  const ns = opts.namespace || "default";
  const dir = normalizeManifestDir(opts.manifestDir);
  const envKey = (opts.envKey ?? "").trim();
  // De-duplicate + validate names so a stray value doesn't inject a shell
  // arg. GitHub Actions allows uppercase letters, digits and underscores in
  // secret names; anything else silently fails when the workflow runs.
  // GITHUB_*-prefixed names are stored under an APP_ alias (GitHub reserves
  // the prefix) and mapped back to the real name when the Secret is built.
  const ghAlias = (n: string) => (n.startsWith("GITHUB_") ? `APP_${n}` : n);
  const secretNames = Array.from(
    new Set((opts.envSecretVars ?? []).filter((n) => /^[A-Z][A-Z0-9_]*$/.test(n))),
  );

  // `environment:` block — only when envKey is set. GitHub only invokes the
  // environment's protection rules (required reviewers, wait timer) for jobs
  // that opt in via this block.
  const environmentBlock = envKey ? `\n    environment: ${envKey}\n` : "\n";

  // env: block that pulls every requested secret into this step's process
  // env. GitHub Actions masks the values in logs and refuses to expand them
  // outside the `env:` context, so this is the only safe way to forward
  // them into the `run:` script.
  const envInjectBlock = secretNames.length
    ? `        env:\n` +
      secretNames.map((n) => `          ${ghAlias(n)}: \${{ secrets.${ghAlias(n)} }}`).join("\n") +
      "\n"
    : "";
  const pairList = secretNames.map((n) => `${n}=${ghAlias(n)}`).join(" ");
  const materializeSecretStep = secretNames.length
    ? `
      - name: Materialize app env from GitHub environment secrets
        # Forwards the secrets declared in this step's env: block into a
        # Kubernetes Secret named "app-env" (MERGED — keys written by other
        # flows survive). The generated Deployment envFroms this Secret
        # (optional=true), so anything landing here appears in the pod env on
        # the next rollout. GITHUB_*-named values arrive via their APP_* alias.
${envInjectBlock}        run: |
          set -euo pipefail
          ARGS=()
          for PAIR in ${pairList}; do
            REAL="\${PAIR%%=*}"; SRC="\${PAIR#*=}"
            VAL="\${!SRC:-}"
            if [ -n "$VAL" ]; then
              ARGS+=("--from-literal=$REAL=$VAL")
            else
              echo "::warning::GitHub environment secret '$SRC' is unset — the pod will not see $REAL."
            fi
          done
          if [ \${#ARGS[@]} -gt 0 ]; then
            DOC=$(kubectl -n ${ns} create secret generic app-env "\${ARGS[@]}" --dry-run=client -o json)
            if kubectl -n ${ns} get secret app-env >/dev/null 2>&1; then
              kubectl -n ${ns} patch secret app-env --type merge -p "$DOC"
            else
              printf '%s' "$DOC" | kubectl -n ${ns} create -f -
            fi
          fi
`
    : "";

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
    runs-on: ubuntu-latest${environmentBlock}    steps:
      - name: Checkout
        uses: actions/checkout@v4

      - name: Set up kubectl
        uses: azure/setup-kubectl@v4

      - name: Configure cluster access
        run: |
          mkdir -p "$HOME/.kube"
          printf '%s' "\${{ secrets.KUBECONFIG_B64 }}" | base64 -d > "$HOME/.kube/config"
          kubectl config current-context
${materializeSecretStep}
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
export function buildCdFiles(
  spec: DeploySpec,
  manifestDir?: string,
  opts?: { envKey?: string; envSecretVars?: string[] },
): GeneratedFile[] {
  return [
    deployManifestFile(spec, manifestDir),
    cdWorkflowFile({
      appName: spec.appName,
      namespace: spec.namespace,
      manifestDir,
      envKey: opts?.envKey,
      envSecretVars: opts?.envSecretVars,
    }),
  ];
}
