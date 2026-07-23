"use client";

/**
 * EKS creation wizard — a console-style paged form. The shared `ClusterChat`
 * engine renders the pages + Next/Back; this file is just the EKS field script
 * and how to turn the answers into the `/eks` request body. No LLM.
 */
import {
  ClusterChat,
  parseListRows,
  type ClusterChatConfig,
  type Step,
  type StepCtx,
} from "@/components/domain/cluster-chat-engine";

const NAME_RE = /^[a-z][a-z0-9-]{1,38}$/;
const ARN_RE = /^arn:aws:iam::\d{12}:(user|role)\/.+$/;
const ACCESS_POLICIES = [
  { value: "AmazonEKSClusterAdminPolicy", label: "Cluster admin (full control)" },
  { value: "AmazonEKSAdminPolicy", label: "Admin (most actions, no RBAC changes)" },
  { value: "AmazonEKSEditPolicy", label: "Edit (read/write resources)" },
  { value: "AmazonEKSViewPolicy", label: "View (read-only)" },
];
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

const strList = (c: StepCtx, key: string, fallback: string[]): string[] => {
  const v = c.opts?.[key];
  return Array.isArray(v) && v.length ? (v as string[]) : fallback;
};

type AwsVpc = { vpcId: string; name: string | null; cidr: string; isDefault: boolean };
type AwsSubnet = { subnetId: string; vpcId: string; name: string | null; cidr: string; az: string };
type AwsVpcsSource = { connected?: boolean; vpcs?: AwsVpc[]; subnets?: AwsSubnet[]; note?: string };
type AwsConnectedRoleSource = {
  connected?: boolean;
  roleArn?: string | null;
  providerName?: string | null;
};

const STEPS: Step[] = [
  // ── Page 1 · Networking ───────────────────────────────────────────────
  {
    page: 1,
    kind: "select",
    key: "envKey",
    label: "Environment",
    hint: "Provides the AWS credentials and S3 state backend.",
    emptyNote: "Create an environment first, then come back.",
    options: (c) => c.envs.map((e) => ({ value: e.key, label: e.name || e.key })),
  },
  {
    page: 1,
    kind: "text",
    key: "name",
    label: "Cluster name",
    hint: "Lowercase letters, digits, hyphens; start with a letter.",
    placeholder: "my-cluster",
    validate: (v) =>
      NAME_RE.test(v) ? null : "Lowercase letters, digits and hyphens; start with a letter.",
  },
  {
    page: 1,
    kind: "select",
    key: "region",
    label: "Region",
    options: () => AWS_REGIONS.map((r) => ({ value: r, label: r })),
    default: () => "us-east-1",
  },
  {
    page: 1,
    kind: "choice",
    key: "createVpc",
    label: "Networking",
    choices: [
      { value: true, label: "Create a new VPC" },
      { value: false, label: "Reuse an existing VPC" },
    ],
  },
  {
    page: 1,
    kind: "select",
    key: "existingVpcId",
    label: "Existing VPC",
    hint: "VPCs in the selected environment's account & region.",
    emptyNote:
      "No VPCs found for this env/region (or AWS isn't reachable). Switch back to “Create a new VPC”, or check the env's credentials.",
    skip: (a) => a.createVpc !== false,
    options: (c) => {
      const src = c.sources?.awsVpcs as AwsVpcsSource | undefined;
      return (src?.vpcs ?? []).map((v) => ({
        value: v.vpcId,
        label: `${v.name ? `${v.name} · ` : ""}${v.vpcId}${v.isDefault ? " (default)" : ""} · ${v.cidr}`,
      }));
    },
  },
  {
    page: 1,
    kind: "multiselect",
    key: "existingSubnetIds",
    label: "Cluster subnets",
    optional: true,
    hint: "Where the control plane's ENIs live. Pick ≥2 across different AZs. Leave empty to auto-discover the VPC's subnets.",
    emptyNote: "No subnets found for the selected VPC.",
    skip: (a) => a.createVpc !== false,
    options: (c) => {
      const src = c.sources?.awsVpcs as AwsVpcsSource | undefined;
      const vpcId = String(c.answers.existingVpcId ?? "");
      return (src?.subnets ?? [])
        .filter((s) => !vpcId || s.vpcId === vpcId)
        .map((s) => ({
          value: s.subnetId,
          label: `${s.name ? `${s.name} · ` : ""}${s.subnetId} · ${s.az} · ${s.cidr}`,
        }));
    },
  },
  {
    page: 1,
    kind: "multiselect",
    key: "nodeSubnetIds",
    label: "Node subnets",
    optional: true,
    hint: "Where worker nodes (EC2 instances) get placed. Leave empty to use the same subnets as the cluster above.",
    emptyNote: "No subnets found for the selected VPC.",
    skip: (a) => a.createVpc !== false,
    options: (c) => {
      const src = c.sources?.awsVpcs as AwsVpcsSource | undefined;
      const vpcId = String(c.answers.existingVpcId ?? "");
      return (src?.subnets ?? [])
        .filter((s) => !vpcId || s.vpcId === vpcId)
        .map((s) => ({
          value: s.subnetId,
          label: `${s.name ? `${s.name} · ` : ""}${s.subnetId} · ${s.az} · ${s.cidr}`,
        }));
    },
  },
  // ── Page 2 · Cluster basics ───────────────────────────────────────────
  {
    page: 2,
    kind: "select",
    key: "kubernetesVersion",
    label: "Kubernetes version",
    options: (c) => strList(c, "kubernetesVersions", ["1.30"]).map((v) => ({ value: v, label: v })),
  },
  {
    page: 2,
    kind: "select",
    key: "instanceType",
    label: "Node instance type",
    options: (c) => strList(c, "instanceTypes", ["t3.medium"]).map((t) => ({ value: t, label: t })),
  },
  {
    page: 2,
    kind: "number",
    key: "desiredNodes",
    label: "Desired nodes",
    default: () => "2",
    validate: (v) => (Number(v) >= 1 ? null : "At least 1 node."),
  },
  {
    page: 2,
    kind: "number",
    key: "minNodes",
    label: "Min nodes",
    default: () => "1",
    validate: (v, a) =>
      Number(v) >= 1 && Number(v) <= Number(a.desiredNodes)
        ? null
        : "Min must be ≥ 1 and ≤ desired.",
  },
  {
    page: 2,
    kind: "number",
    key: "maxNodes",
    label: "Max nodes",
    default: () => "3",
    validate: (v, a) => (Number(v) >= Number(a.desiredNodes) ? null : "Max must be ≥ desired."),
  },
  {
    page: 2,
    kind: "choice",
    key: "endpointPublic",
    label: "API endpoint",
    hint: "Whether the Kubernetes API server is reachable from the internet.",
    choices: [
      { value: true, label: "Public endpoint" },
      { value: false, label: "Private only" },
    ],
  },
  {
    page: 2,
    kind: "text",
    key: "publicAccessCidrs",
    label: "Public access CIDRs",
    mono: true,
    hint: "Restrict the public endpoint to these CIDRs (comma-separated). 0.0.0.0/0 = open to all (not recommended for prod).",
    placeholder: "1.2.3.4/32, 10.0.0.0/8",
    default: () => "0.0.0.0/0",
    skip: (a) => a.endpointPublic === false,
  },
  // ── Page 3 · Security & tags ─────────────────────────────────────────
  {
    page: 3,
    kind: "text",
    key: "environment",
    label: "Environment tag",
    placeholder: "production",
    default: () => "production",
  },
  {
    page: 3,
    kind: "text",
    key: "team",
    label: "Team tag",
    placeholder: "devops",
    default: () => "devops",
  },
  {
    page: 3,
    kind: "text",
    key: "costCenter",
    label: "Cost center tag",
    optional: true,
    placeholder: "CC-1234",
  },
  {
    page: 3,
    kind: "choice",
    key: "controlPlaneLogs",
    label: "Control-plane logging",
    hint: "Sends all 5 control-plane log types (api, audit, authenticator, controllerManager, scheduler) to CloudWatch.",
    choices: [
      { value: true, label: "Enabled (recommended)" },
      { value: false, label: "Disabled" },
    ],
  },
  {
    page: 3,
    kind: "choice",
    key: "secretsEncryption",
    label: "Secrets encryption (KMS)",
    hint: "Encrypts Kubernetes secrets at rest with a dedicated KMS key.",
    choices: [
      { value: true, label: "Enabled (recommended)" },
      { value: false, label: "Disabled" },
    ],
  },
  {
    page: 3,
    kind: "choice",
    key: "ebsCsi",
    label: "EBS CSI driver add-on",
    hint: "Enables dynamic persistent volumes (EBS).",
    choices: [
      { value: true, label: "Enabled" },
      { value: false, label: "Disabled" },
    ],
  },
  // ── Page 4 · Node groups ─────────────────────────────────────────────
  {
    page: 4,
    kind: "select",
    key: "systemDiskSize",
    label: "System node disk (GB)",
    options: (c) =>
      (strList(c, "diskSizes", ["50", "100", "150", "200"]) as unknown[]).map((d) => ({
        value: String(d),
        label: `${d} GB`,
      })),
    default: () => "100",
  },
  {
    page: 4,
    kind: "choice",
    key: "appNodeGroup",
    label: "Application node group",
    hint: "Add a second autoscaling node group for app workloads (system group gets tainted for critical add-ons).",
    choices: [
      { value: true, label: "Add app node group" },
      { value: false, label: "System group only" },
    ],
  },
  {
    page: 4,
    kind: "multiselect",
    key: "appInstanceTypes",
    label: "App node instance types",
    hint: "Pick one or more (mixed instances improve Spot availability).",
    skip: (a) => a.appNodeGroup !== true,
    options: (c) => strList(c, "instanceTypes", ["m5.large"]).map((t) => ({ value: t, label: t })),
  },
  {
    page: 4,
    kind: "choice",
    key: "appCapacityType",
    label: "App capacity type",
    skip: (a) => a.appNodeGroup !== true,
    choices: [
      { value: "SPOT", label: "Spot (cost-saving)" },
      { value: "ON_DEMAND", label: "On-Demand" },
    ],
  },
  {
    page: 4,
    kind: "number",
    key: "appMinNodes",
    label: "App min nodes",
    default: () => "2",
    skip: (a) => a.appNodeGroup !== true,
  },
  {
    page: 4,
    kind: "number",
    key: "appMaxNodes",
    label: "App max nodes",
    default: () => "20",
    skip: (a) => a.appNodeGroup !== true,
    validate: (v, a) => (Number(v) >= Number(a.appMinNodes ?? 1) ? null : "Max must be ≥ min."),
  },
  {
    page: 4,
    kind: "number",
    key: "appDesiredNodes",
    label: "App desired nodes",
    default: () => "3",
    skip: (a) => a.appNodeGroup !== true,
  },
  // ── Page 5 · Access ───────────────────────────────────────────────────
  {
    page: 5,
    kind: "info",
    key: "connectedRoleInfo",
    label: "Already has access",
    text: (c) => {
      const src = c.sources?.connectedRole as AwsConnectedRoleSource | undefined;
      if (!src?.connected)
        return "Deep Agent's connected AWS account will get cluster-admin automatically once the cluster is created — no action needed.";
      const who = src.roleArn
        ? src.roleArn
        : src.providerName
          ? `${src.providerName} (stored keys)`
          : "your connected AWS account";
      return `Deep Agent already gets cluster-admin automatically via ${who} — no need to add it below.`;
    },
  },
  {
    page: 5,
    kind: "list",
    key: "accessEntries",
    label: "Additional users/roles",
    optional: true,
    hint: "Grant other IAM users or roles direct cluster access — e.g. your own AWS user, a teammate, or a CI role.",
    addLabel: "+ Add user",
    max: 10,
    fields: [
      {
        key: "principalArn",
        label: "IAM user/role ARN",
        kind: "text",
        mono: true,
        placeholder: "arn:aws:iam::123456789012:role/devops",
        validate: (v) =>
          !v || ARN_RE.test(v)
            ? null
            : "Must be an IAM user/role ARN, e.g. arn:aws:iam::123456789012:role/devops.",
      },
      {
        key: "policy",
        label: "Access level",
        kind: "select",
        options: () => ACCESS_POLICIES,
        default: () => "AmazonEKSClusterAdminPolicy",
      },
    ],
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
    placeholder: "terraform/eks/my-cluster",
    default: (c) => `terraform/eks/${String(c.answers.name ?? "").trim() || "my-cluster"}`,
  },
];

const EKS_CONFIG: ClusterChatConfig = {
  cloud: "aws",
  cloudLabel: "AWS",
  title: "Create EKS cluster",
  blueprintSub: "EKS blueprint (VPC + managed node group). No LLM — runs init → plan → apply.",
  optionsPath: "eks",
  stackPrefix: "eks",
  ghPathPrefix: "terraform/eks",
  branchPrefix: "eks",
  applyEta: "~15–20 min",
  pageTitles: [
    "Networking",
    "Cluster basics",
    "Security & tags",
    "Node groups",
    "Access",
    "Repository",
  ],
  // Live VPC + subnet inventory for the chosen env/region (for "reuse existing VPC").
  extraQueries: [
    {
      key: "awsVpcs",
      path: "aws/vpcs",
      params: (a) => (a.envKey ? { env: String(a.envKey), region: String(a.region ?? "") } : null),
      enabled: (a) => !!a.envKey,
    },
    {
      key: "connectedRole",
      path: "aws/connected-role",
      params: (a) => (a.envKey ? { env: String(a.envKey) } : null),
      enabled: (a) => !!a.envKey,
    },
  ],
  steps: STEPS,
  buildBody: (a) => ({
    name: String(a.name).trim(),
    region: String(a.region).trim(),
    kubernetesVersion: a.kubernetesVersion,
    instanceType: a.instanceType,
    desiredNodes: Number(a.desiredNodes),
    minNodes: Number(a.minNodes),
    maxNodes: Number(a.maxNodes),
    endpointPublic: a.endpointPublic !== false,
    envKey: a.envKey,
    createVpc: a.createVpc !== false,
    existingVpcId: a.createVpc === false ? String(a.existingVpcId ?? "").trim() : undefined,
    existingSubnetIds:
      a.createVpc === false && String(a.existingSubnetIds ?? "").trim()
        ? String(a.existingSubnetIds)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
    nodeSubnetIds:
      a.createVpc === false && String(a.nodeSubnetIds ?? "").trim()
        ? String(a.nodeSubnetIds)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
    // Production options.
    environment: String(a.environment ?? "production").trim() || "production",
    team: String(a.team ?? "devops").trim() || "devops",
    costCenter: String(a.costCenter ?? "").trim() || undefined,
    publicAccessCidrs:
      a.endpointPublic !== false ? String(a.publicAccessCidrs ?? "0.0.0.0/0").trim() : undefined,
    controlPlaneLogs: a.controlPlaneLogs !== false,
    secretsEncryption: a.secretsEncryption !== false,
    systemDiskSize: Number(a.systemDiskSize ?? 100),
    ebsCsi: a.ebsCsi !== false,
    appNodeGroup: a.appNodeGroup === true,
    appInstanceTypes:
      a.appNodeGroup === true && String(a.appInstanceTypes ?? "").trim()
        ? String(a.appInstanceTypes)
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean)
        : undefined,
    appCapacityType:
      a.appNodeGroup === true
        ? a.appCapacityType === "ON_DEMAND"
          ? "ON_DEMAND"
          : "SPOT"
        : undefined,
    appMinNodes: a.appNodeGroup === true ? Number(a.appMinNodes ?? 2) : undefined,
    appMaxNodes: a.appNodeGroup === true ? Number(a.appMaxNodes ?? 20) : undefined,
    appDesiredNodes: a.appNodeGroup === true ? Number(a.appDesiredNodes ?? 3) : undefined,
    accessEntries: (() => {
      const entries = parseListRows(a.accessEntries)
        .map((r) => ({
          principalArn: String(r.principalArn ?? "").trim(),
          policy: String(r.policy ?? "AmazonEKSClusterAdminPolicy"),
        }))
        .filter((e) => e.principalArn);
      return entries.length > 0 ? entries : undefined;
    })(),
  }),
};

export function EksChatBox({ slug }: { slug: string }) {
  return <ClusterChat slug={slug} config={EKS_CONFIG} />;
}
