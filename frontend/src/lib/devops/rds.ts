/**
 * AWS RDS Postgres/MySQL Terraform generator.
 *
 * Two-instance layouts:
 *   - Standalone RDS in a chosen VPC (or the EKS cluster's VPC)
 *   - Multi-AZ for HA (optional, defaults off — costs 2×)
 *
 * The generated stack always includes:
 *   - random_password (16 chars, stored in state — see security notes)
 *   - aws_db_subnet_group across the picked private subnets
 *   - aws_security_group on RDS that allows inbound Postgres/5432 (or
 *     MySQL/3306) from the EKS worker node security group ONLY (no 0.0.0.0/0)
 *   - aws_db_instance with the picked engine + version + storage
 *   - Two outputs: `endpoint` (host:port) and `connection_string` (sensitive).
 *
 * Consumers (the agent tool) then:
 *   1. run_terraform to apply this
 *   2. read the outputs
 *   3. create a Kubernetes Secret in the app namespace with DATABASE_URL
 *   4. patch the Deployment's envFrom to reference the Secret
 *
 * SECURITY NOTES:
 *   - The password IS in Terraform state (as documented in the HCL comments).
 *     Ensure the S3 state backend has encryption + restricted access.
 *   - For long-term production use, migrate to IRSA + IAM auth (no password
 *     in state at all). We ship password-based for MVP simplicity.
 */

export type RdsEngine = "postgres" | "mysql";

export type RdsSpec = {
  /** DNS-safe name (lowercase, dashes, ≤63 chars). Also used as DB identifier. */
  name: string;
  region: string;
  engine: RdsEngine;
  /** e.g. "16", "15", "17" for postgres; "8.0" for mysql. */
  engineVersion: string;
  /** e.g. "db.t3.micro", "db.t4g.medium". */
  instanceClass: string;
  /** GB — RDS storage. Default 20. */
  allocatedStorage?: number;
  /** GB — max autoscale ceiling. Default 100. */
  maxAllocatedStorage?: number;
  /** Days of automated backups to retain. 0 disables backups; default 7. */
  backupRetentionDays?: number;
  /** Multi-AZ HA — 2× cost, sub-minute failover. Default false. */
  multiAz?: boolean;
  /** Delete the RDS without a final snapshot when destroyed. Default false. */
  skipFinalSnapshot?: boolean;
  /**
   * VPC ID to place the RDS in. When omitted, the HCL uses a data lookup for
   * the EKS cluster's VPC via `eksClusterName` — that requires the cluster to
   * already exist.
   */
  vpcId?: string;
  /** Name of the EKS cluster whose worker SG can reach the RDS. Required unless `allowSgId` is set. */
  eksClusterName?: string;
  /** Direct security-group ID to whitelist inbound from (bypasses EKS lookup). */
  allowSgId?: string;
  /** DB username. Default "app". */
  dbUsername?: string;
  /** Initial database name. Default = the sanitised RdsSpec.name. */
  initialDbName?: string;
  /** Tags applied to every resource. */
  tags?: Record<string, string>;
  /** Environment key (dev / staging / prod) — used for tagging only. */
  env?: string;
};

export const RDS_DEFAULTS = {
  allocatedStorage: 20,
  maxAllocatedStorage: 100,
  backupRetentionDays: 7,
  multiAz: false,
  skipFinalSnapshot: false,
  dbUsername: "app",
} as const;

export const RDS_INSTANCE_CLASSES = [
  "db.t4g.micro",
  "db.t4g.small",
  "db.t4g.medium",
  "db.t3.micro",
  "db.t3.small",
  "db.t3.medium",
  "db.m6g.large",
  "db.m6g.xlarge",
] as const;

export const RDS_POSTGRES_VERSIONS = ["17.2", "16.4", "16.3", "15.8", "14.13"] as const;
export const RDS_MYSQL_VERSIONS = ["8.0.39", "8.0.35"] as const;

/** Build the full HCL tree ready to hand to `run_terraform`. */
export function buildRdsTerraform(spec: RdsSpec): Record<string, string> {
  const name = sanitise(spec.name);
  const allocated = spec.allocatedStorage ?? RDS_DEFAULTS.allocatedStorage;
  const maxAllocated = spec.maxAllocatedStorage ?? RDS_DEFAULTS.maxAllocatedStorage;
  const backupDays = spec.backupRetentionDays ?? RDS_DEFAULTS.backupRetentionDays;
  const multiAz = spec.multiAz ?? RDS_DEFAULTS.multiAz;
  const skipFinal = spec.skipFinalSnapshot ?? RDS_DEFAULTS.skipFinalSnapshot;
  const dbUsername = spec.dbUsername ?? RDS_DEFAULTS.dbUsername;
  const dbName = (spec.initialDbName ?? name).replace(/-/g, "_");
  const port = spec.engine === "postgres" ? 5432 : 3306;
  const engineName = spec.engine === "postgres" ? "postgres" : "mysql";
  const tags = {
    ManagedBy: "DeepAgent",
    Database: name,
    Engine: spec.engine,
    ...(spec.env ? { Environment: spec.env } : {}),
    ...(spec.tags ?? {}),
  };

  // Where the VPC / subnets / worker SG come from — either explicit vpcId +
  // allowSgId, or looked up from the named EKS cluster.
  const eksLookupOnly = !spec.vpcId && !!spec.eksClusterName;
  if (!spec.vpcId && !spec.eksClusterName) {
    throw new Error("buildRdsTerraform: pass either `vpcId` or `eksClusterName` so the RDS knows where to live.");
  }
  if (!spec.allowSgId && !spec.eksClusterName) {
    throw new Error("buildRdsTerraform: pass either `allowSgId` or `eksClusterName` so the RDS SG knows what to allow inbound.");
  }

  const versionsTf = `terraform {
  required_version = ">= 1.4"
  required_providers {
    aws    = { source = "hashicorp/aws",    version = "~> 5.60" }
    random = { source = "hashicorp/random", version = "~> 3.6" }
  }
}

provider "aws" {
  region = "${spec.region}"
}
`;

  const lookupsTf = eksLookupOnly
    ? `# Look up the EKS cluster's VPC + private subnets + worker security group.
# Requires the cluster to already exist (built by the aks/eks flow).
data "aws_eks_cluster" "target" {
  name = "${spec.eksClusterName}"
}

locals {
  eks_vpc_id           = data.aws_eks_cluster.target.vpc_config[0].vpc_id
  eks_subnet_ids       = data.aws_eks_cluster.target.vpc_config[0].subnet_ids
  eks_cluster_sg_id    = data.aws_eks_cluster.target.vpc_config[0].cluster_security_group_id
  # Workers use the "additional" SG when the cluster was built with one; fall
  # back to the cluster SG. Both are acceptable inbound sources for RDS.
  eks_worker_sg_ids    = concat(
    tolist(data.aws_eks_cluster.target.vpc_config[0].security_group_ids),
    [data.aws_eks_cluster.target.vpc_config[0].cluster_security_group_id],
  )
}

# Pick only the PRIVATE subnets (RDS should never sit in a public subnet).
data "aws_subnets" "private" {
  filter {
    name   = "vpc-id"
    values = [local.eks_vpc_id]
  }
  tags = { "kubernetes.io/role/internal-elb" = "1" }
}
`
    : `locals {
  eks_vpc_id        = "${spec.vpcId}"
  eks_subnet_ids    = [] # explicit vpcId path: caller must provide subnets via a data lookup they control
  eks_worker_sg_ids = ["${spec.allowSgId}"]
}

data "aws_subnets" "private" {
  filter {
    name   = "vpc-id"
    values = ["${spec.vpcId}"]
  }
}
`;

  const subnetSource = eksLookupOnly ? "data.aws_subnets.private.ids" : "data.aws_subnets.private.ids";

  const mainTf = `# ${name} — ${spec.engine} ${spec.engineVersion} · ${spec.instanceClass}
# Generated by DeepAgent. Rerunning the wizard regenerates this file.
${lookupsTf}
resource "random_password" "db" {
  length           = 24
  special          = true
  # Exclude characters that require shell escaping when injected into env vars.
  override_special = "!#$%&*+-=?"
}

resource "aws_security_group" "rds" {
  name        = "${name}-rds-sg"
  # AWS SG description charset is strict — ASCII-only, no em-dash / arrow / etc.
  # (regex ^[0-9A-Za-z_ .:/()#,@\\[\\]+=&;{}!$*-]*$). Keep this line ASCII.
  description = "RDS ${spec.engine} for ${name} - inbound from EKS workers only"
  vpc_id      = local.eks_vpc_id
  tags        = ${jsonToHcl(tags)}
}

# Allow inbound Postgres/MySQL from EACH worker/cluster SG the EKS cluster uses.
# No 0.0.0.0/0 — the DB is only reachable from within the cluster's pods.
resource "aws_security_group_rule" "rds_ingress_from_eks" {
  count                    = length(local.eks_worker_sg_ids)
  type                     = "ingress"
  from_port                = ${port}
  to_port                  = ${port}
  protocol                 = "tcp"
  security_group_id        = aws_security_group.rds.id
  source_security_group_id = local.eks_worker_sg_ids[count.index]
  # AWS SG description charset is strict: ASCII only, and even the less-than
  # and greater-than characters are rejected (see aws_security_group.rds
  # above). No arrow-shaped strings like "->". Keep this line ASCII.
  description              = "EKS worker SG to RDS ${engineName} on ${port}"
}

resource "aws_security_group_rule" "rds_egress_all" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  security_group_id = aws_security_group.rds.id
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "RDS egress (DNS, package updates for maintenance)"
}

resource "aws_db_subnet_group" "rds" {
  name       = "${name}-subnets"
  subnet_ids = ${subnetSource}
  tags       = ${jsonToHcl(tags)}
}

resource "aws_db_instance" "rds" {
  identifier             = "${name}"
  engine                 = "${engineName}"
  engine_version         = "${spec.engineVersion}"
  instance_class         = "${spec.instanceClass}"
  allocated_storage      = ${allocated}
  max_allocated_storage  = ${maxAllocated}
  storage_type           = "gp3"
  storage_encrypted      = true

  db_name                = "${dbName}"
  username               = "${dbUsername}"
  # NOTE: this password lives in Terraform state. Keep the state backend
  # (S3 bucket) encrypted and least-privilege. For long-term production
  # migrate to IAM auth + IRSA (no static password).
  password               = random_password.db.result

  port                   = ${port}
  db_subnet_group_name   = aws_db_subnet_group.rds.name
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = false

  backup_retention_period = ${backupDays}
  backup_window           = "03:00-04:00"
  maintenance_window      = "sun:04:30-sun:05:30"
  auto_minor_version_upgrade = true
  copy_tags_to_snapshot   = true

  multi_az               = ${multiAz}
  deletion_protection    = ${!skipFinal}
  skip_final_snapshot    = ${skipFinal}
  ${skipFinal ? "" : `final_snapshot_identifier = "${name}-final-\${formatdate("YYYYMMDDhhmmss", timestamp())}"`}

  # Send Postgres logs to CloudWatch so the agent can query them via the
  # existing observability stack.
  enabled_cloudwatch_logs_exports = ${spec.engine === "postgres" ? '["postgresql", "upgrade"]' : '["error", "general", "slowquery"]'}

  tags = ${jsonToHcl(tags)}
}
`;

  const outputsTf = `output "endpoint" {
  value       = aws_db_instance.rds.endpoint
  description = "host:port for the RDS instance"
}

output "host" {
  value       = aws_db_instance.rds.address
  description = "Hostname only (no port)"
}

output "port" {
  value       = ${port}
  description = "Listener port"
}

output "database" {
  value       = "${dbName}"
  description = "Initial database name created on first boot"
}

output "username" {
  value       = "${dbUsername}"
  description = "Master username"
}

output "password" {
  value       = random_password.db.result
  sensitive   = true
  description = "Master password — pipe into a Kubernetes Secret; never log this."
}

output "connection_string" {
  value       = "${spec.engine === "postgres" ? "postgres" : "mysql"}://${dbUsername}:\${urlencode(random_password.db.result)}@\${aws_db_instance.rds.address}:${port}/${dbName}"
  sensitive   = true
  description = "Ready-to-use ${spec.engine === "postgres" ? "DATABASE_URL" : "MYSQL_URL"} for the app pods"
}

output "security_group_id" {
  value       = aws_security_group.rds.id
  description = "RDS SG — inbound from the EKS worker SG"
}
`;

  return {
    "main.tf": mainTf,
    "outputs.tf": outputsTf,
    "versions.tf": versionsTf,
  };
}

// ── helpers ─────────────────────────────────────────────────────────────

function sanitise(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 63);
}

/** Emit a small object as HCL — used only for the tags block. */
function jsonToHcl(obj: Record<string, string>): string {
  const rows = Object.entries(obj).map(([k, v]) => `    ${JSON.stringify(k)} = ${JSON.stringify(v)}`);
  return "{\n" + rows.join("\n") + "\n  }";
}
