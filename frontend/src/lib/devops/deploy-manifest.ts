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
  /**
   * Kubernetes Service type. Defaults to "LoadBalancer" so a fresh deploy
   * to any cluster (EKS with private nodes, GKE, AKS) gets an externally-
   * reachable endpoint without extra ingress-controller setup. "ClusterIP"
   * keeps the app internal-only (behind another gateway / VPN / mesh).
   */
  serviceType?: "ClusterIP" | "LoadBalancer" | "NodePort";
  /**
   * Cloud the target cluster runs on — used to add cloud-specific Service
   * annotations. AWS gets NLB + dualstack (IPv4 + IPv6) so users on IPv6-
   * preferred networks (Airtel, Jio, most home ISPs) can actually reach it
   * — Classic ELB is IPv4-only and silently strands v6-first browsers.
   */
  cloud?: "aws" | "gcp" | "azure" | "other";
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
    // Always pull — the image tag is mutable (":latest", overwritten by every
    // CI build). IfNotPresent makes a node reuse whatever ":latest" it cached
    // first, so a fixed image never actually rolls out ("image already present
    // on machine" in the pod events) and old/broken builds keep running.
    `          imagePullPolicy: Always`,
    `          ports:`,
    `            - containerPort: ${spec.containerPort}`,
    `          resources:`,
    `            requests:`,
    `              cpu: 50m`,
    `              memory: 64Mi`,
    `            limits:`,
    `              cpu: 500m`,
    `              memory: 512Mi`,
    // startupProbe gives the container up to ~150s (30 × 5s) to first accept a
    // TCP connection before readiness/liveness even begin. Without it, a
    // container that boots slower than initialDelaySeconds gets killed by
    // liveness mid-startup → CrashLoopBackOff → rollout times out → rollback.
    // Once the startupProbe passes ONCE, k8s switches to readiness/liveness.
    `          startupProbe:`,
    `            tcpSocket:`,
    `              port: ${spec.containerPort}`,
    `            periodSeconds: 5`,
    `            failureThreshold: 30`,
    `          readinessProbe:`,
    `            tcpSocket:`,
    `              port: ${spec.containerPort}`,
    `            initialDelaySeconds: 3`,
    `            periodSeconds: 10`,
    `            failureThreshold: 3`,
    // Liveness is deliberately FORGIVING (5 failures × 20s = ~100s) so a
    // transient stall never kills a serving container. The startupProbe
    // already covers the slow-boot case; liveness only catches a truly hung
    // process.
    `          livenessProbe:`,
    `            tcpSocket:`,
    `              port: ${spec.containerPort}`,
    `            initialDelaySeconds: 10`,
    `            periodSeconds: 20`,
    `            failureThreshold: 5` + envBlock,
    ``,
  ].join("\n");
}

function service(spec: DeploySpec, app: string): string {
  const port = spec.servicePort ?? 80;
  const svcType = spec.serviceType ?? "LoadBalancer";
  // AWS-specific annotations translate the generic k8s Service into the
  // MODERN NLB (not the 2009-era Classic ELB the AWS cloud-controller
  // defaults to). Why:
  //   - dualstack     → IPv4 + IPv6 endpoints, so IPv6-preferred networks
  //                     (Airtel, Jio, most home ISPs) can actually connect.
  //                     Classic ELB is IPv4-only → v6-first browsers hang
  //                     on "Happy Eyeballs" fallback for ~75s then timeout.
  //   - nlb-target-type: ip → routes directly to pod IPs, works with any
  //                     CNI, no host-network dance, no 1:1 SG limits.
  //   - internet-facing → placed in subnets tagged kubernetes.io/role/elb=1
  //                     so a cluster with PRIVATE node subnets still gets a
  //                     publicly-reachable LB (LB lives in the public tier).
  // Only emitted for AWS + LoadBalancer; ClusterIP or non-AWS pass through.
  const annotations: Record<string, string> = {};
  if (svcType === "LoadBalancer" && spec.cloud === "aws") {
    annotations["service.beta.kubernetes.io/aws-load-balancer-type"] = "nlb";
    annotations["service.beta.kubernetes.io/aws-load-balancer-scheme"] = "internet-facing";
    annotations["service.beta.kubernetes.io/aws-load-balancer-ip-address-type"] = "dualstack";
    annotations["service.beta.kubernetes.io/aws-load-balancer-nlb-target-type"] = "ip";
  }
  const annLines = Object.entries(annotations).map(
    ([k, v]) => `    ${JSON.stringify(k)}: ${q(v)}`,
  );
  const lines = [
    `apiVersion: v1`,
    `kind: Service`,
    `metadata:`,
    `  name: ${q(app)}`,
    `  namespace: ${q(spec.namespace)}`,
  ];
  if (annLines.length) {
    lines.push(`  annotations:`);
    lines.push(...annLines);
  }
  lines.push(
    `  labels:`,
    labels(app, 4),
    `spec:`,
    `  type: ${svcType}`,
    `  selector:`,
    `    app.kubernetes.io/name: ${q(app)}`,
    `  ports:`,
    `    - name: http`,
    `      port: ${port}`,
    `      targetPort: ${spec.containerPort}`,
    ``,
  );
  return lines.join("\n");
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

function namespace(spec: DeploySpec): string {
  return [
    `apiVersion: v1`,
    `kind: Namespace`,
    `metadata:`,
    `  name: ${q(spec.namespace)}`,
    `  labels:`,
    labels(spec.namespace, 4),
    ``,
  ].join("\n");
}

export type BuiltManifest = { yaml: string; resources: string[] };

/**
 * Build Namespace + Deployment + Service (+ Ingress when exposed) as one
 * multi-doc YAML. The Namespace doc comes first so `kubectl apply` creates it
 * before the resources that live in it — every deploy is self-contained and
 * never assumes the namespace already exists on the cluster.
 */
export function buildDeployManifest(spec: DeploySpec): BuiltManifest {
  const app = sanitizeAppName(spec.appName);
  const docs = [namespace(spec), deployment(spec, app), service(spec, app)];
  const resources = ["Namespace", "Deployment", "Service"];
  if (spec.expose && (spec.host || "").trim()) {
    docs.push(ingress(spec, app));
    resources.push("Ingress");
  }
  return { yaml: docs.join("---\n"), resources };
}
