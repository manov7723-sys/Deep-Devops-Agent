/**
 * Deterministic Kubernetes manifest builder — production-style templates.
 *
 * Pure TS (no node/server imports) so it can run on the client for an instant,
 * zero-token live preview AND be reused server-side. Each curated kind has a
 * field schema (what the form renders) and a generator (the YAML it produces
 * with production defaults: labels, resource requests/limits, probes, security
 * context, etc.). Unknown kinds get a minimal, valid skeleton.
 */

export type ManifestFieldType = "text" | "number" | "toggle" | "select" | "keyvalue";

export type ManifestField = {
  name: string;
  label: string;
  type: ManifestFieldType;
  required?: boolean;
  default?: string;
  options?: string[];
  hint?: string;
  placeholder?: string;
};

export type ManifestMeta = { apiVersion: string; kind: string; namespaced: boolean };

export type ManifestKind = {
  /** Default apiVersion if the cluster list isn't available. */
  apiVersion: string;
  namespaced: boolean;
  /** Fields shown in addition to the implicit name/namespace handling below. */
  fields: ManifestField[];
  generate: (values: Record<string, string>, meta: ManifestMeta) => string;
};

// ── small YAML helpers ────────────────────────────────────────────────
const q = (s: string) => (/^[A-Za-z0-9_\-./]+$/.test(s) ? s : JSON.stringify(s));
const indent = (block: string, n: number) =>
  block
    .split("\n")
    .map((l) => (l ? " ".repeat(n) + l : l))
    .join("\n");

/** Parse a "KEY=VALUE" per-line textarea into entries. */
export function parseKeyValues(raw: string): Array<[string, string]> {
  return (raw || "")
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean)
    .map((l) => {
      const i = l.indexOf("=");
      return i === -1
        ? ([l, ""] as [string, string])
        : ([l.slice(0, i).trim(), l.slice(i + 1).trim()] as [string, string]);
    })
    .filter(([k]) => k.length > 0);
}

function stdLabels(app: string): string {
  return [`app.kubernetes.io/name: ${q(app)}`, `app.kubernetes.io/managed-by: deepagent`].join(
    "\n",
  );
}

const get = (v: Record<string, string>, k: string, d = "") => (v[k] ?? "").trim() || d;
const num = (v: Record<string, string>, k: string, d: number) => {
  const n = Number((v[k] ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : d;
};

// ── curated kinds ─────────────────────────────────────────────────────
export const MANIFEST_KINDS: Record<string, ManifestKind> = {
  Namespace: {
    apiVersion: "v1",
    namespaced: false,
    fields: [],
    generate: (v, m) => {
      const name = get(v, "name", "my-namespace");
      return [
        `apiVersion: ${m.apiVersion}`,
        `kind: Namespace`,
        `metadata:`,
        `  name: ${q(name)}`,
        `  labels:`,
        indent(stdLabels(name), 4),
        ``,
      ].join("\n");
    },
  },

  Deployment: {
    apiVersion: "apps/v1",
    namespaced: true,
    fields: [
      {
        name: "image",
        label: "Container image",
        type: "text",
        required: true,
        placeholder: "nginx:1.27",
        hint: "image:tag",
      },
      { name: "replicas", label: "Replicas", type: "number", default: "2" },
      { name: "containerPort", label: "Container port", type: "number", default: "8080" },
      { name: "cpuRequest", label: "CPU request", type: "text", default: "100m" },
      { name: "cpuLimit", label: "CPU limit", type: "text", default: "500m" },
      { name: "memRequest", label: "Memory request", type: "text", default: "128Mi" },
      { name: "memLimit", label: "Memory limit", type: "text", default: "512Mi" },
      {
        name: "probePath",
        label: "Health probe path",
        type: "text",
        default: "/healthz",
        hint: "HTTP path for liveness/readiness",
      },
      {
        name: "env",
        label: "Environment variables",
        type: "keyvalue",
        hint: "One KEY=VALUE per line",
      },
      {
        name: "volumeType",
        label: "Volume",
        type: "select",
        default: "none",
        options: ["none", "emptyDir", "configMap", "secret", "persistentVolumeClaim"],
        hint: "Attach a volume to the container. 'none' = no volume.",
      },
      {
        name: "volumeName",
        label: "Volume name",
        type: "text",
        default: "data",
        hint: "Used when a volume is selected.",
      },
      {
        name: "mountPath",
        label: "Mount path",
        type: "text",
        default: "/data",
        hint: "Where the volume is mounted in the container.",
      },
      {
        name: "volumeSource",
        label: "Volume source name",
        type: "text",
        hint: "Name of the ConfigMap / Secret / PVC (not needed for emptyDir).",
      },
    ],
    generate: (v, m) => {
      const name = get(v, "name", "my-app");
      const ns = get(v, "namespace", "default");
      const image = get(v, "image", "nginx:1.27");
      const replicas = num(v, "replicas", 2);
      const port = num(v, "containerPort", 8080);
      const probePath = get(v, "probePath", "/healthz");
      const envs = parseKeyValues(v.env ?? "");
      // Container-level env (correctly indented as a container field).
      const envBlock = envs.length
        ? `\n          env:\n` +
          envs
            .map(([k, val]) => `            - name: ${q(k)}\n              value: ${q(val)}`)
            .join("\n")
        : "";

      // Optional volume: a container volumeMount + a pod-spec volume source.
      const volType = get(v, "volumeType", "none");
      const hasVol = volType !== "" && volType !== "none";
      const volName = get(v, "volumeName", "data");
      const mountPath = get(v, "mountPath", "/data");
      const volSrc = get(v, "volumeSource", volName);
      const volumeMountsBlock = hasVol
        ? `\n          volumeMounts:\n            - name: ${q(volName)}\n              mountPath: ${q(mountPath)}`
        : "";
      let volSourceLines = "";
      if (volType === "emptyDir") volSourceLines = `          emptyDir: {}`;
      else if (volType === "configMap")
        volSourceLines = `          configMap:\n            name: ${q(volSrc)}`;
      else if (volType === "secret")
        volSourceLines = `          secret:\n            secretName: ${q(volSrc)}`;
      else if (volType === "persistentVolumeClaim")
        volSourceLines = `          persistentVolumeClaim:\n            claimName: ${q(volSrc)}`;
      const volumesBlock = hasVol
        ? `\n      volumes:\n        - name: ${q(volName)}\n${volSourceLines}`
        : "";

      return [
        `apiVersion: ${m.apiVersion}`,
        `kind: Deployment`,
        `metadata:`,
        `  name: ${q(name)}`,
        `  namespace: ${q(ns)}`,
        `  labels:`,
        indent(stdLabels(name), 4),
        `spec:`,
        `  replicas: ${replicas}`,
        `  revisionHistoryLimit: 5`,
        `  strategy:`,
        `    type: RollingUpdate`,
        `    rollingUpdate:`,
        `      maxSurge: 25%`,
        `      maxUnavailable: 0`,
        `  selector:`,
        `    matchLabels:`,
        `      app.kubernetes.io/name: ${q(name)}`,
        `  template:`,
        `    metadata:`,
        `      labels:`,
        indent(stdLabels(name), 8),
        `    spec:`,
        `      securityContext:`,
        `        runAsNonRoot: true`,
        `        seccompProfile:`,
        `          type: RuntimeDefault`,
        `      containers:`,
        `        - name: ${q(name)}`,
        `          image: ${q(image)}`,
        `          imagePullPolicy: IfNotPresent`,
        `          ports:`,
        `            - containerPort: ${port}`,
        `          resources:`,
        `            requests:`,
        `              cpu: ${q(get(v, "cpuRequest", "100m"))}`,
        `              memory: ${q(get(v, "memRequest", "128Mi"))}`,
        `            limits:`,
        `              cpu: ${q(get(v, "cpuLimit", "500m"))}`,
        `              memory: ${q(get(v, "memLimit", "512Mi"))}`,
        `          livenessProbe:`,
        `            httpGet:`,
        `              path: ${q(probePath)}`,
        `              port: ${port}`,
        `            initialDelaySeconds: 10`,
        `            periodSeconds: 15`,
        `          readinessProbe:`,
        `            httpGet:`,
        `              path: ${q(probePath)}`,
        `              port: ${port}`,
        `            initialDelaySeconds: 5`,
        `            periodSeconds: 10`,
        `          securityContext:`,
        `            allowPrivilegeEscalation: false`,
        `            readOnlyRootFilesystem: true`,
        `            capabilities:`,
        `              drop:`,
        `                - ALL` + volumeMountsBlock + envBlock + volumesBlock,
        ``,
      ].join("\n");
    },
  },

  Service: {
    apiVersion: "v1",
    namespaced: true,
    fields: [
      {
        name: "type",
        label: "Service type",
        type: "select",
        default: "ClusterIP",
        options: ["ClusterIP", "NodePort", "LoadBalancer"],
      },
      { name: "port", label: "Service port", type: "number", default: "80" },
      { name: "targetPort", label: "Target (container) port", type: "number", default: "8080" },
      {
        name: "selectorApp",
        label: "Selector app name",
        type: "text",
        hint: "Matches the Deployment's app.kubernetes.io/name",
        required: true,
      },
    ],
    generate: (v, m) => {
      const name = get(v, "name", "my-svc");
      const ns = get(v, "namespace", "default");
      const selector = get(v, "selectorApp", name);
      return [
        `apiVersion: ${m.apiVersion}`,
        `kind: Service`,
        `metadata:`,
        `  name: ${q(name)}`,
        `  namespace: ${q(ns)}`,
        `  labels:`,
        indent(stdLabels(name), 4),
        `spec:`,
        `  type: ${get(v, "type", "ClusterIP")}`,
        `  selector:`,
        `    app.kubernetes.io/name: ${q(selector)}`,
        `  ports:`,
        `    - name: http`,
        `      port: ${num(v, "port", 80)}`,
        `      targetPort: ${num(v, "targetPort", 8080)}`,
        `      protocol: TCP`,
        ``,
      ].join("\n");
    },
  },

  ConfigMap: {
    apiVersion: "v1",
    namespaced: true,
    fields: [{ name: "data", label: "Data", type: "keyvalue", hint: "One KEY=VALUE per line" }],
    generate: (v, m) => {
      const name = get(v, "name", "my-config");
      const ns = get(v, "namespace", "default");
      const entries = parseKeyValues(v.data ?? "");
      const dataBlock = entries.length
        ? `data:\n` + entries.map(([k, val]) => `  ${q(k)}: ${q(val)}`).join("\n")
        : `data: {}`;
      return [
        `apiVersion: ${m.apiVersion}`,
        `kind: ConfigMap`,
        `metadata:`,
        `  name: ${q(name)}`,
        `  namespace: ${q(ns)}`,
        `  labels:`,
        indent(stdLabels(name), 4),
        dataBlock,
        ``,
      ].join("\n");
    },
  },

  Secret: {
    apiVersion: "v1",
    namespaced: true,
    fields: [
      {
        name: "secretType",
        label: "Secret type",
        type: "select",
        default: "Opaque",
        options: ["Opaque", "kubernetes.io/dockerconfigjson", "kubernetes.io/tls"],
      },
      {
        name: "data",
        label: "String data",
        type: "keyvalue",
        hint: "One KEY=VALUE per line (stored as stringData — k8s encodes it)",
      },
    ],
    generate: (v, m) => {
      const name = get(v, "name", "my-secret");
      const ns = get(v, "namespace", "default");
      const entries = parseKeyValues(v.data ?? "");
      const dataBlock = entries.length
        ? `stringData:\n` + entries.map(([k, val]) => `  ${q(k)}: ${q(val)}`).join("\n")
        : `stringData: {}`;
      return [
        `apiVersion: ${m.apiVersion}`,
        `kind: Secret`,
        `metadata:`,
        `  name: ${q(name)}`,
        `  namespace: ${q(ns)}`,
        `  labels:`,
        indent(stdLabels(name), 4),
        `type: ${get(v, "secretType", "Opaque")}`,
        dataBlock,
        ``,
      ].join("\n");
    },
  },

  Ingress: {
    apiVersion: "networking.k8s.io/v1",
    namespaced: true,
    fields: [
      { name: "ingressClassName", label: "Ingress class", type: "text", default: "nginx" },
      { name: "host", label: "Host", type: "text", required: true, placeholder: "app.example.com" },
      { name: "path", label: "Path", type: "text", default: "/" },
      { name: "serviceName", label: "Backend service name", type: "text", required: true },
      { name: "servicePort", label: "Backend service port", type: "number", default: "80" },
      { name: "tls", label: "Enable TLS", type: "toggle", default: "true" },
    ],
    generate: (v, m) => {
      const name = get(v, "name", "my-ingress");
      const ns = get(v, "namespace", "default");
      const host = get(v, "host", "app.example.com");
      const svc = get(v, "serviceName", "my-svc");
      const port = num(v, "servicePort", 80);
      const path = get(v, "path", "/");
      const tls = (v.tls ?? "true").trim() !== "false";
      const tlsBlock = tls
        ? `\n  tls:\n    - hosts:\n        - ${q(host)}\n      secretName: ${q(name + "-tls")}`
        : "";
      return [
        `apiVersion: ${m.apiVersion}`,
        `kind: Ingress`,
        `metadata:`,
        `  name: ${q(name)}`,
        `  namespace: ${q(ns)}`,
        `  labels:`,
        indent(stdLabels(name), 4),
        `spec:`,
        `  ingressClassName: ${q(get(v, "ingressClassName", "nginx"))}` + tlsBlock,
        `  rules:`,
        `    - host: ${q(host)}`,
        `      http:`,
        `        paths:`,
        `          - path: ${q(path)}`,
        `            pathType: Prefix`,
        `            backend:`,
        `              service:`,
        `                name: ${q(svc)}`,
        `                port:`,
        `                  number: ${port}`,
        ``,
      ].join("\n");
    },
  },

  HorizontalPodAutoscaler: {
    apiVersion: "autoscaling/v2",
    namespaced: true,
    fields: [
      {
        name: "targetKind",
        label: "Target kind",
        type: "select",
        default: "Deployment",
        options: ["Deployment", "StatefulSet", "ReplicaSet"],
      },
      { name: "targetName", label: "Target name", type: "text", required: true },
      { name: "minReplicas", label: "Min replicas", type: "number", default: "2" },
      { name: "maxReplicas", label: "Max replicas", type: "number", default: "10" },
      { name: "cpuUtil", label: "Target CPU %", type: "number", default: "70" },
    ],
    generate: (v, m) => {
      const name = get(v, "name", "my-hpa");
      const ns = get(v, "namespace", "default");
      return [
        `apiVersion: ${m.apiVersion}`,
        `kind: HorizontalPodAutoscaler`,
        `metadata:`,
        `  name: ${q(name)}`,
        `  namespace: ${q(ns)}`,
        `  labels:`,
        indent(stdLabels(name), 4),
        `spec:`,
        `  scaleTargetRef:`,
        `    apiVersion: apps/v1`,
        `    kind: ${get(v, "targetKind", "Deployment")}`,
        `    name: ${q(get(v, "targetName", name))}`,
        `  minReplicas: ${num(v, "minReplicas", 2)}`,
        `  maxReplicas: ${num(v, "maxReplicas", 10)}`,
        `  metrics:`,
        `    - type: Resource`,
        `      resource:`,
        `        name: cpu`,
        `        target:`,
        `          type: Utilization`,
        `          averageUtilization: ${num(v, "cpuUtil", 70)}`,
        ``,
      ].join("\n");
    },
  },

  ServiceAccount: {
    apiVersion: "v1",
    namespaced: true,
    fields: [],
    generate: (v, m) => {
      const name = get(v, "name", "my-sa");
      const ns = get(v, "namespace", "default");
      return [
        `apiVersion: ${m.apiVersion}`,
        `kind: ServiceAccount`,
        `metadata:`,
        `  name: ${q(name)}`,
        `  namespace: ${q(ns)}`,
        `  labels:`,
        indent(stdLabels(name), 4),
        ``,
      ].join("\n");
    },
  },

  PersistentVolumeClaim: {
    apiVersion: "v1",
    namespaced: true,
    fields: [
      { name: "size", label: "Storage size", type: "text", default: "1Gi", hint: "e.g. 1Gi, 10Gi" },
      {
        name: "accessMode",
        label: "Access mode",
        type: "select",
        default: "ReadWriteOnce",
        options: ["ReadWriteOnce", "ReadWriteMany", "ReadOnlyMany"],
      },
      {
        name: "storageClass",
        label: "Storage class",
        type: "text",
        hint: "Optional, e.g. gp3. Blank = cluster default.",
      },
    ],
    generate: (v, m) => {
      const name = get(v, "name", "my-pvc");
      const ns = get(v, "namespace", "default");
      const sc = get(v, "storageClass", "");
      return [
        `apiVersion: ${m.apiVersion}`,
        `kind: PersistentVolumeClaim`,
        `metadata:`,
        `  name: ${q(name)}`,
        `  namespace: ${q(ns)}`,
        `  labels:`,
        indent(stdLabels(name), 4),
        `spec:`,
        `  accessModes:`,
        `    - ${get(v, "accessMode", "ReadWriteOnce")}`,
        ...(sc ? [`  storageClassName: ${q(sc)}`] : []),
        `  resources:`,
        `    requests:`,
        `      storage: ${q(get(v, "size", "1Gi"))}`,
        ``,
      ].join("\n");
    },
  },
};

export const CURATED_KIND_NAMES = Object.keys(MANIFEST_KINDS);

/** Implicit fields every kind needs (rendered before the curated fields). */
export function baseFields(namespaced: boolean): ManifestField[] {
  const f: ManifestField[] = [
    {
      name: "name",
      label: "Name (metadata.name)",
      type: "text",
      required: true,
      placeholder: "my-app",
    },
  ];
  if (namespaced) {
    f.push({
      name: "namespace",
      label: "Namespace",
      type: "text",
      required: true,
      default: "default",
    });
  }
  return f;
}

export function getManifestKind(kind: string): ManifestKind | null {
  return MANIFEST_KINDS[kind] ?? null;
}

/** Generic skeleton for any kind we don't have a curated template for. */
function genericManifest(values: Record<string, string>, meta: ManifestMeta): string {
  const name = get(values, "name", "my-resource");
  const lines = [
    `apiVersion: ${meta.apiVersion}`,
    `kind: ${meta.kind}`,
    `metadata:`,
    `  name: ${q(name)}`,
  ];
  if (meta.namespaced) lines.push(`  namespace: ${q(get(values, "namespace", "default"))}`);
  lines.push(`  labels:`, indent(stdLabels(name), 4), `spec: {}`, ``);
  return lines.join("\n");
}

/** Generate the manifest YAML for any kind (curated template or generic). */
export function generateManifest(values: Record<string, string>, meta: ManifestMeta): string {
  const tpl = getManifestKind(meta.kind);
  return tpl ? tpl.generate(values, meta) : genericManifest(values, meta);
}

// ── fallbacks when the cluster isn't reachable ────────────────────────
export const FALLBACK_API_VERSIONS = [
  "v1",
  "apps/v1",
  "batch/v1",
  "networking.k8s.io/v1",
  "autoscaling/v2",
  "rbac.authorization.k8s.io/v1",
  "policy/v1",
];

export type ApiResource = { kind: string; apiVersion: string; namespaced: boolean; name: string };

export const FALLBACK_RESOURCES: ApiResource[] = [
  { kind: "Namespace", apiVersion: "v1", namespaced: false, name: "namespaces" },
  { kind: "Pod", apiVersion: "v1", namespaced: true, name: "pods" },
  { kind: "Service", apiVersion: "v1", namespaced: true, name: "services" },
  { kind: "ConfigMap", apiVersion: "v1", namespaced: true, name: "configmaps" },
  { kind: "Secret", apiVersion: "v1", namespaced: true, name: "secrets" },
  { kind: "ServiceAccount", apiVersion: "v1", namespaced: true, name: "serviceaccounts" },
  { kind: "Deployment", apiVersion: "apps/v1", namespaced: true, name: "deployments" },
  { kind: "StatefulSet", apiVersion: "apps/v1", namespaced: true, name: "statefulsets" },
  { kind: "DaemonSet", apiVersion: "apps/v1", namespaced: true, name: "daemonsets" },
  { kind: "Job", apiVersion: "batch/v1", namespaced: true, name: "jobs" },
  { kind: "CronJob", apiVersion: "batch/v1", namespaced: true, name: "cronjobs" },
  { kind: "Ingress", apiVersion: "networking.k8s.io/v1", namespaced: true, name: "ingresses" },
  {
    kind: "HorizontalPodAutoscaler",
    apiVersion: "autoscaling/v2",
    namespaced: true,
    name: "horizontalpodautoscalers",
  },
];
