"""
Deterministic Kubernetes manifest generator. Given an image + a few options it emits the
standard set of kinds (Namespace, Deployment/StatefulSet, Service, RBAC, ConfigMap, Secret,
Ingress, HPA) as separate YAML files under k8s/<app>/ — so the agent never hand-writes YAML.
"""


def _namespace(ns: str) -> str:
    return f"""apiVersion: v1
kind: Namespace
metadata:
  name: {ns}
"""


def _workload(kind: str, app: str, ns: str, image: str, port: int, replicas: int,
              service_account: str, cpu: str, mem: str) -> str:
    is_sts = kind.lower() == "statefulset"
    api_kind = "StatefulSet" if is_sts else "Deployment"
    sa_line = f"      serviceAccountName: {service_account}\n" if service_account else ""
    svc_name_line = f"  serviceName: {app}\n" if is_sts else ""
    replicas_line = f"  replicas: {replicas}\n"
    return f"""apiVersion: apps/v1
kind: {api_kind}
metadata:
  name: {app}
  namespace: {ns}
  labels:
    app: {app}
spec:
{replicas_line}{svc_name_line}  selector:
    matchLabels:
      app: {app}
  template:
    metadata:
      labels:
        app: {app}
    spec:
{sa_line}      containers:
        - name: {app}
          image: {image}
          ports:
            - containerPort: {port}
          resources:
            requests:
              cpu: "{cpu}"
              memory: "{mem}"
            limits:
              cpu: "500m"
              memory: "512Mi"
"""


def _service(app: str, ns: str, port: int, service_type: str) -> str:
    return f"""apiVersion: v1
kind: Service
metadata:
  name: {app}
  namespace: {ns}
  labels:
    app: {app}
spec:
  type: {service_type}
  selector:
    app: {app}
  ports:
    - port: {port}
      targetPort: {port}
      protocol: TCP
"""


def _rbac(app: str, ns: str) -> str:
    return f"""apiVersion: v1
kind: ServiceAccount
metadata:
  name: {app}-sa
  namespace: {ns}
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata:
  name: {app}-role
  namespace: {ns}
rules:
  - apiGroups: [""]
    resources: ["pods", "services", "configmaps", "secrets"]
    verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata:
  name: {app}-rolebinding
  namespace: {ns}
subjects:
  - kind: ServiceAccount
    name: {app}-sa
    namespace: {ns}
roleRef:
  kind: Role
  name: {app}-role
  apiGroup: rbac.authorization.k8s.io
"""


def _configmap(app: str, ns: str) -> str:
    return f"""apiVersion: v1
kind: ConfigMap
metadata:
  name: {app}-config
  namespace: {ns}
data:
  APP_ENV: "production"
  LOG_LEVEL: "info"
"""


def _secret(app: str, ns: str) -> str:
    return f"""apiVersion: v1
kind: Secret
metadata:
  name: {app}-secret
  namespace: {ns}
type: Opaque
stringData:
  SECRET_KEY: "change-me"
"""


def _ingress(app: str, ns: str, port: int, host: str) -> str:
    host_line = f"    - host: {host}\n" if host else "    - http:\n"
    http_block = (
        "      http:\n" if host else ""
    )
    if host:
        return f"""apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {app}
  namespace: {ns}
  annotations:
    nginx.ingress.kubernetes.io/rewrite-target: /
spec:
  ingressClassName: nginx
  rules:
    - host: {host}
      http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: {app}
                port:
                  number: {port}
"""
    return f"""apiVersion: networking.k8s.io/v1
kind: Ingress
metadata:
  name: {app}
  namespace: {ns}
spec:
  ingressClassName: nginx
  rules:
    - http:
        paths:
          - path: /
            pathType: Prefix
            backend:
              service:
                name: {app}
                port:
                  number: {port}
"""


def _hpa(app: str, ns: str, kind: str, min_replicas: int, max_replicas: int) -> str:
    api_kind = "StatefulSet" if kind.lower() == "statefulset" else "Deployment"
    return f"""apiVersion: autoscaling/v2
kind: HorizontalPodAutoscaler
metadata:
  name: {app}
  namespace: {ns}
spec:
  scaleTargetRef:
    apiVersion: apps/v1
    kind: {api_kind}
    name: {app}
  minReplicas: {min_replicas}
  maxReplicas: {max_replicas}
  metrics:
    - type: Resource
      resource:
        name: cpu
        target:
          type: Utilization
          averageUtilization: 70
"""


def build_manifests(
    app_name: str,
    image: str,
    port: int = 80,
    kind: str = "Deployment",
    namespace: str = "default",
    replicas: int = 2,
    service_type: str = "ClusterIP",
    with_service: bool = True,
    with_rbac: bool = False,
    with_configmap: bool = False,
    with_secret: bool = False,
    with_ingress: bool = False,
    ingress_host: str = "",
    with_hpa: bool = False,
    hpa_min: int = 2,
    hpa_max: int = 5,
    base_dir: str = "",
) -> dict:
    """Return {path: yaml} for the chosen kinds. base_dir defaults to k8s/<app>."""
    ns = namespace or "default"
    base = base_dir or f"k8s/{app_name}"
    sa = f"{app_name}-sa" if with_rbac else ""
    files = {}
    if ns != "default":
        files[f"{base}/namespace.yaml"] = _namespace(ns)
    files[f"{base}/{kind.lower()}.yaml"] = _workload(
        kind, app_name, ns, image, int(port), int(replicas), sa, "100m", "128Mi")
    if with_service:
        files[f"{base}/service.yaml"] = _service(app_name, ns, int(port), service_type)
    if with_rbac:
        files[f"{base}/rbac.yaml"] = _rbac(app_name, ns)
    if with_configmap:
        files[f"{base}/configmap.yaml"] = _configmap(app_name, ns)
    if with_secret:
        files[f"{base}/secret.yaml"] = _secret(app_name, ns)
    if with_ingress:
        files[f"{base}/ingress.yaml"] = _ingress(app_name, ns, int(port), ingress_host)
    if with_hpa:
        files[f"{base}/hpa.yaml"] = _hpa(app_name, ns, kind, int(hpa_min), int(hpa_max))
    return files
