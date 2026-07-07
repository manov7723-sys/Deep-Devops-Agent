/**
 * Live deployment reader — pulls the ACTUAL Deployments running in an env's
 * cluster (name + image + replicas + port + env), straight from kubectl. Used by
 * the Promotions page so it reflects what's really running — regardless of
 * whether the app was deployed through DeepAgent or by other means.
 */
import { withKubectl } from "./kube-actions";

export type LiveDeployment = {
  name: string;
  namespace: string;
  image: string;
  replicas: number;
  ready: number;
  containerPort: number;
  env: Array<{ key: string; value: string }>;
};

type RawDeployment = {
  metadata?: { name?: string; namespace?: string };
  spec?: { replicas?: number; template?: { spec?: { containers?: Array<{ image?: string; ports?: Array<{ containerPort?: number }>; env?: Array<{ name?: string; value?: unknown }> }> } } };
  status?: { readyReplicas?: number };
};

// Cluster-managed namespaces we hide from the app-focused views.
const SYSTEM_NS = new Set([
  "kube-system", "kube-public", "kube-node-lease", "local-path-storage", "kubernetes-dashboard",
  "gmp-system", "gke-managed-system", "gke-gmp-system", "gke-managed-cim", "calico-system", "calico-apiserver",
  "tigera-operator", "amazon-cloudwatch", "aws-observability", "kube-flannel",
]);

// Cluster infrastructure / managed add-ons that run as Deployments but are NOT
// user applications (e.g. EKS/GKE install external-dns, coredns, CSI drivers,
// load-balancer controllers on every cluster). These would otherwise appear in
// EVERY environment's column — noise that isn't yours and can't meaningfully be
// "promoted". Matched by well-known name OR by an image from a cluster-infra
// registry: EKS-managed add-on repos live under ".../eks/…" in ECR, and upstream
// components ship from registry.k8s.io / k8s.gcr.io / GKE's registries. Your own
// apps (e.g. dockersamples/*, your ECR app repos) never match, whether you
// deployed them through DeepAgent or straight from the terminal with kubectl.
const INFRA_NAMES = new Set([
  "external-dns", "coredns", "kube-dns", "metrics-server", "cluster-autoscaler",
  "aws-load-balancer-controller", "aws-node", "kube-proxy", "aws-node-termination-handler",
  "ebs-csi-controller", "efs-csi-controller", "aws-for-fluent-bit", "cloudwatch-agent",
  "karpenter", "cluster-proportional-autoscaler", "nvidia-device-plugin",
  "konnectivity-agent", "secrets-store-csi-driver", "snapshot-controller",
]);

const INFRA_IMAGE_RE = /(?:registry\.k8s\.io|k8s\.gcr\.io|gke\.gcr\.io|gcr\.io\/gke-release)\/|\.amazonaws\.com\/eks\//;

/** True for cluster add-ons / managed infra, so the promotion views show only real apps. */
function isInfraWorkload(name: string, image: string): boolean {
  return INFRA_NAMES.has(name) || INFRA_IMAGE_RE.test(image);
}

/**
 * Read the running Deployments in an env's cluster. Pass a namespace to scope to
 * it; pass "all" / omit to read every (non-system) namespace.
 */
export async function getLiveDeployments(
  projectId: string,
  envKey: string,
  namespace?: string,
): Promise<{ ok: true; deployments: LiveDeployment[] } | { ok: false; error: string }> {
  const all = !namespace || namespace === "all";
  const wrapped = await withKubectl(projectId, envKey, async (run, defaultNs) => {
    const args = all ? ["get", "deployments", "-A", "-o", "json"] : ["get", "deployments", "-n", (namespace || defaultNs).trim(), "-o", "json"];
    const res = await run(args);
    if (res.exitCode !== 0) throw new Error(res.stderr.slice(-400) || res.stdout.slice(-400) || "kubectl get deployments failed");

    const items: RawDeployment[] = (() => {
      try {
        return (JSON.parse(res.stdout).items ?? []) as RawDeployment[];
      } catch {
        return [];
      }
    })();

    return items
      .map((d): LiveDeployment => {
        const c = d.spec?.template?.spec?.containers?.[0] ?? {};
        return {
          name: d.metadata?.name ?? "",
          namespace: d.metadata?.namespace ?? "default",
          image: c.image ?? "",
          replicas: d.spec?.replicas ?? 1,
          ready: d.status?.readyReplicas ?? 0,
          containerPort: c.ports?.[0]?.containerPort ?? 8080,
          env: Array.isArray(c.env)
            ? c.env.filter((e) => typeof e.value === "string").map((e) => ({ key: e.name ?? "", value: String(e.value) }))
            : [],
        };
      })
      .filter((d) => d.name && d.image && !isInfraWorkload(d.name, d.image) && (all ? !SYSTEM_NS.has(d.namespace) : true));
  });

  if (!wrapped.ok) return wrapped;
  return { ok: true, deployments: wrapped.value };
}
