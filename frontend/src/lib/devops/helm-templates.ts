/**
 * Deterministic Helm chart builder — fully production-grade web-service chart.
 *
 * Pure TS (no node/server imports) so it runs on the client for an instant,
 * zero-token live preview AND server-side for the agent tool. The user fills a
 * field schema, we template a complete, valid chart tree — NO LLM ever writes
 * the YAML.
 *
 * Production features (all togglable via values.yaml, all using _helpers.tpl):
 *   deployment: hardened securityContext, separate liveness/readiness/startup
 *     probes, podAntiAffinity, topologySpreadConstraints, preStop hook,
 *     terminationGracePeriodSeconds, RollingUpdate strategy, nodeSelector +
 *     tolerations, image-by-digest, ephemeral-storage, configmap/secret envFrom,
 *     writable /tmp for readOnlyRootFilesystem, extra volumes/mounts.
 *   extra templates: pdb, networkpolicy, configmap, secret, servicemonitor,
 *     prometheusrule — each guarded by a values toggle.
 *
 * The chart is designed to pass `helm lint` (no warnings) and `helm template`.
 */

import type { ManifestField } from "./manifest-templates";
import { parseKeyValues } from "./manifest-templates";

// ── small YAML helpers ────────────────────────────────────────────────
const yq = (s: string) => (/^[A-Za-z0-9_\-./]+$/.test(s) ? s : JSON.stringify(s));
const get = (v: Record<string, string>, k: string, d = "") => (v[k] ?? "").trim() || d;
const num = (v: Record<string, string>, k: string, d: number) => {
  const n = Number((v[k] ?? "").trim());
  return Number.isFinite(n) && n > 0 ? n : d;
};
const bool = (v: Record<string, string>, k: string, d = false) => {
  const s = (v[k] ?? "").trim();
  if (s === "") return d;
  return s !== "false" && s !== "0" && s !== "no";
};

export type HelmChartResult = {
  chartName: string;
  /** path-in-repo (relative to chart dir) -> file contents */
  files: Record<string, string>;
  fileCount: number;
};

// ── field schema (drives the static form AND the agent's Q&A) ─────────
export const HELM_FIELDS: ManifestField[] = [
  {
    name: "name",
    label: "Chart / app name",
    type: "text",
    required: true,
    placeholder: "my-app",
    hint: "Lowercase letters, digits, hyphens.",
  },
  {
    name: "description",
    label: "Description",
    type: "text",
    default: "A Helm chart for Kubernetes",
    hint: "Shown in Chart.yaml.",
  },
  {
    name: "appVersion",
    label: "App version",
    type: "text",
    default: "1.0.0",
    hint: "The version of the app this chart deploys.",
  },
  {
    name: "image",
    label: "Container image repository",
    type: "text",
    required: true,
    placeholder: "ghcr.io/org/app",
    hint: "Without the tag.",
  },
  {
    name: "tag",
    label: "Image tag",
    type: "text",
    default: "latest",
    hint: "e.g. a commit SHA or semver.",
  },
  {
    name: "imageDigest",
    label: "Image digest (optional)",
    type: "text",
    placeholder: "sha256:…",
    hint: "If set, the image is pinned by digest instead of tag (recommended for prod).",
  },
  { name: "replicaCount", label: "Replicas", type: "number", default: "2" },
  {
    name: "containerPort",
    label: "Container port",
    type: "number",
    default: "8080",
    hint: "Port your app listens on.",
  },
  {
    name: "serviceType",
    label: "Service type",
    type: "select",
    default: "ClusterIP",
    options: ["ClusterIP", "NodePort", "LoadBalancer"],
  },
  { name: "servicePort", label: "Service port", type: "number", default: "80" },
  { name: "cpuRequest", label: "CPU request", type: "text", default: "100m" },
  { name: "cpuLimit", label: "CPU limit", type: "text", default: "500m" },
  { name: "memRequest", label: "Memory request", type: "text", default: "128Mi" },
  { name: "memLimit", label: "Memory limit", type: "text", default: "512Mi" },
  {
    name: "probePath",
    label: "Health probe path",
    type: "text",
    default: "/healthz",
    hint: "HTTP path for liveness/readiness/startup.",
  },
  {
    name: "env",
    label: "Environment variables",
    type: "keyvalue",
    hint: "One KEY=VALUE per line.",
  },
  { name: "ingressEnabled", label: "Enable Ingress", type: "toggle", default: "false" },
  {
    name: "ingressClassName",
    label: "Ingress class",
    type: "text",
    default: "nginx",
    hint: "Used when Ingress is enabled.",
  },
  {
    name: "ingressHost",
    label: "Ingress host",
    type: "text",
    placeholder: "app.example.com",
    hint: "Used when Ingress is enabled.",
  },
  { name: "ingressPath", label: "Ingress path", type: "text", default: "/" },
  {
    name: "ingressTls",
    label: "Ingress TLS",
    type: "toggle",
    default: "false",
    hint: "Adds a TLS block (secret <name>-tls).",
  },
  {
    name: "autoscalingEnabled",
    label: "Enable autoscaling (HPA)",
    type: "toggle",
    default: "false",
  },
  { name: "minReplicas", label: "Min replicas (HPA)", type: "number", default: "2" },
  { name: "maxReplicas", label: "Max replicas (HPA)", type: "number", default: "10" },
  { name: "targetCpu", label: "Target CPU % (HPA)", type: "number", default: "70" },
  { name: "serviceAccountCreate", label: "Create ServiceAccount", type: "toggle", default: "true" },
  { name: "pdbEnabled", label: "PodDisruptionBudget", type: "toggle", default: "true" },
  {
    name: "networkPolicyEnabled",
    label: "NetworkPolicy (default-deny)",
    type: "toggle",
    default: "false",
  },
  {
    name: "serviceMonitorEnabled",
    label: "Prometheus ServiceMonitor",
    type: "toggle",
    default: "false",
  },
  {
    name: "prometheusRuleEnabled",
    label: "Prometheus alert rules",
    type: "toggle",
    default: "false",
  },
];

/** Default values keyed by field name — used to seed forms and the agent. */
export function helmDefaults(): Record<string, string> {
  const d: Record<string, string> = {};
  for (const f of HELM_FIELDS) if (f.default !== undefined) d[f.name] = f.default;
  return d;
}

// ── values.yaml (generated from the spec, heavily commented) ───────────
function valuesYaml(v: Record<string, string>): string {
  const name = get(v, "name", "app");
  const image = get(v, "image", "ghcr.io/example/app");
  const tag = get(v, "tag", "latest");
  const digest = get(v, "imageDigest", "");
  const replicas = num(v, "replicaCount", 2);
  const port = num(v, "containerPort", 8080);
  const svcType = get(v, "serviceType", "ClusterIP");
  const svcPort = num(v, "servicePort", 80);
  const probePath = get(v, "probePath", "/healthz");
  const saCreate = bool(v, "serviceAccountCreate", true);

  const ingressEnabled = bool(v, "ingressEnabled", false);
  const ingressClass = get(v, "ingressClassName", "nginx");
  const ingressHost = get(v, "ingressHost", "app.example.com");
  const ingressPath = get(v, "ingressPath", "/");
  const ingressTls = bool(v, "ingressTls", false);
  const hpaEnabled = bool(v, "autoscalingEnabled", false);

  const pdbEnabled = bool(v, "pdbEnabled", true);
  const npEnabled = bool(v, "networkPolicyEnabled", false);
  const smEnabled = bool(v, "serviceMonitorEnabled", false);
  const prEnabled = bool(v, "prometheusRuleEnabled", false);

  const envs = parseKeyValues(v.env ?? "");
  const envBlock =
    envs.length > 0
      ? envs.map(([k, val]) => `  - name: ${yq(k)}\n    value: ${yq(val)}`).join("\n")
      : "";
  const tlsBlock = ingressTls
    ? `    - secretName: ${yq(name + "-tls")}\n      hosts:\n        - ${yq(ingressHost)}`
    : "";

  return `# Values for ${name} — generated by the DeepAgent Helm builder.
# Every production feature below is togglable. Templates read these values and
# use _helpers.tpl for all labels/selectors.

replicaCount: ${replicas}

image:
  repository: ${yq(image)}
  tag: ${yq(tag)}
  # Pin by digest for immutable, reproducible deploys. When set, it WINS over
  # tag (image becomes repository@digest). Leave empty to use the tag.
  digest: ${yq(digest)}
  pullPolicy: IfNotPresent

imagePullSecrets: []
nameOverride: ""
fullnameOverride: ""

serviceAccount:
  create: ${saCreate}
  # Don't auto-mount the SA token unless the app actually calls the K8s API.
  automountServiceAccountToken: false
  annotations: {}
  name: ""

# Annotations applied to every pod. Defaults wire up Prometheus scraping.
podAnnotations:
  prometheus.io/scrape: "true"
  prometheus.io/port: "${port}"
  prometheus.io/path: "/metrics"
podLabels: {}

# Pod-level security context.
podSecurityContext:
  runAsNonRoot: true
  runAsUser: 10001
  runAsGroup: 10001
  fsGroup: 10001
  seccompProfile:
    type: RuntimeDefault

# Container-level security context (hardened).
securityContext:
  allowPrivilegeEscalation: false
  readOnlyRootFilesystem: true
  runAsNonRoot: true
  capabilities:
    drop:
      - ALL

service:
  type: ${svcType}
  port: ${svcPort}
  targetPort: ${port}

containerPort: ${port}

ingress:
  enabled: ${ingressEnabled}
  className: ${yq(ingressClass)}
  annotations: {}
  hosts:
    - host: ${yq(ingressHost)}
      paths:
        - path: ${yq(ingressPath)}
          pathType: Prefix
  tls:${ingressTls ? "\n" + tlsBlock : " []"}

# Resource requests/limits. ephemeral-storage guards against disk-filling pods.
resources:
  requests:
    cpu: ${yq(get(v, "cpuRequest", "100m"))}
    memory: ${yq(get(v, "memRequest", "128Mi"))}
    ephemeral-storage: 256Mi
  limits:
    cpu: ${yq(get(v, "cpuLimit", "500m"))}
    memory: ${yq(get(v, "memLimit", "512Mi"))}
    ephemeral-storage: 1Gi

# ── Health probes (separate liveness / readiness / startup) ────────────
# startupProbe protects slow-booting apps; until it passes, liveness/readiness
# are paused (failureThreshold * periodSeconds = max boot time).
startupProbe:
  httpGet:
    path: ${yq(probePath)}
    port: http
  initialDelaySeconds: 5
  periodSeconds: 5
  timeoutSeconds: 3
  failureThreshold: 30
livenessProbe:
  httpGet:
    path: ${yq(probePath)}
    port: http
  initialDelaySeconds: 15
  periodSeconds: 20
  timeoutSeconds: 5
  failureThreshold: 3
readinessProbe:
  httpGet:
    path: ${yq(probePath)}
    port: http
  initialDelaySeconds: 5
  periodSeconds: 10
  timeoutSeconds: 3
  failureThreshold: 3

# Graceful shutdown: preStop gives in-flight requests time to drain before
# SIGTERM; terminationGracePeriodSeconds is the hard ceiling.
lifecycle:
  preStop:
    exec:
      command: ["/bin/sh", "-c", "sleep 15"]
terminationGracePeriodSeconds: 60

# Zero-downtime rollout: never take a pod down before its replacement is Ready.
updateStrategy:
  type: RollingUpdate
  rollingUpdate:
    maxSurge: 1
    maxUnavailable: 0

autoscaling:
  enabled: ${hpaEnabled}
  minReplicas: ${num(v, "minReplicas", 2)}
  maxReplicas: ${num(v, "maxReplicas", 10)}
  targetCPUUtilizationPercentage: ${num(v, "targetCpu", 70)}

# Extra env vars (KEY/VALUE). ConfigMap/Secret data below are injected via envFrom.
env:${envBlock ? "\n" + envBlock : " []"}

# ── Scheduling / spreading ─────────────────────────────────────────────
nodeSelector: {}
tolerations: []
# Raw affinity override. If non-empty it WINS over podAntiAffinity below.
affinity: {}
# Spread replicas across nodes so one node failure can't take them all out.
podAntiAffinity:
  enabled: true
  type: soft   # soft = preferred (won't block scheduling); hard = required
# Spread replicas across zones for AZ-failure resilience.
topologySpreadConstraints:
  enabled: true
  maxSkew: 1
  topologyKey: topology.kubernetes.io/zone
  whenUnsatisfiable: ScheduleAnyway

# Writable /tmp so readOnlyRootFilesystem apps can still write scratch files.
tmpVolume:
  enabled: true
  sizeLimit: 256Mi
extraVolumes: []
extraVolumeMounts: []

# ── ConfigMap (non-secret app config, injected as env via envFrom) ─────
configMap:
  enabled: true
  data:
    APP_ENV: production
    LOG_LEVEL: info
    DB_HOST: ""

# ── Secret (PLACEHOLDERS ONLY) ─────────────────────────────────────────
# Do NOT commit real secrets. In production use the External Secrets Operator
# or HashiCorp Vault to inject these at runtime.
secret:
  enabled: true
  data:
    DB_PASSWORD: ""
    API_KEY: ""

# ── PodDisruptionBudget — keep N pods up during voluntary disruptions ──
pdb:
  enabled: ${pdbEnabled}
  minAvailable: 1

# ── NetworkPolicy — default-deny, allow only what's listed ─────────────
networkPolicy:
  enabled: ${npEnabled}
  ingressNamespace: ingress-nginx   # namespace allowed to reach this app
  dnsPort: 53
  allowedNamespaces: []             # extra namespaces this app may egress to

# ── Prometheus ServiceMonitor (needs the Prometheus Operator CRDs) ─────
serviceMonitor:
  enabled: ${smEnabled}
  interval: 30s
  path: /metrics
  # scrapeTimeout: 10s

# ── Prometheus alert rules (needs the Prometheus Operator CRDs) ────────
prometheusRule:
  enabled: ${prEnabled}
  errorRateThreshold: 5    # % of 5xx responses
  memoryThreshold: 90      # % of memory limit
`;
}

function chartYaml(v: Record<string, string>): string {
  const name = get(v, "name", "app");
  const desc = get(v, "description", "A Helm chart for Kubernetes");
  const appVersion = get(v, "appVersion", "1.0.0");
  return [
    `apiVersion: v2`,
    `name: ${yq(name)}`,
    `description: ${yq(desc)}`,
    `type: application`,
    `version: 0.1.0`,
    `appVersion: ${JSON.stringify(appVersion)}`,
    ``,
  ].join("\n");
}

// ── static Go-templated chart files ───────────────────────────────────
const HELPERS_TPL = `{{/*
Common template helpers — generated by the DeepAgent Helm builder.
*/}}
{{- define "app.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "app.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- $name := default .Chart.Name .Values.nameOverride -}}
{{- if contains $name .Release.Name -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- printf "%s-%s" .Release.Name $name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}
{{- end -}}

{{- define "app.chart" -}}
{{- printf "%s-%s" .Chart.Name .Chart.Version | replace "+" "_" | trunc 63 | trimSuffix "-" -}}
{{- end -}}

{{- define "app.labels" -}}
helm.sh/chart: {{ include "app.chart" . }}
{{ include "app.selectorLabels" . }}
{{- if .Chart.AppVersion }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
{{- end }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
app.kubernetes.io/managed-by-tool: deepagent
{{- end -}}

{{- define "app.selectorLabels" -}}
app.kubernetes.io/name: {{ include "app.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "app.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{- default (include "app.fullname" .) .Values.serviceAccount.name -}}
{{- else -}}
{{- default "default" .Values.serviceAccount.name -}}
{{- end -}}
{{- end -}}
`;

const DEPLOYMENT_TPL = `apiVersion: apps/v1
kind: Deployment
metadata:
  name: {{ include "app.fullname" . }}
  labels:
    {{- include "app.labels" . | nindent 4 }}
spec:
  {{- if not .Values.autoscaling.enabled }}
  replicas: {{ .Values.replicaCount }}
  {{- end }}
  revisionHistoryLimit: 5
  {{- with .Values.updateStrategy }}
  strategy:
    {{- toYaml . | nindent 4 }}
  {{- end }}
  selector:
    matchLabels:
      {{- include "app.selectorLabels" . | nindent 6 }}
  template:
    metadata:
      {{- with .Values.podAnnotations }}
      annotations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      labels:
        {{- include "app.selectorLabels" . | nindent 8 }}
        {{- with .Values.podLabels }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
    spec:
      {{- with .Values.imagePullSecrets }}
      imagePullSecrets:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      serviceAccountName: {{ include "app.serviceAccountName" . }}
      automountServiceAccountToken: {{ .Values.serviceAccount.automountServiceAccountToken }}
      terminationGracePeriodSeconds: {{ .Values.terminationGracePeriodSeconds }}
      securityContext:
        {{- toYaml .Values.podSecurityContext | nindent 8 }}
      containers:
        - name: {{ .Chart.Name }}
          {{- if .Values.image.digest }}
          image: {{ printf "%s@%s" .Values.image.repository .Values.image.digest | quote }}
          {{- else }}
          image: {{ printf "%s:%s" .Values.image.repository (.Values.image.tag | default .Chart.AppVersion) | quote }}
          {{- end }}
          imagePullPolicy: {{ .Values.image.pullPolicy }}
          securityContext:
            {{- toYaml .Values.securityContext | nindent 12 }}
          ports:
            - name: http
              containerPort: {{ .Values.containerPort }}
              protocol: TCP
          {{- if or .Values.configMap.enabled .Values.secret.enabled }}
          envFrom:
            {{- if .Values.configMap.enabled }}
            - configMapRef:
                name: {{ include "app.fullname" . }}
            {{- end }}
            {{- if .Values.secret.enabled }}
            - secretRef:
                name: {{ include "app.fullname" . }}
            {{- end }}
          {{- end }}
          {{- with .Values.env }}
          env:
            {{- toYaml . | nindent 12 }}
          {{- end }}
          {{- with .Values.startupProbe }}
          startupProbe:
            {{- toYaml . | nindent 12 }}
          {{- end }}
          {{- with .Values.livenessProbe }}
          livenessProbe:
            {{- toYaml . | nindent 12 }}
          {{- end }}
          {{- with .Values.readinessProbe }}
          readinessProbe:
            {{- toYaml . | nindent 12 }}
          {{- end }}
          {{- with .Values.lifecycle }}
          lifecycle:
            {{- toYaml . | nindent 12 }}
          {{- end }}
          resources:
            {{- toYaml .Values.resources | nindent 12 }}
          {{- if or .Values.tmpVolume.enabled .Values.extraVolumeMounts }}
          volumeMounts:
            {{- if .Values.tmpVolume.enabled }}
            - name: tmp
              mountPath: /tmp
            {{- end }}
            {{- with .Values.extraVolumeMounts }}
            {{- toYaml . | nindent 12 }}
            {{- end }}
          {{- end }}
      {{- if or .Values.tmpVolume.enabled .Values.extraVolumes }}
      volumes:
        {{- if .Values.tmpVolume.enabled }}
        - name: tmp
          emptyDir:
            sizeLimit: {{ .Values.tmpVolume.sizeLimit }}
        {{- end }}
        {{- with .Values.extraVolumes }}
        {{- toYaml . | nindent 8 }}
        {{- end }}
      {{- end }}
      {{- with .Values.nodeSelector }}
      nodeSelector:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- with .Values.tolerations }}
      tolerations:
        {{- toYaml . | nindent 8 }}
      {{- end }}
      {{- if .Values.affinity }}
      affinity:
        {{- toYaml .Values.affinity | nindent 8 }}
      {{- else if .Values.podAntiAffinity.enabled }}
      affinity:
        podAntiAffinity:
          {{- if eq .Values.podAntiAffinity.type "hard" }}
          requiredDuringSchedulingIgnoredDuringExecution:
            - labelSelector:
                matchLabels:
                  {{- include "app.selectorLabels" . | nindent 18 }}
              topologyKey: kubernetes.io/hostname
          {{- else }}
          preferredDuringSchedulingIgnoredDuringExecution:
            - weight: 100
              podAffinityTerm:
                labelSelector:
                  matchLabels:
                    {{- include "app.selectorLabels" . | nindent 20 }}
                topologyKey: kubernetes.io/hostname
          {{- end }}
      {{- end }}
      {{- if .Values.topologySpreadConstraints.enabled }}
      topologySpreadConstraints:
        - maxSkew: {{ .Values.topologySpreadConstraints.maxSkew }}
          topologyKey: {{ .Values.topologySpreadConstraints.topologyKey }}
          whenUnsatisfiable: {{ .Values.topologySpreadConstraints.whenUnsatisfiable }}
          labelSelector:
            matchLabels:
              {{- include "app.selectorLabels" . | nindent 14 }}
      {{- end }}
`;

const SERVICE_TPL = `apiVersion: v1
kind: Service
metadata:
  name: {{ include "app.fullname" . }}
  labels:
    {{- include "app.labels" . | nindent 4 }}
spec:
  type: {{ .Values.service.type }}
  ports:
    - port: {{ .Values.service.port }}
      targetPort: http
      protocol: TCP
      name: http
  selector:
    {{- include "app.selectorLabels" . | nindent 4 }}
`;

const SERVICEACCOUNT_TPL = `{{- if .Values.serviceAccount.create -}}
apiVersion: v1
kind: ServiceAccount
metadata:
  name: {{ include "app.serviceAccountName" . }}
  labels:
    {{- include "app.labels" . | nindent 4 }}
  {{- with .Values.serviceAccount.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
automountServiceAccountToken: {{ .Values.serviceAccount.automountServiceAccountToken }}
{{- end }}
`;

const INGRESS_TPL = `{{- if .Values.ingress.enabled -}}
apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {{ include "app.fullname" . }}
  labels:
    {{- include "app.labels" . | nindent 4 }}
  {{- with .Values.ingress.annotations }}
  annotations:
    {{- toYaml . | nindent 4 }}
  {{- end }}
spec:
  {{- if .Values.ingress.className }}
  ingressClassName: {{ .Values.ingress.className }}
  {{- end }}
  {{- if .Values.ingress.tls }}
  tls:
    {{- toYaml .Values.ingress.tls | nindent 4 }}
  {{- end }}
  rules:
    {{- range .Values.ingress.hosts }}
    - host: {{ .host | quote }}
      http:
        paths:
          {{- range .paths }}
          - path: {{ .path }}
            pathType: {{ .pathType }}
            backend:
              service:
                name: {{ include "app.fullname" $ }}
                port:
                  number: {{ $.Values.service.port }}
          {{- end }}
    {{- end }}
{{- end }}
`;

const HPA_TPL = `{{- if .Values.autoscaling.enabled -}}
apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {{ include "app.fullname" . }}
  labels:
    {{- include "app.labels" . | nindent 4 }}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: Deployment
    name: {{ include "app.fullname" . }}
  minReplicas: {{ .Values.autoscaling.minReplicas }}
  maxReplicas: {{ .Values.autoscaling.maxReplicas }}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: {{ .Values.autoscaling.targetCPUUtilizationPercentage }}
{{- end }}
`;

const PDB_TPL = `{{- if .Values.pdb.enabled -}}
apiVersion: policy/v1
kind: PodDisruptionBudget
metadata:
  name: {{ include "app.fullname" . }}
  labels:
    {{- include "app.labels" . | nindent 4 }}
spec:
  minAvailable: {{ .Values.pdb.minAvailable }}
  selector:
    matchLabels:
      {{- include "app.selectorLabels" . | nindent 6 }}
{{- end }}
`;

const NETWORKPOLICY_TPL = `{{- if .Values.networkPolicy.enabled -}}
apiVersion: networking.k8s.io/v1
kind: NetworkPolicy
metadata:
  name: {{ include "app.fullname" . }}
  labels:
    {{- include "app.labels" . | nindent 4 }}
spec:
  podSelector:
    matchLabels:
      {{- include "app.selectorLabels" . | nindent 6 }}
  # Selecting both types with only explicit allows below = default deny.
  policyTypes:
    - Ingress
    - Egress
  ingress:
    # Allow traffic only from the ingress controller's namespace.
    - from:
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: {{ .Values.networkPolicy.ingressNamespace }}
      ports:
        - protocol: TCP
          port: {{ .Values.containerPort }}
  egress:
    # Allow DNS resolution (kube-dns) on the configured port.
    - to:
        - namespaceSelector: {}
      ports:
        - protocol: UDP
          port: {{ .Values.networkPolicy.dnsPort }}
        - protocol: TCP
          port: {{ .Values.networkPolicy.dnsPort }}
    {{- with .Values.networkPolicy.allowedNamespaces }}
    # Allow egress only to these explicitly-listed namespaces.
    - to:
        {{- range . }}
        - namespaceSelector:
            matchLabels:
              kubernetes.io/metadata.name: {{ . }}
        {{- end }}
    {{- end }}
{{- end }}
`;

const CONFIGMAP_TPL = `{{- if .Values.configMap.enabled -}}
apiVersion: v1
kind: ConfigMap
metadata:
  name: {{ include "app.fullname" . }}
  labels:
    {{- include "app.labels" . | nindent 4 }}
data:
  {{- range $k, $v := .Values.configMap.data }}
  {{ $k }}: {{ $v | quote }}
  {{- end }}
{{- end }}
`;

const SECRET_TPL = `{{- if .Values.secret.enabled -}}
# NOTE: placeholder Secret. Do NOT commit real secret values. In production use
# the External Secrets Operator or HashiCorp Vault (vault-injector) to inject
# these at runtime instead of templating them here.
apiVersion: v1
kind: Secret
metadata:
  name: {{ include "app.fullname" . }}
  labels:
    {{- include "app.labels" . | nindent 4 }}
type: Opaque
stringData:
  {{- range $k, $v := .Values.secret.data }}
  {{ $k }}: {{ $v | quote }}
  {{- end }}
{{- end }}
`;

const SERVICEMONITOR_TPL = `{{- if .Values.serviceMonitor.enabled -}}
apiVersion: monitoring.coreos.com/v1
kind: ServiceMonitor
metadata:
  name: {{ include "app.fullname" . }}
  labels:
    {{- include "app.labels" . | nindent 4 }}
spec:
  selector:
    matchLabels:
      {{- include "app.selectorLabels" . | nindent 6 }}
  namespaceSelector:
    matchNames:
      - {{ .Release.Namespace }}
  endpoints:
    - port: http
      path: {{ .Values.serviceMonitor.path }}
      interval: {{ .Values.serviceMonitor.interval }}
      {{- with .Values.serviceMonitor.scrapeTimeout }}
      scrapeTimeout: {{ . }}
      {{- end }}
{{- end }}
`;

const PROMETHEUSRULE_TPL = `{{- if .Values.prometheusRule.enabled -}}
apiVersion: monitoring.coreos.com/v1
kind: PrometheusRule
metadata:
  name: {{ include "app.fullname" . }}
  labels:
    {{- include "app.labels" . | nindent 4 }}
spec:
  groups:
    - name: {{ include "app.fullname" . }}.rules
      rules:
        - alert: {{ include "app.name" . }}HighErrorRate
          expr: |
            100 * sum(rate(http_requests_total{job="{{ include "app.fullname" . }}",status=~"5.."}[5m]))
            / sum(rate(http_requests_total{job="{{ include "app.fullname" . }}"}[5m]))
            > {{ .Values.prometheusRule.errorRateThreshold }}
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "High 5xx error rate on {{ include "app.fullname" . }}"
        - alert: {{ include "app.name" . }}PodRestartLoop
          expr: |
            increase(kube_pod_container_status_restarts_total{pod=~"{{ include "app.fullname" . }}.*"}[15m]) > 3
          for: 5m
          labels:
            severity: warning
          annotations:
            summary: "{{ include "app.fullname" . }} pods are restarting repeatedly"
        - alert: {{ include "app.name" . }}HighMemory
          expr: |
            100 * max(container_memory_working_set_bytes{pod=~"{{ include "app.fullname" . }}.*"})
            / max(kube_pod_container_resource_limits{pod=~"{{ include "app.fullname" . }}.*",resource="memory"})
            > {{ .Values.prometheusRule.memoryThreshold }}
          for: 10m
          labels:
            severity: warning
          annotations:
            summary: "High memory usage on {{ include "app.fullname" . }}"
{{- end }}
`;

const NOTES_TPL = `{{ .Chart.Name }} has been deployed.

Release:   {{ .Release.Name }}
Namespace: {{ .Release.Namespace }}

{{- if .Values.ingress.enabled }}
URL(s):
{{- range .Values.ingress.hosts }}
  http{{ if $.Values.ingress.tls }}s{{ end }}://{{ .host }}
{{- end }}
{{- else if contains "LoadBalancer" .Values.service.type }}
Get the external IP:
  kubectl get svc {{ include "app.fullname" . }} -n {{ .Release.Namespace }} -w
{{- else }}
Port-forward to test locally:
  kubectl port-forward svc/{{ include "app.fullname" . }} 8080:{{ .Values.service.port }} -n {{ .Release.Namespace }}
{{- end }}

Check rollout:
  kubectl rollout status deploy/{{ include "app.fullname" . }} -n {{ .Release.Namespace }}
`;

const HELMIGNORE = `.DS_Store
.git/
.gitignore
*.tmproj
*.bak
*.orig
.idea/
.vscode/
`;

/**
 * Build a complete, production-grade Helm chart from the spec. Returns the file
 * tree keyed by path relative to the chart directory. Always deterministic.
 */
export function buildHelmChart(values: Record<string, string>): HelmChartResult {
  const chartName = get(values, "name", "app");
  const files: Record<string, string> = {
    "Chart.yaml": chartYaml(values),
    "values.yaml": valuesYaml(values),
    ".helmignore": HELMIGNORE,
    "templates/_helpers.tpl": HELPERS_TPL,
    "templates/deployment.yaml": DEPLOYMENT_TPL,
    "templates/service.yaml": SERVICE_TPL,
    "templates/serviceaccount.yaml": SERVICEACCOUNT_TPL,
    "templates/ingress.yaml": INGRESS_TPL,
    "templates/hpa.yaml": HPA_TPL,
    "templates/pdb.yaml": PDB_TPL,
    "templates/networkpolicy.yaml": NETWORKPOLICY_TPL,
    "templates/configmap.yaml": CONFIGMAP_TPL,
    "templates/secret.yaml": SECRET_TPL,
    "templates/servicemonitor.yaml": SERVICEMONITOR_TPL,
    "templates/prometheusrule.yaml": PROMETHEUSRULE_TPL,
    "templates/NOTES.txt": NOTES_TPL,
  };
  return { chartName, files, fileCount: Object.keys(files).length };
}
