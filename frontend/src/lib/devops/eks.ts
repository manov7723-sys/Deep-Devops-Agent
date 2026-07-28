/**
 * EKS cluster Terraform generator.
 *
 * Produces a production-shaped Terraform tree (VPC + EKS via the community
 * terraform-aws-modules) from a small set of wizard answers. This is the
 * TypeScript port of the old Python backend's `eks_modules` blueprint — kept
 * deterministic (no LLM) so the output is stable and reviewable.
 *
 * Returns a map of relative file path -> file contents, ready to display,
 * download, or push to a repo.
 */

export type EksSpec = {
  name: string;
  region: string;
  /** Kubernetes control-plane version, e.g. "1.30". */
  kubernetesVersion: string;
  /** Node group instance type (single). */
  instanceType: string;
  desiredNodes: number;
  minNodes: number;
  maxNodes: number;
  /** Console-style overrides for the primary node group (used when
   *  `nodeGroups` is absent, and applied to nodeGroups[0] when present). */
  nodeGroupName?: string;
  capacityType?: "ON_DEMAND" | "SPOT";
  /** Multi-node-group support. When provided, generates one
   *  `eks_managed_node_groups` entry per row instead of the single legacy group. */
  nodeGroups?: Array<{
    name: string;
    instanceType: string;
    capacityType: "ON_DEMAND" | "SPOT";
    minNodes: number;
    desiredNodes: number;
    maxNodes: number;
    diskSize: number;
  }>;
  /** Public API endpoint (true) or private-only (false). */
  endpointPublic: boolean;
  /** Create a new VPC (default) or reuse an existing one. */
  createVpc?: boolean;
  /** Existing VPC id (when createVpc is false). */
  existingVpcId?: string;
  /** Explicit subnet ids for the cluster control plane (when createVpc is false). Auto-discovered if omitted. */
  existingSubnetIds?: string[];
  /** Explicit subnet ids for worker nodes (when createVpc is false). Defaults to existingSubnetIds when omitted. */
  nodeSubnetIds?: string[];
  /** Optional S3 remote-state backend. */
  stateBucket?: string;
  stateRegion?: string;
  stateTable?: string;

  // ── Production options ──────────────────────────────────────────────
  environment?: string;
  team?: string;
  costCenter?: string;
  /** Restrict the public API endpoint to these CIDRs (when endpointPublic). */
  publicAccessCidrs?: string; // comma-separated, e.g. "1.2.3.4/32"
  /** Enable all 5 control-plane log types → CloudWatch. */
  controlPlaneLogs?: boolean;
  /** KMS encryption of Kubernetes secrets at rest. */
  secretsEncryption?: boolean;
  /** System node group disk size (GB). */
  systemDiskSize?: number;
  /** Add the AWS EBS CSI driver add-on (persistent volumes). */
  ebsCsi?: boolean;
  /** Add a second, autoscaling application node group (Spot-capable). */
  appNodeGroup?: boolean;
  appInstanceTypes?: string[];
  appCapacityType?: "ON_DEMAND" | "SPOT";
  appMinNodes?: number;
  appMaxNodes?: number;
  appDesiredNodes?: number;
  /** Additional IAM users/roles granted cluster access via EKS Access Entries. */
  accessEntries?: EksAccessEntry[];
};

export type EksAccessPolicy =
  | "AmazonEKSClusterAdminPolicy"
  | "AmazonEKSAdminPolicy"
  | "AmazonEKSEditPolicy"
  | "AmazonEKSViewPolicy";
export type EksAccessEntry = { principalArn: string; policy: EksAccessPolicy };

export type EksDefaults = Omit<EksSpec, "name">;

export const EKS_DEFAULTS: EksDefaults = {
  region: "us-east-1",
  kubernetesVersion: "1.33",
  instanceType: "m5.large",
  desiredNodes: 2,
  minNodes: 2,
  maxNodes: 4,
  endpointPublic: true,
  environment: "production",
  team: "devops",
  costCenter: "",
  publicAccessCidrs: "0.0.0.0/0",
  controlPlaneLogs: true,
  secretsEncryption: true,
  systemDiskSize: 100,
  ebsCsi: true,
  capacityType: "ON_DEMAND",
  // Second (tainted) system node group is OPT-IN. Was true by default which
  // silently gave every user two node groups even when they asked for one.
  appNodeGroup: false,
  appInstanceTypes: ["m5.large", "m5.xlarge"],
  appCapacityType: "SPOT",
  appMinNodes: 2,
  appMaxNodes: 20,
  appDesiredNodes: 3,
};

export const EKS_INSTANCE_TYPES = [
  "t3.medium",
  "t3.large",
  "m5.large",
  "m5.xlarge",
  "m5.2xlarge",
  "c5.xlarge",
];
export const EKS_K8S_VERSIONS = ["1.36", "1.35", "1.34", "1.33", "1.32", "1.31", "1.30"];
export const EKS_DISK_SIZES = [50, 100, 150, 200];
export const EKS_CAPACITY_TYPES = ["ON_DEMAND", "SPOT"];
export const EKS_ACCESS_POLICIES: EksAccessPolicy[] = [
  "AmazonEKSClusterAdminPolicy",
  "AmazonEKSAdminPolicy",
  "AmazonEKSEditPolicy",
  "AmazonEKSViewPolicy",
];

/** Render the `eks_managed_node_groups = { ... }` inner body. When
 *  `spec.nodeGroups` is present, one entry per row; else the legacy
 *  single-group construction (primary + optional tainted app group). */
function renderNodeGroups(
  spec: EksSpec,
  ctx: {
    primaryGroupKey: string;
    primaryCapacity: "ON_DEMAND" | "SPOT";
    systemDisk: number;
    hasApp: boolean;
    systemTaint: string;
    appGroup: string;
    env: string;
  },
): string {
  // Multi-node-group path.
  if (spec.nodeGroups && spec.nodeGroups.length > 0) {
    // Dedup key names — Terraform module rejects duplicate keys in the map.
    const seen = new Set<string>();
    return spec.nodeGroups
      .map((g) => {
        let key = g.name
          .toLowerCase()
          .replace(/[^a-z0-9-]/g, "-")
          .slice(0, 63);
        let i = 2;
        while (seen.has(key)) key = `${g.name}-${i++}`.slice(0, 63);
        seen.add(key);
        return `    ${key} = {
      subnet_ids     = local.node_subnet_ids
      instance_types = ["${g.instanceType}"]
      capacity_type  = "${g.capacityType}"
      min_size       = ${g.minNodes}
      max_size       = ${g.maxNodes}
      desired_size   = ${g.desiredNodes}
      disk_size      = ${g.diskSize}
      labels = { role = "${key}", env = "${ctx.env}" }
    }`;
      })
      .join("\n");
  }
  // Legacy single-group (+ optional tainted app) path.
  return `    ${ctx.primaryGroupKey} = {
      subnet_ids     = local.node_subnet_ids
      instance_types = ["${spec.instanceType}"]
      capacity_type  = "${ctx.primaryCapacity}"
      min_size       = ${spec.minNodes}
      max_size       = ${spec.maxNodes}
      desired_size   = ${spec.desiredNodes}
      disk_size      = ${ctx.systemDisk}
      labels = { role = ${ctx.hasApp ? `"system"` : `"workers"`} }${ctx.systemTaint}
    }${ctx.appGroup}`;
}

function backendBlock(spec: EksSpec): string {
  if (!spec.stateBucket) {
    return `  # No S3 backend configured — state is local. Set a Terraform state\n  # bucket on the Infrastructure page for production use.`;
  }
  // Terraform 1.10+ supports S3-native locking via conditional writes — no
  // DynamoDB table required. Fall back to dynamodb_table only when the
  // caller explicitly provides a table name (legacy stacks that already
  // depend on one). `dynamodb_table` is deprecated in newer AWS providers.
  const lock = spec.stateTable
    ? `\n    dynamodb_table = "${spec.stateTable}"`
    : `\n    use_lockfile   = true`;
  return `  backend "s3" {
    bucket = "${spec.stateBucket}"
    key    = "eks/${spec.name}/terraform.tfstate"
    region = "${spec.stateRegion || spec.region}"${lock}
  }`;
}

/** Build the full Terraform file tree for the cluster. */
export function buildEksTerraform(spec: EksSpec): Record<string, string> {
  const cluster = spec.name;

  const versions = `terraform {
  required_version = ">= 1.5.0"
${backendBlock(spec)}
  required_providers {
    aws        = { source = "hashicorp/aws", version = "~> 5.0" }
    kubernetes = { source = "hashicorp/kubernetes", version = "~> 2.30" }
    helm       = { source = "hashicorp/helm", version = "~> 2.13" }
    # Used to pull the upstream AWS Load Balancer Controller IAM policy at
    # apply time so it can never go stale — see aws_iam_policy.alb_controller.
    http = { source = "hashicorp/http", version = "~> 3.4" }
  }
}

provider "aws" {
  region = "${spec.region}"
}

# Auth against the freshly-created EKS cluster via the aws exec plugin so
# that both kubernetes and helm providers can install add-ons in the SAME
# terraform apply. Without exec-plugin auth we'd need a stored kubeconfig,
# which doesn't exist yet on first apply — chicken-and-egg.
data "aws_eks_cluster_auth" "this" {
  name = module.eks.cluster_name
}

provider "kubernetes" {
  host                   = module.eks.cluster_endpoint
  cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
  token                  = data.aws_eks_cluster_auth.this.token
}

provider "helm" {
  kubernetes {
    host                   = module.eks.cluster_endpoint
    cluster_ca_certificate = base64decode(module.eks.cluster_certificate_authority_data)
    token                  = data.aws_eks_cluster_auth.this.token
  }
}
`;

  const useExisting = spec.createVpc === false;
  const nodeSubnetsOverride =
    spec.nodeSubnetIds && spec.nodeSubnetIds.length > 0 ? spec.nodeSubnetIds : undefined;

  // VPC source: a fresh VPC module, or wiring to an existing VPC. When reusing
  // an existing VPC we either take explicit subnet ids or auto-discover them.
  // node_subnet_ids controls where WORKER NODES land — defaults to the same
  // subnets as the control plane (subnet_ids) unless the user picked different
  // ones (only offered when reusing an existing VPC; a freshly-created VPC has
  // one subnet set, so nodes always share it there).
  const vpcSection = useExisting
    ? spec.existingSubnetIds && spec.existingSubnetIds.length > 0
      ? `# Reusing existing VPC ${spec.existingVpcId ?? ""} with the given subnets.
locals {
  vpc_id         = "${spec.existingVpcId ?? ""}"
  subnet_ids     = [${spec.existingSubnetIds.map((s) => `"${s}"`).join(", ")}]
  node_subnet_ids = ${nodeSubnetsOverride ? `[${nodeSubnetsOverride.map((s) => `"${s}"`).join(", ")}]` : "local.subnet_ids"}
}
`
      : `# Reusing existing VPC ${spec.existingVpcId ?? ""}; subnets auto-discovered.
data "aws_subnets" "cluster" {
  filter {
    name   = "vpc-id"
    values = ["${spec.existingVpcId ?? ""}"]
  }
}

locals {
  vpc_id         = "${spec.existingVpcId ?? ""}"
  subnet_ids     = data.aws_subnets.cluster.ids
  node_subnet_ids = ${nodeSubnetsOverride ? `[${nodeSubnetsOverride.map((s) => `"${s}"`).join(", ")}]` : "local.subnet_ids"}
}
`
    : `module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = "\${local.cluster_name}-vpc"
  cidr = "10.0.0.0/16"

  azs             = slice(data.aws_availability_zones.available.names, 0, 3)
  private_subnets = ["10.0.1.0/24", "10.0.2.0/24", "10.0.3.0/24"]
  public_subnets  = ["10.0.101.0/24", "10.0.102.0/24", "10.0.103.0/24"]

  enable_nat_gateway   = true
  single_nat_gateway   = true
  enable_dns_hostnames = true

  # Subnet tags Kubernetes uses to place load balancers. Without role/elb on
  # the public subnets, a Service type=LoadBalancer hangs at EXTERNAL-IP
  # <pending> because cloud-controller-manager can't find a subnet to use.
  public_subnet_tags = {
    "kubernetes.io/role/elb"                      = 1
    "kubernetes.io/cluster/\${local.cluster_name}" = "shared"
  }
  private_subnet_tags = {
    "kubernetes.io/role/internal-elb"             = 1
    "kubernetes.io/cluster/\${local.cluster_name}" = "shared"
  }

  tags = local.tags
}

locals {
  vpc_id          = module.vpc.vpc_id
  subnet_ids      = module.vpc.private_subnets
  node_subnet_ids = module.vpc.private_subnets
}
`;

  // ── Subnet tagging for an EXISTING (reused) VPC ───────────────────────
  // A freshly-created VPC gets its ELB tags from the vpc module above
  // (public_subnet_tags / private_subnet_tags). A REUSED VPC's subnets live
  // outside this state, so nothing tags them — and without the tags the
  // in-tree cloud-controller-manager literally cannot find a subnet to place
  // a Service type=LoadBalancer in, so EXTERNAL-IP hangs at <pending>
  // forever with no error. `aws_ec2_tag` manages exactly ONE tag on a
  // resource it does not own, which is precisely the right tool here: it
  // adds the k8s tags without touching any other tags the subnets already
  // carry (Name, Owner, cost-center, whatever else the team uses).
  //
  // public  (map_public_ip_on_launch = true)  → kubernetes.io/role/elb=1
  // private (map_public_ip_on_launch = false) → kubernetes.io/role/internal-elb=1
  // every subnet                              → kubernetes.io/cluster/<name>=shared
  const subnetTagSection = useExisting
    ? `
# ────────────────────────────────────────────────────────────────────────
# Tag the reused VPC's subnets so Kubernetes can place load balancers.
# Public/private is detected from each subnet's map_public_ip_on_launch —
# never assumed. Uses aws_ec2_tag (single-tag management) so existing tags
# on these subnets are left untouched.
# ────────────────────────────────────────────────────────────────────────
locals {
  # Union of control-plane + node subnets; both need the cluster tag.
  all_subnet_ids = toset(concat(local.subnet_ids, local.node_subnet_ids))
}

data "aws_subnet" "tagged" {
  for_each = local.all_subnet_ids
  id       = each.value
}

resource "aws_ec2_tag" "subnet_elb_role" {
  for_each = {
    for id, s in data.aws_subnet.tagged : id => s if s.map_public_ip_on_launch
  }
  resource_id = each.key
  key         = "kubernetes.io/role/elb"
  value       = "1"
}

resource "aws_ec2_tag" "subnet_internal_elb_role" {
  for_each = {
    for id, s in data.aws_subnet.tagged : id => s if !s.map_public_ip_on_launch
  }
  resource_id = each.key
  key         = "kubernetes.io/role/internal-elb"
  value       = "1"
}

resource "aws_ec2_tag" "subnet_cluster_shared" {
  for_each    = local.all_subnet_ids
  resource_id = each.value
  key         = "kubernetes.io/cluster/\${local.cluster_name}"
  value       = "shared"
}
`
    : "";

  const azData = useExisting
    ? ""
    : `data "aws_availability_zones" "available" {
  state = "available"
}

`;

  // Production options (defaulted so older callers still produce valid HCL).
  const env = spec.environment || "production";
  const team = spec.team || "devops";
  const costCenter = spec.costCenter || "";
  const logs = spec.controlPlaneLogs !== false;
  const encrypt = spec.secretsEncryption !== false;
  const systemDisk = spec.systemDiskSize ?? 100;
  const hasApp = spec.appNodeGroup === true;
  // Primary node group's name defaults to <cluster>-workers, matching what the
  // console shows if a user were to click "Add node group" themselves.
  const primaryGroupKey = (spec.nodeGroupName?.trim() || `${cluster}-workers`)
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .slice(0, 63);
  const primaryCapacity = spec.capacityType === "SPOT" ? "SPOT" : "ON_DEMAND";
  const appTypes = (
    spec.appInstanceTypes && spec.appInstanceTypes.length > 0
      ? spec.appInstanceTypes
      : ["m5.large", "m5.xlarge"]
  )
    .map((t) => `"${t}"`)
    .join(", ");
  const appCapacity = spec.appCapacityType || "SPOT";
  const publicCidrs = (spec.publicAccessCidrs || "0.0.0.0/0")
    .split(",")
    .map((c) => c.trim())
    .filter(Boolean)
    .map((c) => `"${c}"`)
    .join(", ");

  const tagsBlock = [
    `    ManagedBy   = "DeepAgent"`,
    `    Cluster     = local.cluster_name`,
    `    Environment = "${env}"`,
    `    Team        = "${team}"`,
    costCenter ? `    CostCenter  = "${costCenter}"` : "",
  ]
    .filter(Boolean)
    .join("\n");

  // System node group is tainted ONLY when an application group exists to take
  // general workloads (otherwise nothing could schedule).
  const systemTaint = hasApp
    ? `
      taints = {
        CriticalAddonsOnly = { key = "CriticalAddonsOnly", value = "true", effect = "NO_SCHEDULE" }
      }`
    : "";

  const appGroup = hasApp
    ? `
    application = {
      subnet_ids     = local.node_subnet_ids
      instance_types = [${appTypes}]
      capacity_type  = "${appCapacity}"
      min_size       = ${spec.appMinNodes ?? 2}
      max_size       = ${spec.appMaxNodes ?? 20}
      desired_size   = ${spec.appDesiredNodes ?? 3}
      labels = { role = "application", env = "${env}" }
    }`
    : "";

  // EKS Access Entries — additional IAM users/roles granted cluster access
  // beyond the Terraform-applying identity (enable_cluster_creator_admin_permissions
  // covers that one). Uses EKS's own cluster-access-policy ARNs, not IAM policies.
  const accessEntries = spec.accessEntries?.filter((e) => e.principalArn.trim()) ?? [];
  const accessEntriesBlock =
    accessEntries.length > 0
      ? `
  access_entries = {
${accessEntries
  .map(
    (e, i) => `    entry${i} = {
      principal_arn = "${e.principalArn.trim()}"
      policy_associations = {
        main = {
          policy_arn = "arn:aws:eks::aws:cluster-access-policy/${e.policy}"
          access_scope = {
            type = "cluster"
          }
        }
      }
    }`,
  )
  .join("\n")}
  }
`
      : "";

  const main = `locals {
  cluster_name = "${cluster}"
  region       = "${spec.region}"

  # AWS Load Balancer Controller version pair — KEEP THESE IN SYNC.
  #   alb_chart_version : the Helm chart (helm_release.aws_lb_controller)
  #   alb_policy_ref    : the controller git tag whose docs/install/iam_policy.json
  #                       we attach to the controller's IRSA role
  # Chart 1.8.x ships controller v2.8.x. Bumping one without the other risks a
  # controller that needs a permission its policy doesn't grant (that is the
  # 403 AccessDenied / DescribeListenerAttributes failure we hit in 2026-07).
  alb_chart_version = "1.8.1"
  alb_policy_ref    = "v2.8.1"

  tags = {
${tagsBlock}
  }
}

${azData}${vpcSection}${subnetTagSection}
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = local.cluster_name
  cluster_version = "${spec.kubernetesVersion}"

  # Required for the AWS Load Balancer Controller (and EBS CSI IRSA) to bind
  # IAM roles to Kubernetes service accounts via the cluster's OIDC issuer.
  enable_irsa = true

  # STANDARD support, explicitly. A cluster left on EXTENDED support keeps
  # running past its Kubernetes version's standard-support window — and AWS
  # charges roughly 6x the control-plane rate for the privilege (~$0.60/hr vs
  # ~$0.10/hr). That is a silent ~$365/month per cluster for a setting nobody
  # chose. STANDARD means the cluster must be upgraded before end-of-support,
  # which is the behaviour you want by default; opt into EXTENDED deliberately.
  cluster_upgrade_policy = {
    support_type = "STANDARD"
  }

  # API-only auth. Access is granted purely through EKS Access Entries (see
  # access_entries below), not the legacy aws-auth ConfigMap. Keeping the
  # ConfigMap path alive means two sources of truth for cluster access, and
  # editing it by hand is the classic way to lock everyone out of a cluster.
  authentication_mode = "API"

  cluster_endpoint_public_access  = ${spec.endpointPublic ? "true" : "false"}
  cluster_endpoint_private_access = true${spec.endpointPublic ? `\n  cluster_endpoint_public_access_cidrs = [${publicCidrs}]` : ""}

  # Control-plane logging → CloudWatch (api, audit, authenticator, controllerManager, scheduler).
  cluster_enabled_log_types = ${logs ? `["api", "audit", "authenticator", "controllerManager", "scheduler"]` : "[]"}
${
  encrypt
    ? `
  # Encrypt Kubernetes secrets at rest with a dedicated KMS key (module-managed).
  cluster_encryption_config = {
    resources = ["secrets"]
  }
`
    : ""
}
  cluster_addons = {
    coredns    = { most_recent = true }
    kube-proxy = { most_recent = true }
    vpc-cni    = { most_recent = true }

    # metrics-server — without it \`kubectl top\` returns "Metrics API not
    # available" and every HorizontalPodAutoscaler sits at <unknown>/80% and
    # never scales. Not installed by default by EKS, and its absence is only
    # discovered the first time someone tries to autoscale.
    metrics-server = { most_recent = true }

    # eks-pod-identity-agent — the modern successor to IRSA for granting pods
    # AWS permissions. Harmless when unused; required the moment anyone adds a
    # Pod Identity association, and the console warns about its absence.
    eks-pod-identity-agent = { most_recent = true }${
      spec.ebsCsi !== false
        ? `
    # EBS CSI driver — MUST have an IRSA-bound service account role,
    # otherwise the controller pods can't call EC2 APIs (CreateVolume,
    # CreateSnapshot, etc.) and the addon hangs at "CREATING" until
    # timeout. See module.ebs_csi_irsa below.
    aws-ebs-csi-driver = {
      most_recent              = true
      service_account_role_arn = module.ebs_csi_irsa.iam_role_arn
    }`
        : ""
    }
  }

  vpc_id     = local.vpc_id
  subnet_ids = local.subnet_ids

  enable_cluster_creator_admin_permissions = true
${accessEntriesBlock}
  eks_managed_node_groups = {
${renderNodeGroups(spec, {
  primaryGroupKey,
  primaryCapacity,
  systemDisk,
  hasApp,
  systemTaint,
  appGroup,
  env,
})}
  }

  tags = local.tags
}
${
  spec.ebsCsi !== false
    ? `
# ────────────────────────────────────────────────────────────────────────
# EBS CSI driver IRSA role — required for the aws-ebs-csi-driver addon
# to function. Without a role bound to the ebs-csi-controller-sa service
# account, the addon deploys but hangs at CREATING (controller pods can't
# call EC2). The community iam-role-for-service-accounts-eks module
# packages the exact IAM policy + trust the CSI driver needs.
# ────────────────────────────────────────────────────────────────────────
module "ebs_csi_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.0"

  role_name             = "\${local.cluster_name}-ebs-csi"
  attach_ebs_csi_policy = true

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["kube-system:ebs-csi-controller-sa"]
    }
  }

  tags = local.tags
}
`
    : ""
}
# ════════════════════════════════════════════════════════════════════════
# AWS Load Balancer Controller — Terraform-MANAGED, not a manual step.
# ════════════════════════════════════════════════════════════════════════
# WHAT IT DOES: reconciles Kubernetes Ingress objects into ALBs (Layer 7)
# and annotated Services into NLBs (Layer 4).
#
# WHY IT IS DECLARED HERE (2026-07 incident):
#   * It was previously installed by hand via \`eksctl create iamserviceaccount\`
#     + \`helm install\`. That does NOT survive a cluster rebuild, cannot be
#     reproduced by a teammate, and drifts silently. Any cluster this module
#     builds now gets the controller in the same \`terraform apply\`.
#   * Our standard exposure pattern is Service type=ClusterIP + Ingress
#     (ingressClassName=alb) — see the ADR in lib/devops/deploy-manifest.ts.
#     Without this controller, those Ingress objects have nothing to
#     reconcile them and no ALB is ever created.
#   * Private-subnet clusters have NO working alternative: the in-tree
#     cloud-controller-manager only makes Classic ELBs, which cannot attach
#     to private subnets. The Service just hangs at EXTERNAL-IP <pending>
#     with no surfaced error.
#
# Subnet discovery is tag-driven (public: kubernetes.io/role/elb=1, private:
# kubernetes.io/role/internal-elb=1). Both the new-VPC and reuse-existing-VPC
# paths in this file apply those tags.
# ────────────────────────────────────────────────────────────────────────
module "lb_controller_irsa" {
  source  = "terraform-aws-modules/iam/aws//modules/iam-role-for-service-accounts-eks"
  version = "~> 5.0"

  role_name = "\${local.cluster_name}-alb-controller"

  # NOTE: \`attach_load_balancer_controller_policy = true\` is deliberately NOT
  # used. That flag attaches a policy SNAPSHOT vendored inside the IAM module,
  # which goes stale as the controller adds permissions in new releases. It is
  # precisely how we shipped a controller role missing
  # elasticloadbalancing:DescribeListenerAttributes, so ALB provisioning failed
  # with 403 AccessDenied *after* we had already switched to Ingress/ALB.
  # We attach the upstream policy instead — see aws_iam_policy.alb_controller.

  oidc_providers = {
    main = {
      provider_arn               = module.eks.oidc_provider_arn
      namespace_service_accounts = ["kube-system:aws-load-balancer-controller"]
    }
  }

  tags = local.tags
}

# Upstream AWSLoadBalancerControllerIAMPolicy, fetched at apply time so it can
# never be stale. Pinned to the controller tag that MATCHES the Helm chart we
# install (see local.alb_chart_version / local.alb_policy_ref) so the granted
# permissions and the running controller are always version-consistent —
# tracking \`main\` instead would work too, but makes a re-apply of an old
# commit non-reproducible. Bump both locals together when upgrading.
data "http" "alb_controller_policy" {
  url = "https://raw.githubusercontent.com/kubernetes-sigs/aws-load-balancer-controller/\${local.alb_policy_ref}/docs/install/iam_policy.json"

  request_headers = {
    Accept = "application/json"
  }
}

resource "aws_iam_policy" "alb_controller" {
  name        = "\${local.cluster_name}-alb-controller"
  description = "Upstream AWSLoadBalancerControllerIAMPolicy @ \${local.alb_policy_ref} (fetched, not vendored — see comments)"
  policy      = data.http.alb_controller_policy.response_body

  tags = local.tags
}

resource "aws_iam_role_policy_attachment" "alb_controller" {
  role       = module.lb_controller_irsa.iam_role_name
  policy_arn = aws_iam_policy.alb_controller.arn
}

# The ServiceAccount must exist BEFORE the helm chart deploys — the chart
# is configured with serviceAccount.create=false so it expects one already
# annotated with the IRSA role ARN.
resource "kubernetes_service_account" "aws_lb_controller" {
  metadata {
    name      = "aws-load-balancer-controller"
    namespace = "kube-system"
    annotations = {
      "eks.amazonaws.com/role-arn" = module.lb_controller_irsa.iam_role_arn
    }
    labels = {
      "app.kubernetes.io/name"       = "aws-load-balancer-controller"
      "app.kubernetes.io/managed-by" = "terraform"
    }
  }
}

resource "helm_release" "aws_lb_controller" {
  name       = "aws-load-balancer-controller"
  namespace  = "kube-system"
  repository = "https://aws.github.io/eks-charts"
  chart      = "aws-load-balancer-controller"
  version    = local.alb_chart_version # pinned; paired with local.alb_policy_ref

  set {
    name  = "clusterName"
    value = module.eks.cluster_name
  }
  set {
    name  = "serviceAccount.create"
    value = "false"
  }
  set {
    name  = "serviceAccount.name"
    value = kubernetes_service_account.aws_lb_controller.metadata[0].name
  }
  set {
    name  = "region"
    value = local.region
  }
  set {
    name  = "vpcId"
    value = local.vpc_id
  }

  # Depend on BOTH the ServiceAccount (helm expects it to already exist,
  # serviceAccount.create=false) AND the policy attachment — a controller that
  # starts before its IAM permissions land logs 403s and needs a restart.
  depends_on = [
    kubernetes_service_account.aws_lb_controller,
    aws_iam_role_policy_attachment.alb_controller,
  ]
}
`;

  const outputs = `output "cluster_name" {
  value = module.eks.cluster_name
}

output "cluster_endpoint" {
  value = module.eks.cluster_endpoint
}

output "region" {
  value = local.region
}

output "update_kubeconfig_command" {
  value = "aws eks update-kubeconfig --name \${module.eks.cluster_name} --region ${spec.region}"
}
`;

  // Flat, relative filenames — the caller (chat form's ghPath, or a chat
  // tool's `path` input) supplies the destination folder. Embedding it here
  // too would double it up (e.g. "terraform/eks/x/terraform/eks/x/main.tf").
  return {
    "versions.tf": versions,
    "main.tf": main,
    "outputs.tf": outputs,
  };
}
