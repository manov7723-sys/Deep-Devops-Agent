"""
Deterministic EKS Terraform generator. Uses the official terraform-aws-modules/eks + vpc
modules so the agent never hand-writes the ~200 lines of cluster/node-group/IAM/VPC HCL
(robust + concise, and cheap on the free-tier LLM).
"""


def build_eks_terraform(
    name: str,
    region: str = "us-east-1",
    k8s_version: str = "1.30",
    instance_type: str = "t3.medium",
    desired_nodes: int = 2,
    min_nodes: int = 1,
    max_nodes: int = 3,
    public_access: bool = True,
) -> str:
    """Return a complete main.tf that provisions a VPC + an EKS cluster with one managed
    node group. Apply takes ~15 minutes (run it in the background)."""
    desired = int(desired_nodes)
    min_n = min(int(min_nodes), desired)
    max_n = max(int(max_nodes), desired)
    pub = "true" if public_access else "false"
    return f"""terraform {{
  required_providers {{
    aws = {{
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }}
  }}
}}

provider "aws" {{
  region = "{region}"
}}

data "aws_availability_zones" "available" {{
  state = "available"
}}

module "vpc" {{
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = "{name}-vpc"
  cidr = "10.0.0.0/16"

  azs             = slice(data.aws_availability_zones.available.names, 0, 2)
  private_subnets = ["10.0.1.0/24", "10.0.2.0/24"]
  public_subnets  = ["10.0.101.0/24", "10.0.102.0/24"]

  enable_nat_gateway   = true
  single_nat_gateway   = true
  enable_dns_hostnames = true

  public_subnet_tags  = {{ "kubernetes.io/role/elb" = 1 }}
  private_subnet_tags = {{ "kubernetes.io/role/internal-elb" = 1 }}
}}

module "eks" {{
  source  = "terraform-aws-modules/eks/aws"
  version = "~> 20.0"

  cluster_name    = "{name}"
  cluster_version = "{k8s_version}"

  cluster_endpoint_public_access           = {pub}
  enable_cluster_creator_admin_permissions = true

  vpc_id     = module.vpc.vpc_id
  subnet_ids = module.vpc.private_subnets

  eks_managed_node_groups = {{
    default = {{
      instance_types = ["{instance_type}"]
      min_size       = {min_n}
      max_size       = {max_n}
      desired_size   = {desired}
    }}
  }}
}}

output "cluster_name" {{
  value = module.eks.cluster_name
}}

output "cluster_endpoint" {{
  value = module.eks.cluster_endpoint
}}

output "cluster_region" {{
  value = "{region}"
}}
"""
