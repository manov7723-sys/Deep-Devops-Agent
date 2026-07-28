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
  // ── Page 4 · Node groups — AWS-console-style. One row per node group,
  //   with "+ Add another node group" to create additional pools. Users can
  //   create a single group (the common case) or split into system+app+gpu+…
  //   without leaving the wizard. Each row maps 1:1 to an
  //   `eks_managed_node_groups` entry in the generated Terraform.
  //   ────────────────────────────────────────────────────────────────────
  {
    page: 4,
    kind: "list",
    key: "nodeGroups",
    label: "Node groups",
    hint: "Every row becomes a managed node group in EKS. Start with one; click Add for more (e.g. a Spot pool for batch jobs).",
    addLabel: "+ Add another node group",
    max: 6,
    required: true,
    // One pre-populated row so the wizard has a working default out of the box.
    default: (c) =>
      JSON.stringify([
        {
          name: `${String(c.answers.name ?? "cluster")}-workers`,
          instanceType: strList(c, "instanceTypes", ["t3.medium"])[0] ?? "t3.medium",
          capacityType: "ON_DEMAND",
          minNodes: "1",
          desiredNodes: "2",
          maxNodes: "3",
          diskSize: "100",
        },
      ]),
    fields: [
      {
        key: "name",
        label: "Name",
        kind: "text",
        placeholder: "workers",
        validate: (v) =>
          /^[a-z][a-z0-9-]{0,62}$/.test(v)
            ? null
            : "Lowercase letters, digits and hyphens; start with a letter.",
      },
      {
        key: "instanceType",
        label: "Instance type",
        kind: "select",
        options: (c) =>
          strList(c, "instanceTypes", ["t3.medium"]).map((t) => ({ value: t, label: t })),
      },
      {
        key: "capacityType",
        label: "Capacity",
        kind: "select",
        options: () => [
          { value: "ON_DEMAND", label: "On-Demand" },
          { value: "SPOT", label: "Spot" },
        ],
      },
      {
        key: "minNodes",
        label: "Min",
        kind: "number",
        placeholder: "1",
        validate: (v) => (Number(v) >= 1 ? null : "≥ 1"),
      },
      {
        key: "desiredNodes",
        label: "Desired",
        kind: "number",
        placeholder: "2",
        validate: (v) => (Number(v) >= 1 ? null : "≥ 1"),
      },
      {
        key: "maxNodes",
        label: "Max",
        kind: "number",
        placeholder: "3",
        validate: (v) => (Number(v) >= 1 ? null : "≥ 1"),
      },
      {
        key: "diskSize",
        label: "Disk (GB)",
        kind: "select",
        options: (c) =>
          (strList(c, "diskSizes", ["50", "100", "150", "200"]) as unknown[]).map((d) => ({
            value: String(d),
            label: `${d} GB`,
          })),
      },
    ],
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
        return "Deep Agent's connected AWS account will get cluster-admin automatically once the cluster is created. If your connected credentials are an IAM USER (not a role), that user will ALSO be auto-added so you can view this cluster in the AWS console.";
      const who = src.roleArn
        ? src.roleArn
        : src.providerName
          ? `${src.providerName} (stored keys)`
          : "your connected AWS account";
      return `Deep Agent already gets cluster-admin automatically via ${who}. If the stored credentials are an IAM USER's, that user will ALSO be added so you can view the cluster in the AWS console — no need to paste an ARN below unless you want to add teammates.`;
    },
  },
  {
    page: 5,
    kind: "info",
    key: "iamUserInfo",
    label: "IAM user access — automatic",
    text: () =>
      "The IAM user whose access keys you gave to DeepAgent is ALWAYS granted cluster admin (Terraform enables `enable_cluster_creator_admin_permissions`). You never need a separate toggle for it. If you sign into the AWS Console with that IAM user, everything already works.",
  },
  {
    page: 5,
    kind: "choice",
    key: "grantRootAccess",
    label: "Grant access to the AWS account root user",
    hint: "Adds arn:aws:iam::<accountId>:root to the cluster's Access Entries. Tick this if you sign into the AWS Console with your account email + password (root). You can tick BOTH this and the IAM-user option above — pick whichever you use in the browser (or both if you switch between them).",
    choices: [
      { value: false, label: "No — I don't sign in as root" },
      { value: true, label: "Yes — grant access to the root user" },
    ],
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
    "Cluster & endpoint",
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
  buildBody: (a) => {
    // Parse the node-groups list and normalize each row. First row becomes
    // the request's required legacy fields (instanceType/desiredNodes/…) so
    // the API contract stays back-compat; the full array is sent alongside
    // as `nodeGroups` for multi-pool clusters.
    const rows = parseListRows(a.nodeGroups).map((r) => ({
      name: String(r.name ?? "").trim(),
      instanceType: String(r.instanceType ?? "t3.medium").trim() || "t3.medium",
      capacityType: r.capacityType === "SPOT" ? ("SPOT" as const) : ("ON_DEMAND" as const),
      minNodes: Math.max(1, Number(r.minNodes) || 1),
      desiredNodes: Math.max(1, Number(r.desiredNodes) || 1),
      maxNodes: Math.max(1, Number(r.maxNodes) || 1),
      diskSize: Math.max(20, Number(r.diskSize) || 100),
    }));
    const first = rows[0] ?? {
      name: `${String(a.name ?? "cluster")}-workers`,
      instanceType: "t3.medium",
      capacityType: "ON_DEMAND" as const,
      minNodes: 1,
      desiredNodes: 2,
      maxNodes: 3,
      diskSize: 100,
    };
    return {
    name: String(a.name).trim(),
    region: String(a.region).trim(),
    kubernetesVersion: a.kubernetesVersion,
    instanceType: first.instanceType,
    desiredNodes: first.desiredNodes,
    minNodes: first.minNodes,
    maxNodes: first.maxNodes,
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
    systemDiskSize: first.diskSize,
    ebsCsi: a.ebsCsi !== false,
    // First row's name + capacity go into the console-style overrides so
    // single-group clusters look identical to the previous flow.
    nodeGroupName: first.name || undefined,
    capacityType: first.capacityType,
    // Multi-pool: send the full array. Backend generates one
    // eks_managed_node_groups entry per row.
    nodeGroups: rows,
    // Legacy "system + application" pair is now expressed as two rows in
    // nodeGroups[]. Keep off so we don't get an extra tainted group.
    appNodeGroup: false,
    accessEntries: (() => {
      const entries = parseListRows(a.accessEntries)
        .map((r) => ({
          principalArn: String(r.principalArn ?? "").trim(),
          policy: String(r.policy ?? "AmazonEKSClusterAdminPolicy"),
        }))
        .filter((e) => e.principalArn);
      return entries.length > 0 ? entries : undefined;
    })(),
    // Root toggle. Default FALSE — flip when the customer signs into the
    // AWS Console as root. The connected IAM user is always admin via
    // enable_cluster_creator_admin_permissions=true (no separate toggle).
    grantRootAccess: a.grantRootAccess === true,
    };
  },
};

export function EksChatBox({ slug }: { slug: string }) {
  return <ClusterChat slug={slug} config={EKS_CONFIG} />;
}
