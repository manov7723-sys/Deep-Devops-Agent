/**
 * Deploy-My-App manifest builder — pure TS (no server imports) so the wizard
 * can render an instant live preview on the client and the server can reuse the
 * exact same YAML to apply.
 *
 * WHY NOT the hardened manifest-templates Deployment: that template forces
 * `runAsNonRoot` + `readOnlyRootFilesystem` and an HTTP `/healthz` probe — great
 * for a security baseline, but it stops many real images from ever becoming
 * Ready (nginx runs as root and writes to disk; most apps have no /healthz). For
 * a "get ANY app running" flow we emit a friendlier spec: a TCP readiness/
 * liveness probe on the container port (works for any TCP listener), modest
 * resource requests, and no forced security context.
 */

export type DeployEnvVar = { key: string; value: string };

export type DeploySpec = {
  appName: string;
  image: string;
  namespace: string;
  replicas: number;
  containerPort: number;
  env: DeployEnvVar[];
  /** Expose publicly via an Ingress (needs a host). */
  expose: boolean;
  host?: string;
  /** Service port; defaults to 80. */
  servicePort?: number;
};

/** RFC-1123 label: lowercase alphanumerics + hyphens, ≤63 chars. */
export function sanitizeAppName(raw: string): string {
  const s = (raw || "app")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 63)
    .replace(/-+$/g, "");
  return s || "app";
}

const q = (s: string) => (/^[A-Za-z0-9_\-./:]+$/.test(s) ? s : JSON.stringify(s));

function labels(app: string, indentSpaces: number): string {
  const pad = " ".repeat(indentSpaces);
  return `${pad}app.kubernetes.io/name: ${q(app)}\n${pad}app.kubernetes.io/managed-by: deepagent`;
}

function deployment(spec: DeploySpec, app: string): string {
  const envBlock = spec.env.length
    ? `\n          env:\n` +
      spec.env
        .filter((e) => e.key.trim())
        .map((e) => `            - name: ${q(e.key.trim())}\n              value: ${q(e.value)}`)
        .join("\n")
    : "";

  return [
    `apiVersion: apps/v1`,
    `kind: Deployment`,
    `metadata:`,
    `  name: ${q(app)}`,
    `  namespace: ${q(spec.namespace)}`,
    `  labels:`,
    labels(app, 4),
    `spec:`,
    `  replicas: ${spec.replicas}`,
    `  revisionHistoryLimit: 5`,
    `  selector:`,
    `    matchLabels:`,
    `      app.kubernetes.io/name: ${q(app)}`,
    `  strategy:`,
    `    type: RollingUpdate`,
    `    rollingUpdate:`,
    `      maxSurge: 25%`,
    `      maxUnavailable: 0`,
    `  template:`,
    `    metadata:`,
    `      labels:`,
    labels(app, 8),
    `    spec:`,
    `      containers:`,
    `        - name: ${q(app)}`,
    `          image: ${q(spec.image)}`,
    `          imagePullPolicy: IfNotPresent`,
    `          ports:`,
    `            - containerPort: ${spec.containerPort}`,
    `          resources:`,
    `            requests:`,
    `              cpu: 50m`,
    `              memory: 64Mi`,
    `            limits:`,
    `              cpu: 500m`,
    `              memory: 512Mi`,
    `          readinessProbe:`,
    `            tcpSocket:`,
    `              port: ${spec.containerPort}`,
    `            initialDelaySeconds: 5`,
    `            periodSeconds: 10`,
    `          livenessProbe:`,
    `            tcpSocket:`,
    `              port: ${spec.containerPort}`,
    `            initialDelaySeconds: 15`,
    `            periodSeconds: 20` + envBlock,
    ``,
  ].join("\n");
}

function service(spec: DeploySpec, app: string): string {
  const port = spec.servicePort ?? 80;
  return [
    `apiVersion: v1`,
    `kind: Service`,
    `metadata:`,
    `  name: ${q(app)}`,
    `  namespace: ${q(spec.namespace)}`,
    `  labels:`,
    labels(app, 4),
    `spec:`,
    `  type: ClusterIP`,
    `  selector:`,
    `    app.kubernetes.io/name: ${q(app)}`,
    `  ports:`,
    `    - name: http`,
    `      port: ${port}`,
    `      targetPort: ${spec.containerPort}`,
    ``,
  ].join("\n");
}

function ingress(spec: DeploySpec, app: string): string {
  const port = spec.servicePort ?? 80;
  return [
    `apiVersion: networking.k8s.io/v1`,
    `kind: Ingress`,
    `metadata:`,
    `  name: ${q(app)}`,
    `  namespace: ${q(spec.namespace)}`,
    `  labels:`,
    labels(app, 4),
    `spec:`,
    `  ingressClassName: nginx`,
    `  rules:`,
    `    - host: ${q(spec.host || "")}`,
    `      http:`,
    `        paths:`,
    `          - path: /`,
    `            pathType: Prefix`,
    `            backend:`,
    `              service:`,
    `                name: ${q(app)}`,
    `                port:`,
    `                  number: ${port}`,
    ``,
  ].join("\n");
}

export type BuiltManifest = { yaml: string; resources: string[] };

/** Build Deployment + Service (+ Ingress when exposed) as one multi-doc YAML. */
export function buildDeployManifest(spec: DeploySpec): BuiltManifest {
  const app = sanitizeAppName(spec.appName);
  const docs = [deployment(spec, app), service(spec, app)];
  const resources = ["Deployment", "Service"];
  if (spec.expose && (spec.host || "").trim()) {
    docs.push(ingress(spec, app));
    resources.push("Ingress");
  }
  return { yaml: docs.join("---\n"), resources };
}
