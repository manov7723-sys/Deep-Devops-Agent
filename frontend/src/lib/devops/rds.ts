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

  // ── Console-parity options (2026-07) ─────────────────────────────────
  // The wizard previously exposed 8 fields; the AWS console exposes ~40.
  // These are the ones that are irreversible, cost money, or are needed for
  // production sign-off — i.e. the ones you cannot simply change later.

  /** gp3 (default, baseline 3000 IOPS), gp2 (legacy), io1/io2 (provisioned). */
  storageType?: "gp3" | "gp2" | "io1" | "io2";
  /** Provisioned IOPS. Required for io1/io2; optional gp3 uplift above 3000. */
  iops?: number;
  /** gp3 only — MiB/s above the 125 baseline. */
  storageThroughput?: number;

  /** Encrypt at rest. ON by default; CANNOT be changed after creation. */
  storageEncrypted?: boolean;
  /** Customer-managed KMS key ARN. Omit for the AWS-managed key. */
  kmsKeyId?: string;

  /** Authenticate with IAM tokens instead of (or alongside) a password. */
  iamDatabaseAuthentication?: boolean;

  /** Performance Insights — query-level telemetry. */
  performanceInsights?: boolean;
  /** 7 (free tier) or 731 days. */
  performanceInsightsRetention?: 7 | 731;
  /** Enhanced OS-level monitoring interval in seconds; 0 disables. */
  monitoringInterval?: 0 | 1 | 5 | 10 | 15 | 30 | 60;

  /** Engine logs to ship to CloudWatch, e.g. ["postgresql","upgrade"]. */
  enabledCloudwatchLogsExports?: string[];

  /** UTC backup window, "HH:MM-HH:MM". */
  backupWindow?: string;
  /** UTC maintenance window, "ddd:HH:MM-ddd:HH:MM". */
  maintenanceWindow?: string;
  /** Apply engine patch upgrades automatically during maintenance. */
  autoMinorVersionUpgrade?: boolean;

  /** Block `terraform destroy` from deleting the instance. */
  deletionProtection?: boolean;

  /**
   * Reachable from the internet. Default false and strongly discouraged —
   * present because a demo or an external BI tool occasionally needs it, and
   * a user who needs it will otherwise do it by hand in the console with a
   * wide-open security group.
   */
  publiclyAccessible?: boolean;

  /** Extra CIDR blocks allowed inbound on the DB port, beyond the cluster. */
  allowedCidrs?: string[];

  /**
   * Subnets for the DB subnet group. AWS requires at least two, in two
   * different Availability Zones.
   *
   * Omit and the generator discovers them from the VPC — convenient for the
   * agent tool, but discovery can only guess which subnets are private. The
   * wizard always passes them explicitly.
   */
  dbSubnetIds?: string[];
  /**
   * Reuse an EXISTING DB subnet group by name instead of creating one.
   * Takes precedence over `dbSubnetIds`. This is what the console offers when
   * an account already has a group covering the right subnets.
   */
  dbSubnetGroupName?: string;
};

export const RDS_DEFAULTS = {
  allocatedStorage: 20,
  maxAllocatedStorage: 100,
  backupRetentionDays: 7,
  multiAz: false,
  skipFinalSnapshot: false,
  dbUsername: "app",
  storageType: "gp3",
  storageEncrypted: true,
  iamDatabaseAuthentication: false,
  performanceInsights: false,
  performanceInsightsRetention: 7,
  monitoringInterval: 0,
  backupWindow: "03:00-04:00",
  maintenanceWindow: "sun:04:30-sun:05:30",
  autoMinorVersionUpgrade: true,
  deletionProtection: true,
  publiclyAccessible: false,
} as const;

export const RDS_STORAGE_TYPES = ["gp3", "gp2", "io1", "io2"] as const;
export const RDS_MONITORING_INTERVALS = [0, 1, 5, 10, 15, 30, 60] as const;
/** Engine log types RDS can export to CloudWatch — differs per engine. */
export const RDS_LOG_EXPORTS: Record<"postgres" | "mysql", string[]> = {
  postgres: ["postgresql", "upgrade"],
  mysql: ["audit", "error", "general", "slowquery"],
};

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
  const storageType = spec.storageType ?? RDS_DEFAULTS.storageType;
  const encrypted = spec.storageEncrypted ?? RDS_DEFAULTS.storageEncrypted;
  const iamAuth = spec.iamDatabaseAuthentication ?? RDS_DEFAULTS.iamDatabaseAuthentication;
  const pi = spec.performanceInsights ?? RDS_DEFAULTS.performanceInsights;
  const piRetention = spec.performanceInsightsRetention ?? RDS_DEFAULTS.performanceInsightsRetention;
  const monInterval = spec.monitoringInterval ?? RDS_DEFAULTS.monitoringInterval;
  const backupWindow = spec.backupWindow ?? RDS_DEFAULTS.backupWindow;
  const maintWindow = spec.maintenanceWindow ?? RDS_DEFAULTS.maintenanceWindow;
  const autoMinor = spec.autoMinorVersionUpgrade ?? RDS_DEFAULTS.autoMinorVersionUpgrade;
  const publiclyAccessible = spec.publiclyAccessible ?? RDS_DEFAULTS.publiclyAccessible;
  // deletionProtection defaults ON, but a caller asking to skip the final
  // snapshot is explicitly saying "this is disposable" — honouring both would
  // produce an instance Terraform can never destroy.
  const deletionProtection = spec.deletionProtection ?? (skipFinal ? false : RDS_DEFAULTS.deletionProtection);
  // Engine logs shipped to CloudWatch. Unspecified means "the engine's usual
  // set" rather than "none" — that has always been the behaviour here and
  // dropping it would silently stop log delivery for existing callers.
  const logExports = spec.enabledCloudwatchLogsExports?.length
    ? spec.enabledCloudwatchLogsExports
    : RDS_LOG_EXPORTS[spec.engine].filter((l) => l !== "audit"); // audit needs an extra RDS option group
  const allowedCidrs = spec.allowedCidrs ?? [];
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

  // ── Subnet group ──────────────────────────────────────────────────────
  // Three ways to land the instance, in order of preference:
  //   1. an existing DB subnet group by name  → reuse it, create nothing
  //   2. explicit subnet ids (the wizard asks) → create a group from exactly those
  //   3. neither (the agent tool's path)       → discover them, defensively
  const explicitSubnets = (spec.dbSubnetIds ?? []).map((s) => s.trim()).filter(Boolean);
  const existingGroup = spec.dbSubnetGroupName?.trim();
  const needsDiscovery = !existingGroup && explicitSubnets.length === 0;

  if (explicitSubnets.length === 1) {
    throw new Error(
      "buildRdsTerraform: a DB subnet group needs at least two subnets in two different Availability Zones — only one was given.",
    );
  }

  const vpcRef = eksLookupOnly ? "local.eks_vpc_id" : `"${spec.vpcId}"`;

  /**
   * WHY THE FALLBACK IS TWO LOOKUPS: this used to be a single
   * `data "aws_subnets"` filtered on `kubernetes.io/role/internal-elb = 1`.
   * eksctl and the EKS Terraform module write that tag onto private subnets,
   * but a hand-built cluster has no such tag — so the lookup returned an
   * EMPTY list, `aws_db_subnet_group` got `subnet_ids = []`, and the apply
   * died on "DB subnet group must contain at least two subnets in at least
   * two AZs" only AFTER the security group had been created. Prefer the
   * tagged private subnets when there are enough of them; otherwise take
   * every subnet in the VPC, which at least produces a working instance.
   */
  const discoveryTf = !needsDiscovery
    ? ""
    : eksLookupOnly
      ? `
data "aws_subnets" "tagged_private" {
  filter {
    name   = "vpc-id"
    values = [${vpcRef}]
  }
  tags = { "kubernetes.io/role/internal-elb" = "1" }
}

data "aws_subnets" "all_in_vpc" {
  filter {
    name   = "vpc-id"
    values = [${vpcRef}]
  }
}

locals {
  db_subnet_ids = length(data.aws_subnets.tagged_private.ids) >= 2 ? data.aws_subnets.tagged_private.ids : data.aws_subnets.all_in_vpc.ids
}
`
      : `
data "aws_subnets" "all_in_vpc" {
  filter {
    name   = "vpc-id"
    values = [${vpcRef}]
  }
}

locals {
  db_subnet_ids = data.aws_subnets.all_in_vpc.ids
}
`;

  // An existing group wins outright, so don't emit subnet locals nothing reads.
  const explicitSubnetsTf = explicitSubnets.length && !existingGroup
    ? `
locals {
  # Chosen in the wizard — not discovered, so what you picked is what you get.
  db_subnet_ids = ${JSON.stringify(explicitSubnets)}
}
`
    : "";

  const lookupsTf = eksLookupOnly
    ? `# Look up the EKS cluster's VPC + worker security groups.
# Requires the cluster to already exist (built by the eks/aks flow).
data "aws_eks_cluster" "target" {
  name = "${spec.eksClusterName}"
}

locals {
  eks_vpc_id        = data.aws_eks_cluster.target.vpc_config[0].vpc_id
  eks_cluster_sg_id = data.aws_eks_cluster.target.vpc_config[0].cluster_security_group_id
  # Workers use the "additional" SG when the cluster was built with one; fall
  # back to the cluster SG. Both are acceptable inbound sources for RDS.
  eks_worker_sg_ids = concat(
    tolist(data.aws_eks_cluster.target.vpc_config[0].security_group_ids),
    [data.aws_eks_cluster.target.vpc_config[0].cluster_security_group_id],
  )
}
${discoveryTf}${explicitSubnetsTf}`
    : `locals {
  eks_vpc_id        = "${spec.vpcId}"
  eks_worker_sg_ids = ["${spec.allowSgId}"]
}
${discoveryTf}${explicitSubnetsTf}`;

  // Reuse a named group, or the one this stack creates.
  const subnetGroupRef = existingGroup ? `"${existingGroup}"` : "aws_db_subnet_group.rds.name";

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

${monInterval > 0 ? `# Enhanced monitoring publishes OS metrics to CloudWatch Logs, and RDS needs
# a role it can assume to do so. Created only when the interval is non-zero so
# a default install carries no extra IAM.
resource "aws_iam_role" "rds_monitoring" {
  count = 1
  name  = "${name}-rds-monitoring"
  assume_role_policy = jsonencode({
    Version   = "2012-10-17"
    Statement = [{
      Effect    = "Allow"
      Principal = { Service = "monitoring.rds.amazonaws.com" }
      Action    = "sts:AssumeRole"
    }]
  })
  tags = ${jsonToHcl(tags)}
}

resource "aws_iam_role_policy_attachment" "rds_monitoring" {
  count      = 1
  role       = aws_iam_role.rds_monitoring[0].name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonRDSEnhancedMonitoringRole"
}

` : ""}${allowedCidrs.length ? `# Extra CIDRs the user explicitly allowed, beyond the cluster's own SGs.
# Separate from the SG rule above so revoking one never disturbs the other.
resource "aws_security_group_rule" "rds_ingress_cidrs" {
  type              = "ingress"
  from_port         = ${port}
  to_port           = ${port}
  protocol          = "tcp"
  security_group_id = aws_security_group.rds.id
  cidr_blocks       = ${JSON.stringify(allowedCidrs)}
  description       = "Explicitly allowed CIDRs on ${engineName} port ${port}"
}

` : ""}${
    existingGroup
      ? `# Using the existing DB subnet group "${existingGroup}" — nothing to create.
`
      : `resource "aws_db_subnet_group" "rds" {
  name        = "${name}-subnets"
  description = "Subnets for the ${name} ${engineName} instance"
  subnet_ids  = local.db_subnet_ids
  tags        = ${jsonToHcl(tags)}
}`
  }

resource "aws_db_instance" "rds" {
  identifier             = "${name}"
  engine                 = "${engineName}"
  engine_version         = "${spec.engineVersion}"
  instance_class         = "${spec.instanceClass}"
  allocated_storage      = ${allocated}
  max_allocated_storage  = ${maxAllocated}
  storage_type           = "${storageType}"
${spec.iops ? `  iops                   = ${spec.iops}\n` : ""}${spec.storageThroughput ? `  storage_throughput     = ${spec.storageThroughput}\n` : ""}  # Encryption cannot be toggled after creation — only restored-from-snapshot
  # into a new instance. Defaults on for that reason.
  storage_encrypted      = ${encrypted}
${spec.kmsKeyId ? `  kms_key_id             = "${spec.kmsKeyId}"\n` : ""}
  db_name                = "${dbName}"
  username               = "${dbUsername}"
  # NOTE: this password lives in Terraform state. Keep the state backend
  # (S3 bucket) encrypted and least-privilege. For long-term production
  # migrate to IAM auth + IRSA (no static password).
  password               = random_password.db.result

  port                   = ${port}
  db_subnet_group_name   = ${subnetGroupRef}
  vpc_security_group_ids = [aws_security_group.rds.id]
  publicly_accessible    = ${publiclyAccessible}

  backup_retention_period = ${backupDays}
  backup_window           = "${backupWindow}"
  maintenance_window      = "${maintWindow}"
  auto_minor_version_upgrade = ${autoMinor}
  copy_tags_to_snapshot   = true

  iam_database_authentication_enabled = ${iamAuth}
${pi ? `  performance_insights_enabled          = true\n  performance_insights_retention_period = ${piRetention}\n` : ""}${monInterval > 0 ? `  monitoring_interval    = ${monInterval}\n  monitoring_role_arn    = aws_iam_role.rds_monitoring[0].arn\n` : ""}
  # Engine logs to CloudWatch, so the agent can read them through the existing
  # observability stack. Declared ONCE — Terraform rejects a repeated argument.
  enabled_cloudwatch_logs_exports = ${JSON.stringify(logExports)}

  multi_az               = ${multiAz}
  deletion_protection    = ${deletionProtection}
  skip_final_snapshot    = ${skipFinal}
  ${skipFinal ? "" : `final_snapshot_identifier = "${name}-final-\${formatdate("YYYYMMDDhhmmss", timestamp())}"`}

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

output "db_subnet_group" {
  value       = ${subnetGroupRef}
  description = "DB subnet group the instance was placed in"
}

output "db_subnet_ids" {
  value       = ${existingGroup ? `[]` : `local.db_subnet_ids`}
  description = "Subnets backing the DB subnet group (empty when reusing an existing group)"
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
