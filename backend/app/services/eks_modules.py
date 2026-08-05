"""
Production-grade EKS Terraform generator.

Lays out infra the way real teams do: reusable modules (vpc, iam, eks) consumed by
per-environment stacks (dev / staging / prod). Returns a {path: content} dict for the whole
tree so it can be pushed to GitHub in one commit and applied per environment.

  terraform/
    modules/
      vpc/   {main,variables,outputs}.tf   -> dedicated cluster VPC (wraps the proven AWS module)
      iam/   {main,variables,outputs}.tf   -> explicit cluster role + node role modules
      eks/   {main,variables,outputs}.tf   -> aws_eks_cluster + managed node group
    environments/
      dev|staging|prod/  main.tf providers.tf variables.tf terraform.tfvars [backend.tf]
"""

# ── modules/vpc ──────────────────────────────────────────────────────────────
_VPC_MAIN = '''data "aws_availability_zones" "available" {
  state = "available"
}

module "vpc" {
  source  = "terraform-aws-modules/vpc/aws"
  version = "~> 5.0"

  name = var.name
  cidr = var.cidr

  azs             = slice(data.aws_availability_zones.available.names, 0, 2)
  private_subnets = var.private_subnets
  public_subnets  = var.public_subnets

  enable_nat_gateway   = true
  single_nat_gateway   = var.single_nat_gateway
  enable_dns_hostnames = true

  public_subnet_tags  = { "kubernetes.io/role/elb" = 1 }
  private_subnet_tags = { "kubernetes.io/role/internal-elb" = 1 }

  tags = var.tags
}
'''

_VPC_VARS = '''variable "name" {
  type = string
}

variable "cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "private_subnets" {
  type    = list(string)
  default = ["10.0.1.0/24", "10.0.2.0/24"]
}

variable "public_subnets" {
  type    = list(string)
  default = ["10.0.101.0/24", "10.0.102.0/24"]
}

variable "single_nat_gateway" {
  type    = bool
  default = true
}

variable "tags" {
  type    = map(string)
  default = {}
}
'''

_VPC_OUT = '''output "vpc_id" {
  value = module.vpc.vpc_id
}

output "private_subnets" {
  value = module.vpc.private_subnets
}

output "public_subnets" {
  value = module.vpc.public_subnets
}
'''

# ── modules/iam ──────────────────────────────────────────────────────────────
_IAM_MAIN = '''data "aws_iam_policy_document" "cluster_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["eks.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "cluster" {
  name               = "${var.name}-cluster-role"
  assume_role_policy = data.aws_iam_policy_document.cluster_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "cluster" {
  role       = aws_iam_role.cluster.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonEKSClusterPolicy"
}

data "aws_iam_policy_document" "node_assume" {
  statement {
    actions = ["sts:AssumeRole"]
    principals {
      type        = "Service"
      identifiers = ["ec2.amazonaws.com"]
    }
  }
}

resource "aws_iam_role" "node" {
  name               = "${var.name}-node-role"
  assume_role_policy = data.aws_iam_policy_document.node_assume.json
  tags               = var.tags
}

resource "aws_iam_role_policy_attachment" "node" {
  for_each = toset([
    "arn:aws:iam::aws:policy/AmazonEKSWorkerNodePolicy",
    "arn:aws:iam::aws:policy/AmazonEKS_CNI_Policy",
    "arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryReadOnly",
  ])
  role       = aws_iam_role.node.name
  policy_arn = each.value
}
'''

_IAM_VARS = '''variable "name" {
  type = string
}

variable "tags" {
  type    = map(string)
  default = {}
}
'''

_IAM_OUT = '''output "cluster_role_arn" {
  value = aws_iam_role.cluster.arn
}

output "node_role_arn" {
  value = aws_iam_role.node.arn
}
'''

# ── modules/eks ──────────────────────────────────────────────────────────────
_EKS_MAIN = '''resource "aws_eks_cluster" "this" {
  name     = var.name
  version  = var.k8s_version
  role_arn = var.cluster_role_arn

  vpc_config {
    subnet_ids              = var.subnet_ids
    endpoint_public_access  = var.endpoint_public_access
    endpoint_private_access = true
  }

  # API access entries + auto-admin for whoever creates the cluster (the Terraform principal),
  # so the agent's kubectl has access out of the box.
  access_config {
    authentication_mode                         = "API_AND_CONFIG_MAP"
    bootstrap_cluster_creator_admin_permissions = true
  }

  tags = var.tags
}

# Grant cluster-admin to any additional IAM principals (e.g. your console user) via access entries.
resource "aws_eks_access_entry" "admin" {
  for_each      = toset(var.admin_principal_arns)
  cluster_name  = aws_eks_cluster.this.name
  principal_arn = each.value
  type          = "STANDARD"
}

resource "aws_eks_access_policy_association" "admin" {
  for_each      = toset(var.admin_principal_arns)
  cluster_name  = aws_eks_cluster.this.name
  principal_arn = each.value
  policy_arn    = "arn:aws:iam::aws:policy/AmazonEKSClusterAdminPolicy"

  access_scope {
    type = "cluster"
  }

  depends_on = [aws_eks_access_entry.admin]
}

resource "aws_eks_node_group" "this" {
  cluster_name    = aws_eks_cluster.this.name
  node_group_name = "${var.name}-ng"
  node_role_arn   = var.node_role_arn
  subnet_ids      = var.subnet_ids
  instance_types  = [var.instance_type]

  scaling_config {
    desired_size = var.desired_size
    min_size     = var.min_size
    max_size     = var.max_size
  }

  depends_on = [aws_eks_cluster.this]
}
'''

_EKS_VARS = '''variable "name" {
  type = string
}

variable "k8s_version" {
  type = string
}

variable "cluster_role_arn" {
  type = string
}

variable "node_role_arn" {
  type = string
}

variable "subnet_ids" {
  type = list(string)
}

variable "instance_type" {
  type    = string
  default = "t3.medium"
}

variable "desired_size" {
  type    = number
  default = 2
}

variable "min_size" {
  type    = number
  default = 1
}

variable "max_size" {
  type    = number
  default = 3
}

variable "endpoint_public_access" {
  type    = bool
  default = true
}

variable "admin_principal_arns" {
  type    = list(string)
  default = []
}

variable "tags" {
  type    = map(string)
  default = {}
}
'''

_EKS_OUT = '''output "cluster_name" {
  value = aws_eks_cluster.this.name
}

output "cluster_endpoint" {
  value = aws_eks_cluster.this.endpoint
}
'''

# ── environments/<env> (identical wiring; differ only via tfvars + backend) ───
_ENV_MAIN = '''module "vpc" {
  source = "../../modules/vpc"

  name               = "${var.cluster_name}-vpc"
  cidr               = var.vpc_cidr
  single_nat_gateway = var.single_nat_gateway
  tags               = var.tags
}

module "iam" {
  source = "../../modules/iam"

  name = var.cluster_name
  tags = var.tags
}

module "eks" {
  source = "../../modules/eks"

  name             = var.cluster_name
  k8s_version      = var.k8s_version
  cluster_role_arn = module.iam.cluster_role_arn
  node_role_arn    = module.iam.node_role_arn
  subnet_ids       = module.vpc.private_subnets

  instance_type          = var.instance_type
  desired_size           = var.desired_size
  min_size               = var.min_size
  max_size               = var.max_size
  endpoint_public_access = var.endpoint_public_access
  admin_principal_arns   = var.admin_principal_arns

  tags = var.tags

  # Wait for the IAM roles AND their policy attachments before creating the cluster/nodes,
  # otherwise EKS can fail with "role doesn't have the required permissions" / NodeCreationFailure.
  depends_on = [module.iam, module.vpc]
}
'''

_ENV_OUT = '''output "cluster_name" {
  description = "Name of the EKS cluster"
  value       = module.eks.cluster_name
}

output "cluster_endpoint" {
  description = "EKS cluster API endpoint"
  value       = module.eks.cluster_endpoint
}

output "vpc_id" {
  description = "VPC the cluster runs in"
  value       = module.vpc.vpc_id
}

output "private_subnets" {
  description = "Private subnet IDs used by the node group"
  value       = module.vpc.private_subnets
}

output "cluster_role_arn" {
  description = "IAM role ARN for the EKS control plane"
  value       = module.iam.cluster_role_arn
}

output "node_role_arn" {
  description = "IAM role ARN for the worker nodes"
  value       = module.iam.node_role_arn
}

output "region" {
  description = "AWS region"
  value       = var.region
}

output "kubeconfig_command" {
  description = "Run this to configure kubectl for the cluster"
  value       = "aws eks update-kubeconfig --name ${module.eks.cluster_name} --region ${var.region}"
}
'''

_ENV_VARS = '''variable "region" {
  type = string
}

variable "cluster_name" {
  type = string
}

variable "k8s_version" {
  type = string
}

variable "vpc_cidr" {
  type    = string
  default = "10.0.0.0/16"
}

variable "single_nat_gateway" {
  type    = bool
  default = true
}

variable "instance_type" {
  type = string
}

variable "desired_size" {
  type = number
}

variable "min_size" {
  type = number
}

variable "max_size" {
  type = number
}

variable "endpoint_public_access" {
  type    = bool
  default = true
}

variable "admin_principal_arns" {
  type        = list(string)
  description = "Extra IAM user/role ARNs to grant cluster-admin (e.g. your console user)"
  default     = []
}

variable "tags" {
  type    = map(string)
  default = {}
}
'''


def _env_providers() -> str:
    return (
        'terraform {\n'
        '  required_version = ">= 1.3"\n'
        '  required_providers {\n'
        '    aws = {\n'
        '      source  = "hashicorp/aws"\n'
        '      version = "~> 5.0"\n'
        '    }\n'
        '  }\n'
        '}\n\n'
        'provider "aws" {\n'
        '  region = var.region\n'
        '}\n'
    )


def _env_backend(bucket: str, state_region: str, env: str, name: str) -> str:
    return (
        'terraform {\n'
        '  backend "s3" {\n'
        f'    bucket = "{bucket}"\n'
        f'    key    = "eks/{name}-{env}/terraform.tfstate"\n'
        f'    region = "{state_region}"\n'
        '  }\n'
        '}\n'
    )


def _env_tfvars(cluster_name: str, region: str, k8s_version: str, cfg: dict, env: str) -> str:
    return (
        f'region                 = "{region}"\n'
        f'cluster_name           = "{cluster_name}"\n'
        f'k8s_version            = "{k8s_version}"\n'
        f'instance_type          = "{cfg["instance_type"]}"\n'
        f'desired_size           = {cfg["desired"]}\n'
        f'min_size               = {cfg["min"]}\n'
        f'max_size               = {cfg["max"]}\n'
        f'single_nat_gateway     = {"true" if cfg["single_nat"] else "false"}\n'
        f'endpoint_public_access = {"true" if cfg["public"] else "false"}\n'
        '# Grant your AWS console user/role cluster-admin (run: aws sts get-caller-identity):\n'
        '# admin_principal_arns = ["arn:aws:iam::<account-id>:user/<your-user>"]\n'
        'tags = {\n'
        f'  Environment = "{env}"\n'
        '  ManagedBy   = "DevOpsAgent"\n'
        '}\n'
    )


# Sensible per-environment defaults (dev cheap → prod HA).
_ENV_DEFAULTS = {
    "dev":     {"instance_type": "t3.medium", "desired": 2, "min": 1, "max": 3, "single_nat": True,  "public": True},
    "staging": {"instance_type": "t3.large",  "desired": 2, "min": 2, "max": 4, "single_nat": True,  "public": True},
    "prod":    {"instance_type": "m5.large",  "desired": 3, "min": 3, "max": 6, "single_nat": False, "public": True},
}
ENVIRONMENTS = ["dev", "staging", "prod"]


def build_eks_module_tree(
    base_name: str,
    k8s_version: str = "1.30",
    selected_env: str = "dev",
    region: str = "us-east-1",
    instance_type: str = "",
    desired: int = 0,
    min_nodes: int = 0,
    max_nodes: int = 0,
    endpoint_public: bool = True,
    root: str = "terraform",
    state_bucket: str = "",
    state_region: str = "",
) -> dict:
    """Return {path: content} for the full module + 3-environment tree.
    The selected_env uses the user-provided sizing; the others use sane defaults."""
    files = {
        f"{root}/modules/vpc/main.tf": _VPC_MAIN,
        f"{root}/modules/vpc/variables.tf": _VPC_VARS,
        f"{root}/modules/vpc/outputs.tf": _VPC_OUT,
        f"{root}/modules/iam/main.tf": _IAM_MAIN,
        f"{root}/modules/iam/variables.tf": _IAM_VARS,
        f"{root}/modules/iam/outputs.tf": _IAM_OUT,
        f"{root}/modules/eks/main.tf": _EKS_MAIN,
        f"{root}/modules/eks/variables.tf": _EKS_VARS,
        f"{root}/modules/eks/outputs.tf": _EKS_OUT,
    }
    for env in ENVIRONMENTS:
        cfg = dict(_ENV_DEFAULTS[env])
        if env == selected_env:
            if instance_type:
                cfg["instance_type"] = instance_type
            if desired:
                cfg["desired"] = int(desired)
                cfg["min"] = int(min_nodes) if min_nodes else int(desired)
                cfg["max"] = int(max_nodes) if max_nodes else int(desired) + 2
            cfg["public"] = bool(endpoint_public)
        cluster_name = f"{base_name}-{env}"
        base = f"{root}/environments/{env}"
        files[f"{base}/main.tf"] = _ENV_MAIN
        files[f"{base}/providers.tf"] = _env_providers()
        files[f"{base}/variables.tf"] = _ENV_VARS
        files[f"{base}/outputs.tf"] = _ENV_OUT
        files[f"{base}/terraform.tfvars"] = _env_tfvars(cluster_name, region, k8s_version, cfg, env)
        if state_bucket:
            files[f"{base}/backend.tf"] = _env_backend(state_bucket, state_region or region, env, base_name)
    return files
