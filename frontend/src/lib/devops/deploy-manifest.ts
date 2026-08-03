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
 *
 * ─────────────────────────────────────────────────────────────────────────
 * ADR (2026-07): public HTTP exposure defaults to ALB via Ingress, NEVER NLB.
 * ─────────────────────────────────────────────────────────────────────────
 * WHAT BROKE: every generated frontend Service carried
 *     type: LoadBalancer
 *     service.beta.kubernetes.io/aws-load-balancer-type: external
 *     service.beta.kubernetes.io/aws-load-balancer-nlb-target-type: ip
 * which asks AWS for a NETWORK Load Balancer. Our AWS account returns
 * OperationNotPermitted for NLB creation (ALB creation IS permitted), and
 * Kubernetes surfaces that failure only as EXTERNAL-IP <pending> forever —
 * no error in `kubectl get svc`, nothing in the pod logs. Hours were lost
 * because the symptom looks like "the LB is still provisioning".
 *
 * NLB is also the wrong layer for a plain HTTP frontend: it is L4, so no
 * path/host routing, no WAF, no native ACM TLS termination.
 *
 * THE DEFAULT IS NOW: Service type=ClusterIP + an Ingress with
 * ingressClassName=alb, which the AWS Load Balancer Controller reconciles
 * into an internet-facing ALB. The controller is installed by our EKS
 * Terraform (see lib/devops/eks.ts) so it survives cluster rebuilds.
 *
 * NLB remains reachable ONLY as an explicit opt-in (exposeMode="nlb") for
 * genuine L4/TCP workloads — gRPC streaming, raw sockets, etc.
 *
 * DO NOT reinstate LoadBalancer+NLB as a default, and DO NOT reintroduce a
 * flag that silently turns it back on. See README-eks-exposure.md.
 */

export type DeployEnvVar = { key: string; value: string };

/**
 * Secrets to mount wholesale into the container via `envFrom.secretRef`.
 *
 * WHY THIS IS PART OF THE MANIFEST (2026-07 incident):
 * Connecting a database wrote a Secret, then a human ran `kubectl patch` to add
 * envFrom. That patch lives only in the live object — the NEXT CD run re-applies
 * the generated manifest, which had no envFrom, and silently strips it. The app
 * comes back up with no DATABASE_URL and no clue why. Declaring the secret refs
 * in the generated manifest makes the wiring survive every redeploy.
 *
 * Missing secrets are tolerated by Kubernetes only when marked optional, so each
 * entry carries that flag — a deploy must not crash-loop because an optional
 * config secret hasn't been created yet.
 */
export type DeploySecretRef = { name: string; optional?: boolean };

export type DeploySpec = {
  appName: string;
  image: string;
  namespace: string;
  replicas: number;
  containerPort: number;
  env: DeployEnvVar[];
  /** Secrets mounted wholesale as env vars — see DeploySecretRef. Declaring
   *  them here (rather than patching the live Deployment) is what makes the
   *  database/config wiring survive a redeploy. */
  envFromSecrets?: DeploySecretRef[];
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
  /** Cloud the target cluster runs on — used to gate cloud-specific annotations. */
  cloud?: "aws" | "gcp" | "azure" | "other";
  /**
   * Opt into modern AWS NLB + dualstack (IPv4+IPv6) instead of Classic ELB.
   * OFF by default because many new/trial AWS accounts can't create ELBv2
   * NLBs ("OperationNotPermitted") even though they CAN create Classic
   * ELB via ELBv1. Enable when the account has NLB quota + the AWS Load
   * Balancer Controller (or at least ELBv2 permissions).
   */
  useAwsNlb?: boolean;
  /**
   * How to expose the app externally — the USER's choice, asked in the deploy
   * wizard (see agent.ts step 3). Each mode produces a different manifest
   * shape:
   *
   *   "nlb"      → Service type=LoadBalancer + AWS NLB annotations.
   *                Layer 4 (TCP). Fast, gives a stable DNS name, no domain
   *                required. Needs the AWS Load Balancer Controller when
   *                nodes sit in private subnets. Best default for APIs.
   *
   *   "alb"      → Service type=ClusterIP + an Ingress with ALB annotations.
   *                Layer 7 (HTTP). Supports path/host routing, WAF, and
   *                native TLS via ACM. REQUIRES the AWS Load Balancer
   *                Controller on the cluster. Host is OPTIONAL — without one
   *                you still get the ALB's DNS name.
   *
   *   "nodeport" → Service type=NodePort only. No load balancer, so $0/mo.
   *                Reached at <any-node-public-ip>:<nodePort> (30000-32767).
   *                Only usable when nodes are in PUBLIC subnets and the node
   *                security group allows that port. Good for dev/demo.
   *
   *   "classic"  → Service type=LoadBalancer with NO annotations. The in-tree
   *                cloud-controller-manager provisions a legacy Classic ELB.
   *                Needs NO extra controller, works on brand-new AWS accounts
   *                — this is the auto-detected default for public-subnet
   *                clusters when the user expressed no preference.
   *
   *   "ingress"  → Service type=ClusterIP + an nginx Ingress on `host`.
   *                Requires an nginx ingress controller AND a domain.
   *
   *   undefined + expose=false → ClusterIP (internal only).
   */
  exposeMode?: "nlb" | "alb" | "nodeport" | "classic" | "ingress";
  /**
   * Emit a ServiceMonitor so Prometheus scrapes this app's own /metrics.
   *
   * WHY DEFAULT-ON: the Observability page renders "Service metrics (app)"
   * cards — request rate, 5xx, p95 latency — unconditionally. Those come from
   * the APP's /metrics endpoint, not from cAdvisor, so without a ServiceMonitor
   * they read "—" forever and the UI is promising data it never delivers.
   * Creating one at deploy time makes the cards fill in by themselves the
   * moment the app exposes metrics.
   *
   * Harmless when the app has no /metrics: Prometheus simply marks that target
   * down. It costs one scrape attempt per interval and breaks nothing.
   *
   * REQUIRES the Prometheus Operator CRDs. `kubectl apply` hard-fails with
   * "no matches for kind ServiceMonitor" on a cluster without them, so the
   * caller MUST verify the CRD exists before setting this — see
   * detectServiceMonitorCrd() in lib/cloud/aws-onboard.ts.
   */
  scrapeMetrics?: boolean;
  /** Port NAME on the Service to scrape. Defaults to "http". */
  metricsPort?: string;
  /** Metrics path. Defaults to "/metrics". */
  metricsPath?: string;
  /**
   * HTTP path to probe on the container port for readiness (and startup once
   * TCP is up). When set, the readiness probe emits `httpGet` on this path
   * instead of the default `tcpSocket`. `tcpSocket` marks the pod ready as
   * soon as the port is accepting connections — often before the app is
   * actually serving traffic; an HTTP probe on a real health endpoint is
   * accurate and cheap. Auto-detected by `detectHealthProbePath` (see
   * lib/automation/pre-deploy-analyze.ts) or overridden via `deepagent.yaml`.
   * Liveness stays on `tcpSocket` regardless — deliberately more forgiving so
   * a transient HTTP stall never kills a serving container.
   */
  probePath?: string;
  /**
   * K8s resource requests/limits, sourced from `deepagent.yaml` overrides.
   * Omitted values leave K8s defaults in place (no explicit requests → best-
   * effort scheduling; no limits → no throttling ceiling).
   */
  resources?: {
    requests?: { cpu?: string; memory?: string };
    limits?: { cpu?: string; memory?: string };
  };
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

// YAML scalars that LOOK like plain strings but get parsed as bool/null/int/
// float when unquoted. Kubernetes fields declared as `string` (env.value,
// annotation values, label values, image tag) REJECT non-string types with
// "cannot unmarshal bool into Go struct field ... of type string" — which is
// how a bare `SESSION_COOKIE_SECURE: false` broke a deploy in the 2026-08
// incident. Quote every value that YAML 1.1 would coerce to a non-string,
// and every value that isn't a plain identifier.
const YAML_BOOLISH = /^(?:true|false|yes|no|on|off|y|n|null|~)$/i;
const YAML_NUMBERISH = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][-+]?\d+)?$|^0x[0-9a-fA-F]+$|^0o?[0-7]+$/;
const q = (s: string) => {
  if (YAML_BOOLISH.test(s) || YAML_NUMBERISH.test(s)) return JSON.stringify(s);
  return /^[A-Za-z0-9_\-./:]+$/.test(s) ? s : JSON.stringify(s);
};

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

  // envFrom is emitted BEFORE env so the inline `env:` entries above win on a
  // key collision — Kubernetes gives `env` precedence over `envFrom`, and this
  // ordering makes that visually obvious in the rendered YAML too.
  //
  // Every ref is `optional: true` on purpose: the Deployment must schedule even
  // when a config secret hasn't been created yet. A missing REQUIRED secret puts
  // the pod in CreateContainerConfigError forever, which is a far worse failure
  // than an app booting without an optional setting.
  const secretRefs = (spec.envFromSecrets ?? []).filter((s) => s.name.trim());
  const envFromBlock = secretRefs.length
    ? `\n          envFrom:\n` +
      secretRefs
        .map(
          (s) =>
            `            - secretRef:\n` +
            `                name: ${q(s.name.trim())}\n` +
            `                optional: ${s.optional === false ? "false" : "true"}`,
        )
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
    // Resources — the built-in defaults are conservative-but-generous for a
    // typical Node/Python service. When `deepagent.yaml` provides overrides,
    // they replace the requests/limits blocks below (see spec.resources).
    `          resources:`,
    `            requests:`,
    `              cpu: ${spec.resources?.requests?.cpu ?? "50m"}`,
    `              memory: ${spec.resources?.requests?.memory ?? "64Mi"}`,
    `            limits:`,
    `              cpu: ${spec.resources?.limits?.cpu ?? "500m"}`,
    `              memory: ${spec.resources?.limits?.memory ?? "512Mi"}`,
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
    // Readiness probe: when the app exposes a real health endpoint (auto-
    // detected or set via deepagent.yaml), use httpGet on that path — the pod
    // is only marked Ready when the app actually responds 2xx, not just when
    // TCP accepts. Fall back to tcpSocket for apps with no discoverable
    // endpoint; that mirrors the pre-2026-08 behaviour.
    `          readinessProbe:`,
    ...(spec.probePath
      ? [
          `            httpGet:`,
          `              path: ${q(spec.probePath)}`,
          `              port: ${spec.containerPort}`,
        ]
      : [`            tcpSocket:`, `              port: ${spec.containerPort}`]),
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
    `            failureThreshold: 5` + envFromBlock + envBlock,
    ``,
  ].join("\n");
}

function service(spec: DeploySpec, app: string): string {
  const port = spec.servicePort ?? 80;
  const svcType = spec.serviceType ?? "LoadBalancer";
  // Service annotations depend on the user's exposeMode choice:
  //   "nlb"     → internet-facing NLB annotations on the Service. Required
  //               when nodes are in PRIVATE subnets — without the
  //               internet-facing scheme the AWS controller places the LB in
  //               a private subnet and it's unreachable from the internet.
  //   "classic" → NO annotations; the in-tree controller makes a Classic ELB.
  //   "alb"     → NO Service annotations at all; the ALB is driven by the
  //               INGRESS resource instead (see ingress() below), and the
  //               Service stays ClusterIP as its backend.
  //   "nodeport"→ NO annotations; type=NodePort, no LB involved.
  //   useAwsNlb → legacy flag from callers that pre-date exposeMode; same
  //               NLB annotations plus IPv4/6 dualstack.
  const annotations: Record<string, string> = {};
  // NLB annotations are emitted ONLY for an explicit exposeMode="nlb". See the
  // ADR at the top of this file: emitting them by default (or via a secondary
  // `useAwsNlb` flag) is exactly what forced every frontend onto an NLB this
  // AWS account cannot provision. `useAwsNlb` is intentionally NOT honored as
  // a second path — it stays in the type only so old stored specs still parse.
  if (svcType === "LoadBalancer" && spec.cloud === "aws" && spec.exposeMode === "nlb") {
    annotations["service.beta.kubernetes.io/aws-load-balancer-type"] = "external";
    annotations["service.beta.kubernetes.io/aws-load-balancer-scheme"] = "internet-facing";
    annotations["service.beta.kubernetes.io/aws-load-balancer-nlb-target-type"] = "ip";
  }
  // Azure: give the LoadBalancer a real hostname instead of a bare IP.
  //
  // AWS returns a DNS name from `type: LoadBalancer` for free; Azure returns
  // only an IP unless this annotation is present, in which case AKS registers
  // <label>.<region>.cloudapp.azure.com against the public IP. Without it,
  // users get "20.121.45.67" as their app URL — unusable in a browser bookmark,
  // impossible to put in an OAuth callback, and it CHANGES whenever the
  // Service is recreated. With it, the hostname is stable across redeploys.
  //
  // The label must be unique per region and DNS-safe (lowercase alphanumeric +
  // hyphens, no leading/trailing hyphen). The app name already satisfies that
  // (sanitizeAppName upstream), so we reuse it directly — a collision means
  // another cluster in the same region already claimed the name, and Azure
  // surfaces that as a clear Service event rather than a silent failure.
  if (svcType === "LoadBalancer" && spec.cloud === "azure") {
    const label = app.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/^-+|-+$/g, "");
    if (label) annotations["service.beta.kubernetes.io/azure-dns-label-name"] = label;
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

/**
 * Ingress doc. Two flavors, chosen by exposeMode:
 *
 *   "alb"     → AWS Application Load Balancer via the AWS Load Balancer
 *               Controller. ingressClassName=alb + alb.ingress.* annotations.
 *               `host` is OPTIONAL here — omitting it produces a catch-all
 *               rule and the user reaches the app at the ALB's own DNS name,
 *               so no domain purchase is needed to get a working URL.
 *   "ingress" → classic nginx ingress. Requires BOTH an nginx controller and
 *               a real `host` (nginx routes by Host header).
 */
function ingress(spec: DeploySpec, app: string): string {
  const port = spec.servicePort ?? 80;
  const isAlb = spec.exposeMode === "alb";
  const host = (spec.host || "").trim();

  const annotations: Record<string, string> = {};
  if (isAlb) {
    // Both the modern spec.ingressClassName (set below) AND the deprecated
    // class annotation are emitted. The annotation is still honored by every
    // controller version and is what older//pinned controllers actually match
    // on — belt and braces so the ALB is claimed no matter which the cluster
    // is running.
    annotations["kubernetes.io/ingress.class"] = "alb";
    annotations["alb.ingress.kubernetes.io/scheme"] = "internet-facing";
    // target-type=ip sends traffic straight to pod IPs (works with private
    // subnets + VPC CNI); "instance" would need the Service to be NodePort.
    annotations["alb.ingress.kubernetes.io/target-type"] = "ip";
    annotations["alb.ingress.kubernetes.io/listen-ports"] = '[{"HTTP": 80}]';
    annotations["alb.ingress.kubernetes.io/healthcheck-path"] = "/";
  }
  const annLines = Object.entries(annotations).map(
    ([k, v]) => `    ${JSON.stringify(k)}: ${JSON.stringify(v)}`,
  );

  const lines = [
    `apiVersion: networking.k8s.io/v1`,
    `kind: Ingress`,
    `metadata:`,
    `  name: ${q(app)}`,
    `  namespace: ${q(spec.namespace)}`,
  ];
  if (annLines.length) {
    lines.push(`  annotations:`);
    lines.push(...annLines);
  }
  lines.push(`  labels:`, labels(app, 4), `spec:`, `  ingressClassName: ${isAlb ? "alb" : "nginx"}`, `  rules:`);
  // A host line is emitted only when we actually have one. An ALB Ingress
  // with no host is a valid catch-all; an nginx Ingress without one matches
  // every request that reaches the controller.
  if (host) {
    lines.push(`    - host: ${q(host)}`, `      http:`);
  } else {
    lines.push(`    - http:`);
  }
  lines.push(
    `        paths:`,
    `          - path: /`,
    `            pathType: Prefix`,
    `            backend:`,
    `              service:`,
    `                name: ${q(app)}`,
    `                port:`,
    `                  number: ${port}`,
    ``,
  );
  return lines.join("\n");
}

/**
 * ServiceMonitor — tells the Prometheus Operator to scrape this app's Service.
 *
 * The selector reuses the SAME label the Service already carries
 * (app.kubernetes.io/name), so it can never drift from the workload it
 * targets — no hand-entered selector to get wrong.
 *
 * `release: monitoring` is required: kube-prometheus-stack's default
 * serviceMonitorSelector only matches monitors carrying its release label.
 * Without it the object is created and then silently ignored, which looks
 * exactly like the app not exposing metrics.
 */
function serviceMonitor(spec: DeploySpec, app: string): string {
  const port = spec.metricsPort || "http";
  const path = spec.metricsPath || "/metrics";
  return [
    `apiVersion: monitoring.coreos.com/v1`,
    `kind: ServiceMonitor`,
    `metadata:`,
    `  name: ${q(app)}`,
    `  namespace: ${q(spec.namespace)}`,
    `  labels:`,
    labels(app, 4),
    `    release: monitoring`,
    `spec:`,
    `  selector:`,
    `    matchLabels:`,
    `      app.kubernetes.io/name: ${q(app)}`,
    `  endpoints:`,
    `    - port: ${q(port)}`,
    `      path: ${q(path)}`,
    `      interval: 30s`,
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
  // An Ingress doc is emitted when:
  //   exposeMode="alb"     → always (host optional; ALB provides its own DNS)
  //   exposeMode="ingress" → only with a host (nginx routes by Host header,
  //                          a hostless nginx Ingress is near-useless)
  // "nlb" / "classic" / "nodeport" never need one — the Service IS the entry
  // point in those modes.
  const needsIngress =
    spec.expose &&
    (spec.exposeMode === "alb" ||
      (spec.exposeMode === "ingress" && !!(spec.host || "").trim()) ||
      // Back-compat: callers that pre-date exposeMode signalled "make an
      // Ingress" purely by supplying a host.
      (!spec.exposeMode && !!(spec.host || "").trim()));
  if (needsIngress) {
    docs.push(ingress(spec, app));
    resources.push("Ingress");
  }
  // Opt-out rather than opt-in: the Observability page always shows the
  // app-metrics cards, so the scrape config should exist by default. The
  // caller sets this false when the cluster has no Prometheus Operator CRDs
  // (a ServiceMonitor doc would make the whole `kubectl apply` fail).
  if (spec.scrapeMetrics) {
    docs.push(serviceMonitor(spec, app));
    resources.push("ServiceMonitor");
  }
  return { yaml: docs.join("---\n"), resources };
}
