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
  /** Explicit subnet ids for the cluster (when createVpc is false). Auto-discovered if omitted. */
  existingSubnetIds?: string[];
  /** Optional S3 remote-state backend. */
  stateBucket?: string;
  stateRegion?: string;
  stateTable?: string;
};

export type EksDefaults = Omit<EksSpec, "name">;

export const EKS_DEFAULTS: EksDefaults = {
  region: "us-east-1",
  kubernetesVersion: "1.30",
  instanceType: "t3.medium",
  desiredNodes: 2,
  minNodes: 1,
  maxNodes: 3,
  endpointPublic: true,
};

export const EKS_INSTANCE_TYPES = ["t3.small", "t3.medium", "t3.large", "m5.large", "m5.xlarge"];
export const EKS_K8S_VERSIONS = ["1.31", "1.30", "1.29", "1.28"];

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

  // VPC source: a fresh VPC module, or wiring to an existing VPC. When reusing
  // an existing VPC we either take explicit subnet ids or auto-discover them.
  const vpcSection = useExisting
    ? (spec.existingSubnetIds && spec.existingSubnetIds.length > 0
        ? `# Reusing existing VPC ${spec.existingVpcId ?? ""} with the given subnets.
locals {
  vpc_id     = "${spec.existingVpcId ?? ""}"
  subnet_ids = [${spec.existingSubnetIds.map((s) => `"${s}"`).join(", ")}]
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
  vpc_id     = "${spec.existingVpcId ?? ""}"
  subnet_ids = data.aws_subnets.cluster.ids
}
`)
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
  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets
}
`;

  const azData = useExisting
    ? ""
    : `data "aws_availability_zones" "available" {
  state = "available"
}

`;

  const main = `locals {
  cluster_name = "${cluster}"
  region       = "${spec.region}"
  tags = {
    ManagedBy = "DeepAgent"
    Cluster   = local.cluster_name
  }
}

${azData}${vpcSection}
module "eks" {
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = local.cluster_name
  cluster_version = "${spec.kubernetesVersion}"

  cluster_endpoint_public_access  = ${spec.endpointPublic ? "true" : "false"}
  cluster_endpoint_private_access = true

  vpc_id     = local.vpc_id
  subnet_ids = local.subnet_ids

  enable_cluster_creator_admin_permissions = true

  eks_managed_node_groups = {
    default = {
      instance_types = ["${spec.instanceType}"]
      min_size       = ${spec.minNodes}
      max_size       = ${spec.maxNodes}
      desired_size   = ${spec.desiredNodes}
    }
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

  return {
    [`terraform/eks/${cluster}/versions.tf`]: versions,
    [`terraform/eks/${cluster}/main.tf`]: main,
    [`terraform/eks/${cluster}/outputs.tf`]: outputs,
  };
}
