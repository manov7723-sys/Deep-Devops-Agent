"use client";

/**
 * RDS creation wizard — a console-style paged form, same shape as the EKS /
 * AKS / GKE wizards. The shared `ClusterChat` engine renders the pages and
 * Next/Back; this file is the RDS field script plus how to turn the answers
 * into the `/rds` request body. No LLM.
 *
 * WHY THIS REPLACED THE CHAT Q&A: the agent's `generate_rds_terraform` tool
 * asks four or five questions and takes defaults for everything else. Several
 * of those defaults CANNOT be changed after the instance exists — encryption
 * and its KMS key above all — so "just recreate it with the right settings"
 * means restoring from a snapshot into a new instance. The fields below are
 * the console's, ordered the way the console orders them.
 */
import {
  ClusterChat,
  type ClusterChatConfig,
  type Step,
  type StepCtx,
} from "@/components/domain/cluster-chat-engine";

/**
 * RDS DB instance identifier rules, enforced here rather than by a failed
 * apply: 1–63 chars, letter first, letters/digits/hyphens, no trailing
 * hyphen and no doubled hyphen.
 */
const DB_ID_RE = /^[a-z](?!.*--)[a-z0-9-]{0,61}[a-z0-9]$|^[a-z]$/;
/** Postgres/MySQL identifier for the initial database. */
const DB_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,62}$/;
const USER_RE = /^[a-zA-Z][a-zA-Z0-9_]{0,62}$/;
/** RDS refuses these as master usernames on every engine. */
const RESERVED_USERS = new Set(["rdsadmin", "rdsrepladmin", "rds_superuser", "public"]);
const BACKUP_WINDOW_RE = /^([01]\d|2[0-3]):[0-5]\d-([01]\d|2[0-3]):[0-5]\d$/;
const MAINT_WINDOW_RE =
  /^(mon|tue|wed|thu|fri|sat|sun):([01]\d|2[0-3]):[0-5]\d-(mon|tue|wed|thu|fri|sat|sun):([01]\d|2[0-3]):[0-5]\d$/i;
const CIDR_RE = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

const AWS_REGIONS = [
  "us-east-1",
  "us-east-2",
  "us-west-1",
  "us-west-2",
  "eu-west-1",
  "eu-west-2",
  "eu-central-1",
  "ap-south-1",
  "ap-southeast-1",
  "ap-southeast-2",
  "ap-northeast-1",
  "ca-central-1",
  "sa-east-1",
];

const STORAGE_LABELS: Record<string, string> = {
  gp3: "gp3 — General Purpose SSD (recommended)",
  gp2: "gp2 — General Purpose SSD (legacy)",
  io1: "io1 — Provisioned IOPS SSD",
  io2: "io2 — Provisioned IOPS SSD (higher durability)",
};

const strList = (c: StepCtx, key: string, fallback: string[]): string[] => {
  const v = c.opts?.[key];
  return Array.isArray(v) && v.length ? (v as string[]) : fallback;
};

/** Engine-specific CloudWatch log types, from the `/rds` GET. */
const logExportsFor = (c: StepCtx, engine: "postgres" | "mysql"): string[] => {
  const v = c.opts?.logExports as Record<string, string[]> | undefined;
  const fallback = engine === "postgres" ? ["postgresql", "upgrade"] : ["audit", "error", "general", "slowquery"];
  return v?.[engine]?.length ? v[engine] : fallback;
};

type AwsCluster = {
  name: string;
  status?: string;
  version?: string;
  vpcId?: string;
  subnetIds?: string[];
};
type AwsClustersSource = { connected?: boolean; clusters?: AwsCluster[]; note?: string };
type AwsVpc = { vpcId: string; name: string | null; cidr: string; isDefault: boolean };
type AwsSubnet = {
  subnetId: string;
  vpcId: string;
  name: string | null;
  cidr: string;
  az: string;
  public: boolean;
};
type AwsVpcsSource = { connected?: boolean; vpcs?: AwsVpc[]; subnets?: AwsSubnet[]; note?: string };
type AwsSg = { groupId: string; groupName: string; description: string; vpcId: string };
type AwsSgsSource = { connected?: boolean; securityGroups?: AwsSg[]; note?: string };

const isProvisionedIops = (a: Record<string, unknown>) =>
  a.storageType === "io1" || a.storageType === "io2";

/**
 * Which VPC the instance will land in, whichever route the user took.
 * On the EKS path this comes from the cluster's own `resourcesVpcConfig`, so
 * the subnet picker below is always scoped to the right network.
 */
function resolvedVpcId(c: StepCtx): string {
  if (c.answers.attachTo === "vpc") return String(c.answers.vpcId ?? "");
  const src = c.sources?.awsClusters as AwsClustersSource | undefined;
  const name = String(c.answers.eksClusterName ?? "");
  return src?.clusters?.find((k) => k.name === name)?.vpcId ?? "";
}

/** Subnets in the resolved VPC, private ones first. */
function subnetsInScope(c: StepCtx): AwsSubnet[] {
  const vpcId = resolvedVpcId(c);
  const all = (c.sources?.awsVpcs as AwsVpcsSource | undefined)?.subnets ?? [];
  return all
    .filter((s) => vpcId && s.vpcId === vpcId)
    .sort((a, b) => Number(a.public) - Number(b.public) || a.az.localeCompare(b.az));
}

const STEPS: Step[] = [
  // ── Page 1 · Engine ───────────────────────────────────────────────────
  {
    page: 1,
    kind: "select",
    key: "envKey",
    label: "Environment",
    hint: "Provides the AWS credentials and the S3 state backend.",
    emptyNote: "Create an environment first, then come back.",
    options: (c) => c.envs.map((e) => ({ value: e.key, label: e.name || e.key })),
  },
  {
    page: 1,
    kind: "text",
    key: "name",
    label: "DB instance identifier",
    hint: "Unique per region. Lowercase letters, digits and hyphens; starts with a letter.",
    placeholder: "app-db",
    validate: (v) =>
      DB_ID_RE.test(v)
        ? null
        : "1–63 chars: start with a letter, then letters/digits/hyphens. No trailing or doubled hyphen.",
  },
  {
    page: 1,
    kind: "select",
    key: "region",
    label: "Region",
    hint: "Must be the same region as the cluster that will connect to it.",
    options: () => AWS_REGIONS.map((r) => ({ value: r, label: r })),
    default: () => "us-east-1",
  },
  {
    page: 1,
    kind: "choice",
    key: "engine",
    label: "Engine",
    choices: [
      { value: "postgres", label: "PostgreSQL" },
      { value: "mysql", label: "MySQL" },
    ],
  },
  // Two version fields rather than one whose options depend on the engine:
  // the wizard seeds a select's default once and never revisits it, so a
  // single field would keep "17.2" after a switch to MySQL and fail the apply.
  {
    page: 1,
    kind: "select",
    key: "pgVersion",
    label: "Engine version",
    skip: (a) => a.engine !== "postgres",
    options: (c) => strList(c, "postgresVersions", ["16.4"]).map((v) => ({ value: v, label: v })),
  },
  {
    page: 1,
    kind: "select",
    key: "myVersion",
    label: "Engine version",
    skip: (a) => a.engine !== "mysql",
    options: (c) => strList(c, "mysqlVersions", ["8.0.39"]).map((v) => ({ value: v, label: v })),
  },
  {
    page: 1,
    kind: "text",
    key: "dbUsername",
    label: "Master username",
    default: () => "app",
    validate: (v) =>
      !USER_RE.test(v)
        ? "Start with a letter; letters, digits and underscores only."
        : RESERVED_USERS.has(v.toLowerCase())
          ? `"${v}" is reserved by RDS — pick another name.`
          : null,
  },
  {
    page: 1,
    kind: "text",
    key: "initialDbName",
    label: "Initial database name",
    optional: true,
    hint: "Created on first boot. Leave blank to derive it from the identifier (hyphens become underscores).",
    placeholder: "app_db",
    validate: (v) =>
      !v || DB_NAME_RE.test(v)
        ? null
        : "Start with a letter; letters, digits and underscores only (no hyphens).",
  },

  // ── Page 2 · Instance & storage ───────────────────────────────────────
  {
    page: 2,
    kind: "select",
    key: "instanceClass",
    label: "DB instance class",
    options: (c) =>
      strList(c, "instanceClasses", ["db.t4g.micro"]).map((t) => ({ value: t, label: t })),
  },
  {
    page: 2,
    kind: "select",
    key: "storageType",
    label: "Storage type",
    options: (c) =>
      strList(c, "storageTypes", ["gp3", "gp2", "io1", "io2"]).map((t) => ({
        value: t,
        label: STORAGE_LABELS[t] ?? t,
      })),
  },
  {
    page: 2,
    kind: "number",
    key: "allocatedStorage",
    label: "Allocated storage (GB)",
    hint: "Minimum 20 GB.",
    default: () => "20",
    validate: (v) => (Number(v) >= 20 ? null : "At least 20 GB."),
  },
  {
    page: 2,
    kind: "number",
    key: "maxAllocatedStorage",
    label: "Storage autoscaling limit (GB)",
    hint: "RDS grows the volume up to this ceiling on its own. Never shrinks.",
    default: () => "100",
    validate: (v, a) =>
      Number(v) >= Number(a.allocatedStorage ?? 20)
        ? null
        : "Must be at least the allocated storage above.",
  },
  {
    page: 2,
    kind: "number",
    key: "iops",
    label: "Provisioned IOPS",
    optional: true,
    hint: "Required for io1/io2. On gp3 this is an optional uplift above the free 3,000 baseline.",
    placeholder: "3000",
    skip: (a) => a.storageType === "gp2",
    validate: (v, a) => {
      const n = Number(v);
      if (!v.trim()) {
        return isProvisionedIops(a) ? "io1 and io2 bill for provisioned IOPS — enter a value." : null;
      }
      return n >= 1000 && n <= 256000 ? null : "Between 1,000 and 256,000.";
    },
  },
  {
    page: 2,
    kind: "number",
    key: "storageThroughput",
    label: "Storage throughput (MiB/s)",
    optional: true,
    hint: "gp3 only. Leave blank for the free 125 MiB/s baseline.",
    placeholder: "125",
    skip: (a) => a.storageType !== "gp3",
    validate: (v) =>
      !v.trim() || (Number(v) >= 125 && Number(v) <= 4000) ? null : "Between 125 and 4,000.",
  },
  {
    page: 2,
    kind: "choice",
    key: "storageEncrypted",
    label: "Encryption at rest",
    hint: "CANNOT be changed after creation — turning it on later means restoring a snapshot into a new instance.",
    choices: [
      { value: true, label: "Enabled (recommended)" },
      { value: false, label: "Disabled" },
    ],
  },
  {
    page: 2,
    kind: "text",
    key: "kmsKeyId",
    label: "KMS key ARN",
    optional: true,
    mono: true,
    hint: "Leave blank to use the AWS-managed aws/rds key.",
    placeholder: "arn:aws:kms:us-east-1:123456789012:key/…",
    skip: (a) => a.storageEncrypted === false,
    validate: (v) =>
      !v || /^arn:aws:kms:[a-z0-9-]+:\d{12}:key\/.+$/.test(v)
        ? null
        : "Must be a full KMS key ARN, e.g. arn:aws:kms:us-east-1:123456789012:key/abcd-….",
  },

  // ── Page 3 · Availability & backup ────────────────────────────────────
  {
    page: 3,
    kind: "choice",
    key: "multiAz",
    label: "Availability",
    hint: "Multi-AZ keeps a synchronous standby in a second AZ and fails over in under a minute. It doubles the instance cost.",
    choices: [
      { value: false, label: "Single-AZ" },
      { value: true, label: "Multi-AZ (recommended for production)" },
    ],
  },
  {
    page: 3,
    kind: "number",
    key: "backupRetentionDays",
    label: "Backup retention (days)",
    hint: "0 disables automated backups — and with them, point-in-time recovery.",
    default: () => "7",
    validate: (v) => (Number(v) >= 0 && Number(v) <= 35 ? null : "Between 0 and 35."),
  },
  {
    page: 3,
    kind: "text",
    key: "backupWindow",
    label: "Backup window (UTC)",
    mono: true,
    default: () => "03:00-04:00",
    placeholder: "03:00-04:00",
    validate: (v) => (BACKUP_WINDOW_RE.test(v) ? null : "Format HH:MM-HH:MM in UTC, e.g. 03:00-04:00."),
  },
  {
    page: 3,
    kind: "text",
    key: "maintenanceWindow",
    label: "Maintenance window (UTC)",
    mono: true,
    hint: "Must not overlap the backup window.",
    default: () => "sun:04:30-sun:05:30",
    placeholder: "sun:04:30-sun:05:30",
    validate: (v) =>
      MAINT_WINDOW_RE.test(v) ? null : "Format ddd:HH:MM-ddd:HH:MM in UTC, e.g. sun:04:30-sun:05:30.",
  },
  {
    page: 3,
    kind: "choice",
    key: "autoMinorVersionUpgrade",
    label: "Auto minor version upgrade",
    hint: "Applies engine patch releases during the maintenance window.",
    choices: [
      { value: true, label: "Enabled (recommended)" },
      { value: false, label: "Disabled" },
    ],
  },
  {
    page: 3,
    kind: "choice",
    key: "deletionProtection",
    label: "Deletion protection",
    hint: "Blocks terraform destroy until you clear it. Leave on unless this database is disposable.",
    choices: [
      { value: true, label: "Enabled (recommended)" },
      { value: false, label: "Disabled" },
    ],
  },
  {
    page: 3,
    kind: "choice",
    key: "skipFinalSnapshot",
    label: "Final snapshot on delete",
    hint: "With deletion protection on, this only applies once you clear that flag and actually destroy.",
    choices: [
      { value: false, label: "Take a final snapshot (recommended)" },
      { value: true, label: "Skip it — delete with no recovery point" },
    ],
  },

  // ── Page 4 · Connectivity ─────────────────────────────────────────────
  {
    page: 4,
    kind: "choice",
    key: "attachTo",
    label: "Where should this database live?",
    hint: "The instance goes in the private subnets of whichever network you pick, with inbound locked to that network only.",
    choices: [
      { value: "eks", label: "Alongside an EKS cluster" },
      { value: "vpc", label: "In a VPC I choose" },
    ],
  },
  {
    page: 4,
    kind: "select",
    key: "eksClusterName",
    label: "EKS cluster",
    hint: "The database inherits this cluster's VPC and private subnets; only its worker security groups may connect.",
    emptyNote:
      "No EKS clusters found in this region. Pick another region, create a cluster first, or switch to “In a VPC I choose”.",
    skip: (a) => a.attachTo !== "eks",
    options: (c) => {
      const src = c.sources?.awsClusters as AwsClustersSource | undefined;
      return (src?.clusters ?? []).map((k) => ({
        value: k.name,
        label: k.version ? `${k.name} · v${k.version}` : k.name,
      }));
    },
  },
  {
    page: 4,
    kind: "select",
    key: "vpcId",
    label: "VPC",
    emptyNote: "No VPCs found for this environment and region.",
    skip: (a) => a.attachTo !== "vpc",
    options: (c) => {
      const src = c.sources?.awsVpcs as AwsVpcsSource | undefined;
      return (src?.vpcs ?? []).map((v) => ({
        value: v.vpcId,
        label: `${v.name ? `${v.name} · ` : ""}${v.vpcId}${v.isDefault ? " (default)" : ""} · ${v.cidr}`,
      }));
    },
  },
  {
    page: 4,
    kind: "select",
    key: "allowSgId",
    label: "Allowed security group",
    hint: "Only resources in this security group may reach the database port.",
    emptyNote: "Pick a VPC first — security groups are listed per VPC.",
    skip: (a) => a.attachTo !== "vpc",
    options: (c) => {
      const src = c.sources?.awsSgs as AwsSgsSource | undefined;
      return (src?.securityGroups ?? []).map((s) => ({
        value: s.groupId,
        label: `${s.groupName} · ${s.groupId}`,
      }));
    },
  },
  // ── Subnet group ──────────────────────────────────────────────────────
  // The console makes this an explicit choice and so do we. It used to be
  // inferred from a `kubernetes.io/role/internal-elb` tag, which a
  // hand-built cluster simply doesn't have — the lookup returned nothing and
  // the apply failed on "must contain at least two subnets in two AZs".
  {
    page: 4,
    kind: "choice",
    key: "subnetGroupMode",
    label: "DB subnet group",
    hint: "The subnets the instance may be placed in. AWS requires at least two, in two different Availability Zones.",
    choices: [
      { value: "new", label: "Create a new subnet group" },
      { value: "existing", label: "Use an existing subnet group" },
    ],
  },
  {
    page: 4,
    kind: "text",
    key: "dbSubnetGroupName",
    label: "Existing subnet group name",
    mono: true,
    hint: "Must already exist in this region and cover subnets in the network chosen above.",
    placeholder: "my-db-subnets",
    skip: (a) => a.subnetGroupMode !== "existing",
    validate: (v) =>
      /^[a-zA-Z0-9][a-zA-Z0-9 ._-]{0,254}$/.test(v)
        ? null
        : "Letters, digits, spaces, dots, underscores and hyphens; up to 255 characters.",
  },
  {
    page: 4,
    kind: "multiselect",
    key: "dbSubnetIds",
    label: "Subnets",
    hint: "Pick at least two in different AZs. Private subnets are listed first — a database in a public subnet is reachable from the internet the moment public access is on.",
    emptyNote:
      "No subnets found. Pick the cluster or VPC above first; if it's already picked, the account may not have permission to list subnets.",
    skip: (a) => a.subnetGroupMode === "existing",
    options: (c) =>
      subnetsInScope(c).map((s) => ({
        value: s.subnetId,
        label: `${s.public ? "🌐 public" : "🔒 private"} · ${s.az} · ${s.name ? `${s.name} · ` : ""}${s.subnetId} · ${s.cidr}`,
      })),
    // AWS's actual rule, checked here so it surfaces on the page rather than
    // several minutes into an apply that has already created a security group.
    validate: (chosen, _a, c) => {
      if (chosen.length < 2) return "Pick at least two subnets.";
      const byId = new Map(subnetsInScope(c).map((s) => [s.subnetId, s]));
      const azs = new Set(chosen.map((id) => byId.get(id)?.az).filter(Boolean));
      if (azs.size < 2) {
        return `All ${chosen.length} subnets are in the same Availability Zone (${[...azs][0] ?? "?"}). RDS needs two AZs.`;
      }
      return null;
    },
  },
  {
    page: 4,
    kind: "choice",
    key: "publiclyAccessible",
    label: "Public access",
    hint: "A public endpoint puts your database on the internet. Keep it private unless an external tool genuinely needs to reach it.",
    choices: [
      { value: false, label: "No — private, cluster-only (recommended)" },
      { value: true, label: "Yes — assign a public endpoint" },
    ],
  },
  {
    page: 4,
    kind: "text",
    key: "allowedCidrs",
    label: "Additional allowed CIDRs",
    optional: true,
    mono: true,
    hint: "Comma-separated, on top of the network above — e.g. your office IP. Leave blank for none.",
    placeholder: "203.0.113.4/32, 10.20.0.0/16",
    validate: (v) => {
      if (!v.trim()) return null;
      const bad = v
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((c) => !CIDR_RE.test(c));
      return bad.length ? `Not valid CIDR blocks: ${bad.join(", ")}` : null;
    },
  },

  // ── Page 5 · Monitoring & access ──────────────────────────────────────
  {
    page: 5,
    kind: "choice",
    key: "iamDatabaseAuthentication",
    label: "IAM database authentication",
    hint: "Lets pods authenticate with short-lived IAM tokens instead of the static password. The password stays available either way.",
    choices: [
      { value: false, label: "Disabled" },
      { value: true, label: "Enabled" },
    ],
  },
  {
    page: 5,
    kind: "choice",
    key: "performanceInsights",
    label: "Performance Insights",
    hint: "Per-query load telemetry. The 7-day retention tier is free.",
    choices: [
      { value: false, label: "Disabled" },
      { value: true, label: "Enabled" },
    ],
  },
  {
    page: 5,
    kind: "select",
    key: "performanceInsightsRetention",
    label: "Performance Insights retention",
    skip: (a) => a.performanceInsights !== true,
    options: () => [
      { value: "7", label: "7 days (free)" },
      { value: "731", label: "2 years (billed)" },
    ],
  },
  {
    page: 5,
    kind: "select",
    key: "monitoringInterval",
    label: "Enhanced monitoring",
    hint: "OS-level metrics at this interval. Anything above 0 creates an IAM role for RDS and bills CloudWatch.",
    options: (c) => {
      const raw = c.opts?.monitoringIntervals;
      const vals = Array.isArray(raw) && raw.length ? (raw as number[]) : [0, 1, 5, 10, 15, 30, 60];
      return vals.map((n) => ({
        value: String(n),
        label: n === 0 ? "Disabled" : `Every ${n} second${n === 1 ? "" : "s"}`,
      }));
    },
    default: () => "0",
  },
  // Split per engine for the same reason as the version fields — RDS rejects
  // a log type the engine doesn't publish.
  {
    page: 5,
    kind: "multiselect",
    key: "pgLogExports",
    label: "Export logs to CloudWatch",
    optional: true,
    hint: "Leave empty for the engine's usual set.",
    skip: (a) => a.engine !== "postgres",
    options: (c) => logExportsFor(c, "postgres").map((l) => ({ value: l, label: l })),
  },
  {
    page: 5,
    kind: "multiselect",
    key: "myLogExports",
    label: "Export logs to CloudWatch",
    optional: true,
    hint: "Leave empty for the engine's usual set. `audit` additionally requires the MariaDB audit plugin in a custom option group.",
    skip: (a) => a.engine !== "mysql",
    options: (c) => logExportsFor(c, "mysql").map((l) => ({ value: l, label: l })),
  },

  // ── Page 6 · Repository ───────────────────────────────────────────────
  {
    page: 6,
    kind: "select",
    key: "repoFullName",
    label: "GitHub repository",
    hint: "The generated Terraform is committed here.",
    emptyNote: "Attach a repo on the CI/CD & Repos tab first.",
    options: (c) => c.repos.map((r) => ({ value: r.fullName, label: r.fullName })),
  },
  {
    page: 6,
    kind: "text",
    key: "ghPath",
    label: "GitHub file path (folder)",
    placeholder: "terraform/rds/app-db",
    default: (c) => `terraform/rds/${String(c.answers.name ?? "").trim() || "app-db"}`,
  },
];

const csv = (v: unknown): string[] =>
  String(v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const RDS_CONFIG: ClusterChatConfig = {
  cloud: "aws",
  cloudLabel: "AWS",
  resourceNoun: "database",
  title: "Create RDS database",
  blueprintSub:
    "RDS blueprint (subnet group + security group + instance). No LLM — runs init → plan → apply.",
  optionsPath: "rds",
  stackPrefix: "rds",
  ghPathPrefix: "terraform/rds",
  branchPrefix: "rds",
  applyEta: "~10–15 min",
  pageTitles: [
    "Engine",
    "Instance & storage",
    "Availability & backup",
    "Connectivity",
    "Monitoring & access",
    "Repository",
  ],
  extraQueries: [
    {
      key: "awsClusters",
      path: "aws/clusters",
      params: (a) => (a.region ? { region: String(a.region) } : null),
      enabled: (a) => !!a.region,
    },
    {
      key: "awsVpcs",
      path: "aws/vpcs",
      params: (a) => (a.envKey ? { env: String(a.envKey), region: String(a.region ?? "") } : null),
      enabled: (a) => !!a.envKey,
    },
    {
      key: "awsSgs",
      path: "aws/security-groups",
      params: (a) =>
        a.vpcId && a.region ? { region: String(a.region), vpcId: String(a.vpcId) } : null,
      enabled: (a) => a.attachTo === "vpc" && !!a.vpcId,
    },
  ],
  steps: STEPS,
  buildBody: (a) => {
    const engine = a.engine === "mysql" ? "mysql" : "postgres";
    const toEks = a.attachTo !== "vpc";
    const num = (v: unknown) => {
      const n = Number(v);
      return Number.isFinite(n) && String(v ?? "").trim() !== "" ? n : undefined;
    };
    return {
      envKey: a.envKey,
      name: String(a.name).trim(),
      region: String(a.region).trim(),
      engine,
      // `?? ""` rather than a bare String(): an unseeded select would stringify
      // to the literal "undefined" and sail through the server's min(1) check,
      // producing HCL with engine_version = "undefined".
      engineVersion: String((engine === "mysql" ? a.myVersion : a.pgVersion) ?? ""),
      instanceClass: String(a.instanceClass ?? ""),

      allocatedStorage: num(a.allocatedStorage) ?? 20,
      maxAllocatedStorage: num(a.maxAllocatedStorage) ?? 100,
      storageType: String(a.storageType ?? "gp3"),
      // gp2 has no tunable IOPS/throughput at all; sending them would be
      // rejected by AWS partway through the apply.
      iops: a.storageType === "gp2" ? undefined : num(a.iops),
      storageThroughput: a.storageType === "gp3" ? num(a.storageThroughput) : undefined,

      storageEncrypted: a.storageEncrypted !== false,
      kmsKeyId: a.storageEncrypted !== false ? String(a.kmsKeyId ?? "").trim() || undefined : undefined,
      iamDatabaseAuthentication: a.iamDatabaseAuthentication === true,

      multiAz: a.multiAz === true,
      backupRetentionDays: num(a.backupRetentionDays) ?? 7,
      backupWindow: String(a.backupWindow ?? "").trim() || undefined,
      maintenanceWindow: String(a.maintenanceWindow ?? "").trim() || undefined,
      autoMinorVersionUpgrade: a.autoMinorVersionUpgrade !== false,
      deletionProtection: a.deletionProtection !== false,
      skipFinalSnapshot: a.skipFinalSnapshot === true,

      performanceInsights: a.performanceInsights === true,
      performanceInsightsRetention: a.performanceInsightsRetention === "731" ? 731 : 7,
      monitoringInterval: num(a.monitoringInterval) ?? 0,
      enabledCloudwatchLogsExports: csv(engine === "mysql" ? a.myLogExports : a.pgLogExports),

      eksClusterName: toEks ? String(a.eksClusterName ?? "").trim() || undefined : undefined,
      vpcId: toEks ? undefined : String(a.vpcId ?? "").trim() || undefined,
      allowSgId: toEks ? undefined : String(a.allowSgId ?? "").trim() || undefined,
      // Exactly one of these reaches the generator — an existing group makes
      // the subnet list meaningless, and vice versa.
      dbSubnetGroupName:
        a.subnetGroupMode === "existing"
          ? String(a.dbSubnetGroupName ?? "").trim() || undefined
          : undefined,
      dbSubnetIds: a.subnetGroupMode === "existing" ? [] : csv(a.dbSubnetIds),
      publiclyAccessible: a.publiclyAccessible === true,
      allowedCidrs: csv(a.allowedCidrs),

      dbUsername: String(a.dbUsername ?? "app").trim() || "app",
      initialDbName: String(a.initialDbName ?? "").trim() || undefined,
    };
  },
};

export function RdsChatBox({ slug }: { slug: string }) {
  return <ClusterChat slug={slug} config={RDS_CONFIG} />;
}
