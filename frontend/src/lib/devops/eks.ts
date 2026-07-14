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
  /** System node group instance type. */
  instanceType: string;
  desiredNodes: number;
  minNodes: number;
  maxNodes: number;
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
  appNodeGroup: true,
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

function backendBlock(spec: EksSpec): string {
  if (!spec.stateBucket) {
    return `  # No S3 backend configured — state is local. Set a Terraform state\n  # bucket on the Infrastructure page for production use.`;
  }
  const lock = spec.stateTable ? `\n    dynamodb_table = "${spec.stateTable}"` : "";
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
    aws      = { source = "hashicorp/aws", version = "~> 5.0" }
  }
}

provider "aws" {
  region = "${spec.region}"
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

  public_subnet_tags  = { "kubernetes.io/role/elb" = 1 }
  private_subnet_tags = { "kubernetes.io/role/internal-elb" = 1 }

  tags = local.tags
}

locals {
  vpc_id          = module.vpc.vpc_id
  subnet_ids      = module.vpc.private_subnets
  node_subnet_ids = module.vpc.private_subnets
}
`;

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
  tags = {
${tagsBlock}
  }
}

${azData}${vpcSection}
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = local.cluster_name
  cluster_version = "${spec.kubernetesVersion}"

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
    vpc-cni    = { most_recent = true }${spec.ebsCsi !== false ? `\n    aws-ebs-csi-driver = { most_recent = true }` : ""}
  }

  vpc_id     = local.vpc_id
  subnet_ids = local.subnet_ids

  enable_cluster_creator_admin_permissions = true
${accessEntriesBlock}
  eks_managed_node_groups = {
    system = {
      subnet_ids     = local.node_subnet_ids
      instance_types = ["${spec.instanceType}"]
      capacity_type  = "ON_DEMAND"
      min_size       = ${spec.minNodes}
      max_size       = ${spec.maxNodes}
      desired_size   = ${spec.desiredNodes}
      disk_size      = ${systemDisk}
      labels = { role = "system" }${systemTaint}
    }${appGroup}
  }

  tags = local.tags
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
