import { z } from "zod";

// ──────────────────────────────────────────────────────────────────
// Repos
// ──────────────────────────────────────────────────────────────────
export const RepoKindApi = z.enum([
  "Service",
  "Frontend",
  "Terraform",
  "Kubernetes",
  "Library",
  "Worker",
]);
export type RepoKindApi = z.infer<typeof RepoKindApi>;

export const RepoVisibilityApi = z.enum(["private", "public"]);

export const RepoSummary = z.object({
  id: z.string(),
  fullName: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  lang: z.string(),
  kind: RepoKindApi,
  defaultBranch: z.string(),
  visibility: RepoVisibilityApi,
  openIssues: z.number().int(),
  openPrs: z.number().int(),
  lastCommitSha: z.string().nullable(),
  lastCommitAt: z.string().datetime().nullable(),
  createdAt: z.string().datetime(),
});
export type RepoSummary = z.infer<typeof RepoSummary>;

export const CreateRepoRequest = z.object({
  // owner/repo (GitHub) OR a GitLab path_with_namespace, which may nest through
  // groups: group/subgroup/repo — so "one-or-more /segments".
  fullName: z
    .string()
    .trim()
    .regex(
      /^[A-Za-z0-9_.\-]+(\/[A-Za-z0-9_.\-]+)+$/,
      "fullName must be in 'owner/repo' (or 'group/sub/repo') form",
    ),
  description: z.string().trim().max(500).optional().default(""),
  lang: z.string().trim().min(1).max(40),
  kind: RepoKindApi,
  defaultBranch: z.string().trim().default("main"),
  visibility: RepoVisibilityApi.default("private"),
  /** Connected git identity (OAuthAccount.id) the repo was discovered through. */
  oauthAccountId: z.string().uuid().optional(),
  /** Git host. Defaults to github server-side when omitted. */
  provider: z.enum(["github", "gitlab"]).optional(),
  /** Provider-native repo id (GitLab numeric project id). */
  providerRepoId: z.string().trim().optional(),
});
export type CreateRepoRequest = z.infer<typeof CreateRepoRequest>;

export const AttachRepoRequest = z.object({
  repoId: z.string().min(1),
});
export type AttachRepoRequest = z.infer<typeof AttachRepoRequest>;

// ──────────────────────────────────────────────────────────────────
// Cloud providers
// ──────────────────────────────────────────────────────────────────
export const CloudKindApi = z.enum(["aws", "gcp", "azure", "proxmox"]);
export type CloudKindApi = z.infer<typeof CloudKindApi>;

export const CloudProviderSummary = z.object({
  id: z.string(),
  kind: CloudKindApi,
  name: z.string(),
  accountRef: z.string(),
  accountId: z.string().nullable(),
  region: z.string(),
  status: z.enum(["ok", "warn", "danger"]),
  // We expose whether a roleArn/externalId is set, but never the values themselves.
  hasRoleArn: z.boolean(),
  // True when AWS access key + secret are stored in Vault for this provider.
  hasVaultCreds: z.boolean(),
  createdAt: z.string().datetime(),
});
export type CloudProviderSummary = z.infer<typeof CloudProviderSummary>;

export const CreateCloudProviderRequest = z.object({
  kind: CloudKindApi,
  name: z.string().trim().min(1).max(80),
  accountRef: z.string().trim().min(1).max(120),
  accountId: z.string().trim().max(120).optional(),
  region: z.string().trim().min(1).max(40),
  roleArn: z.string().trim().max(200).optional(),
  externalId: z.string().trim().max(120).optional(),
});
export type CreateCloudProviderRequest = z.infer<typeof CreateCloudProviderRequest>;

export const UpdateCloudProviderRequest = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    region: z.string().trim().min(1).max(40).optional(),
    roleArn: z.string().trim().max(200).optional(),
    externalId: z.string().trim().max(120).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "At least one field is required" });
export type UpdateCloudProviderRequest = z.infer<typeof UpdateCloudProviderRequest>;

// Proxmox VM creation (the VM box + agent). Terraform is generated from this.
export const CreateProxmoxVmRequest = z.object({
  envKey: z.string().trim().min(1),
  name: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9-]{1,38}$/, "Lowercase letters, digits, hyphens; start with a letter."),
  node: z.string().trim().min(1).default("pve"),
  cores: z.coerce.number().int().min(1).max(128).default(2),
  memoryMB: z.coerce.number().int().min(128).max(1048576).default(2048),
  diskGB: z.coerce.number().int().min(1).max(16384).default(20),
  datastore: z.string().trim().min(1).default("local-lvm"),
  bridge: z.string().trim().min(1).default("vmbr0"),
  templateVmId: z.coerce.number().int().positive().optional(),
  isoFile: z.string().trim().optional(),
  ipv4: z.string().trim().optional(),
  gateway: z.string().trim().optional(),
});
export type CreateProxmoxVmRequest = z.infer<typeof CreateProxmoxVmRequest>;

// ──────────────────────────────────────────────────────────────────
// AWS access/secret keys (stored in HashiCorp Vault, not Postgres)
// ──────────────────────────────────────────────────────────────────
export const SetAwsKeysRequest = z.object({
  // AKIA…/ASIA… are 20 chars; keep the bound loose but sane.
  accessKeyId: z.string().trim().min(16).max(128),
  secretAccessKey: z.string().trim().min(1).max(256),
  region: z.string().trim().max(40).optional(),
});
export type SetAwsKeysRequest = z.infer<typeof SetAwsKeysRequest>;

/** Per-provider credential status (never returns the secret values). */
export const ProviderCredentialStatus = z.object({
  vaultConfigured: z.boolean(),
  hasVaultCreds: z.boolean(),
});
export type ProviderCredentialStatus = z.infer<typeof ProviderCredentialStatus>;

/** Vault connectivity for the "Vault config" section. */
export const VaultStatusResponse = z.object({
  configured: z.boolean(),
  reachable: z.boolean(),
  addr: z.string().nullable(),
  mount: z.string(),
  error: z.string().optional(),
});
export type VaultStatusResponse = z.infer<typeof VaultStatusResponse>;

// ──────────────────────────────────────────────────────────────────
// Terraform remote-state backend per environment. Two shapes:
//   • AWS/S3: { bucket, region, table? } (DynamoDB lock table optional)
//   • GCP/GCS: { gcsBucket } (GCS uses object generations for locking)
// The endpoint discriminates by field shape.
// ──────────────────────────────────────────────────────────────────
export const SetTfBackendS3Request = z.object({
  bucket: z.string().trim().min(3).max(63),
  region: z.string().trim().min(1).max(40),
  table: z.string().trim().max(255).optional(),
});
export const SetTfBackendGcsRequest = z.object({
  gcsBucket: z.string().trim().min(3).max(63),
});
export const SetTfBackendAzureRequest = z.object({
  azureResourceGroup: z.string().trim().min(1).max(90),
  azureStorageAccount: z.string().trim().min(3).max(24),
  azureContainer: z.string().trim().min(3).max(63),
});
export const SetTfBackendRequest = z.union([
  SetTfBackendS3Request,
  SetTfBackendGcsRequest,
  SetTfBackendAzureRequest,
]);
export type SetTfBackendRequest = z.infer<typeof SetTfBackendRequest>;

export const TfBackendStatus = z.object({
  bucket: z.string().nullable(),
  region: z.string().nullable(),
  table: z.string().nullable(),
  gcsBucket: z.string().nullable(),
  azureResourceGroup: z.string().nullable(),
  azureStorageAccount: z.string().nullable(),
  azureContainer: z.string().nullable(),
  cloudKind: z.string().nullable(),
});
export type TfBackendStatus = z.infer<typeof TfBackendStatus>;

// ──────────────────────────────────────────────────────────────────
// EKS cluster creation (generates Terraform)
// ──────────────────────────────────────────────────────────────────
export const CreateEksRequest = z.object({
  name: z
    .string()
    .trim()
    .regex(/^[a-z][a-z0-9-]{1,38}$/, "Lowercase letters, digits and hyphens; start with a letter."),
  region: z.string().trim().min(1).max(40),
  kubernetesVersion: z.string().trim().min(1).max(10),
  instanceType: z.string().trim().min(1).max(40),
  desiredNodes: z.number().int().min(1).max(50),
  minNodes: z.number().int().min(1).max(50),
  maxNodes: z.number().int().min(1).max(100),
  endpointPublic: z.boolean().default(true),
  // Optional: tie the cluster's Terraform state to an env's S3 backend. When
  // provided, this ALSO persists onto the env (setEnvTfBackend) so future
  // creates for the same env reuse it without re-asking.
  envKey: z.string().trim().max(60).optional(),
  stateBucket: z.string().trim().max(63).optional(),
  stateTable: z.string().trim().max(255).optional(),
  // VPC: create a new one (default) or reuse an existing VPC to avoid the
  // account's VPC-per-region limit. When createVpc=false, existingVpcId is used
  // (subnets auto-discovered unless existingSubnetIds is provided).
  createVpc: z.boolean().default(true),
  existingVpcId: z.string().trim().max(40).optional(),
  existingSubnetIds: z.array(z.string().trim().max(40)).max(12).optional(),
  // Node placement: defaults to the cluster's subnets (existingSubnetIds) when
  // omitted. Only meaningful when reusing an existing VPC.
  nodeSubnetIds: z.array(z.string().trim().max(40)).max(12).optional(),
  // Production options.
  environment: z.string().trim().max(40).optional(),
  team: z.string().trim().max(40).optional(),
  costCenter: z.string().trim().max(40).optional(),
  publicAccessCidrs: z.string().trim().max(400).optional(),
  controlPlaneLogs: z.boolean().optional(),
  secretsEncryption: z.boolean().optional(),
  systemDiskSize: z.number().int().min(20).max(1000).optional(),
  ebsCsi: z.boolean().optional(),
  appNodeGroup: z.boolean().optional(),
  appInstanceTypes: z.array(z.string().trim().max(40)).max(8).optional(),
  appCapacityType: z.enum(["ON_DEMAND", "SPOT"]).optional(),
  appMinNodes: z.number().int().min(0).max(50).optional(),
  appMaxNodes: z.number().int().min(1).max(100).optional(),
  appDesiredNodes: z.number().int().min(0).max(50).optional(),
  // EKS Access Entries — grant additional IAM users/roles cluster access
  // beyond the Terraform-applying identity (which always gets admin via
  // enable_cluster_creator_admin_permissions).
  accessEntries: z
    .array(
      z.object({
        principalArn: z
          .string()
          .trim()
          .regex(
            /^arn:aws:iam::\d{12}:(user|role)\/.+$/,
            "Must be an IAM user/role ARN, e.g. arn:aws:iam::123456789012:role/devops",
          ),
        policy: z.enum([
          "AmazonEKSClusterAdminPolicy",
          "AmazonEKSAdminPolicy",
          "AmazonEKSEditPolicy",
          "AmazonEKSViewPolicy",
        ]),
      }),
    )
    .max(10)
    .optional(),
});
export type CreateEksRequest = z.infer<typeof CreateEksRequest>;

const clusterName = z
  .string()
  .trim()
  .regex(/^[a-z][a-z0-9-]{1,38}$/, "Lowercase letters, digits and hyphens; start with a letter.");

// GKE (Google Kubernetes Engine) blueprint answers.
export const CreateGkeRequest = z.object({
  name: clusterName,
  project: z.string().trim().min(1, "GCP project id is required.").max(64),
  location: z.string().trim().min(1).max(40),
  kubernetesVersion: z.string().trim().min(1).max(10),
  machineType: z.string().trim().min(1).max(40),
  desiredNodes: z.number().int().min(1).max(50),
  minNodes: z.number().int().min(1).max(50),
  maxNodes: z.number().int().min(1).max(100),
  privateNodes: z.boolean().default(false),
  envKey: z.string().trim().max(60).optional(),
  // Network: create a dedicated VPC (default) or reuse an existing network.
  createNetwork: z.boolean().default(true),
  existingNetwork: z.string().trim().max(64).optional(),
  existingSubnetwork: z.string().trim().max(64).optional(),
  // Production options.
  environment: z.string().trim().max(40).optional(),
  team: z.string().trim().max(40).optional(),
  costCenter: z.string().trim().max(40).optional(),
  releaseChannel: z.enum(["REGULAR", "STABLE", "RAPID"]).optional(),
  privateEndpoint: z.boolean().optional(),
  masterAuthorizedCidrs: z.string().trim().max(400).optional(),
  dataplaneV2: z.boolean().optional(),
  workloadIdentity: z.boolean().optional(),
  shieldedNodes: z.boolean().optional(),
  binaryAuthorization: z.boolean().optional(),
  intranodeVisibility: z.boolean().optional(),
  gatewayApi: z.boolean().optional(),
  cloudDns: z.boolean().optional(),
  monitoring: z.boolean().optional(),
  httpLoadBalancing: z.boolean().optional(),
  backupAgent: z.boolean().optional(),
  configConnector: z.boolean().optional(),
  systemDiskType: z.enum(["pd-ssd", "pd-balanced", "pd-standard"]).optional(),
  systemDiskSize: z.number().int().min(20).max(1000).optional(),
  appNodePool: z.boolean().optional(),
  appMachineType: z.string().trim().max(40).optional(),
  appSpot: z.boolean().optional(),
  appMinNodes: z.number().int().min(0).max(50).optional(),
  appMaxNodes: z.number().int().min(1).max(100).optional(),
  // Remote state (GCS): bucket. GCS uses object generations for locking,
  // so no separate lock table is needed. Persisted onto the env when set.
  stateBucket: z.string().trim().min(3).max(63).optional(),
});
export type CreateGkeRequest = z.infer<typeof CreateGkeRequest>;

// AKS (Azure Kubernetes Service) blueprint answers.
export const CreateAksRequest = z.object({
  name: clusterName,
  location: z.string().trim().min(1).max(40),
  kubernetesVersion: z.string().trim().min(1).max(10),
  vmSize: z.string().trim().min(1).max(40),
  desiredNodes: z.number().int().min(1).max(50),
  minNodes: z.number().int().min(1).max(50),
  maxNodes: z.number().int().min(1).max(100),
  envKey: z.string().trim().max(60).optional(),
  // Resource group: create a new one (default) or reference an existing one.
  resourceGroup: z.string().trim().min(1, "Resource group name is required.").max(90),
  createResourceGroup: z.boolean().default(true),
  // Optional existing subnet resource id (nodes join it); omit for AKS-managed networking.
  vnetSubnetId: z.string().trim().max(400).optional(),
  // Production options.
  environment: z.string().trim().max(40).optional(),
  team: z.string().trim().max(40).optional(),
  costCenter: z.string().trim().max(40).optional(),
  skuTier: z.enum(["Standard", "Free"]).optional(),
  zones: z.boolean().optional(),
  automaticUpgrade: z.enum(["patch", "none"]).optional(),
  networkPolicy: z.enum(["azure", "calico"]).optional(),
  serviceCidr: z.string().trim().max(40).optional(),
  dnsServiceIp: z.string().trim().max(40).optional(),
  privateCluster: z.boolean().optional(),
  authorizedIpRanges: z.string().trim().max(400).optional(),
  azureRbac: z.boolean().optional(),
  disableLocalAccounts: z.boolean().optional(),
  workloadIdentity: z.boolean().optional(),
  azurePolicy: z.boolean().optional(),
  systemDiskSize: z.number().int().min(30).max(2048).optional(),
  systemOsDiskType: z.enum(["Ephemeral", "Managed"]).optional(),
  systemMaxPods: z.number().int().min(10).max(250).optional(),
  appNodePool: z.boolean().optional(),
  appVmSize: z.string().trim().max(40).optional(),
  appSpot: z.boolean().optional(),
  appMinNodes: z.number().int().min(0).max(50).optional(),
  appMaxNodes: z.number().int().min(1).max(100).optional(),
  monitoring: z.boolean().optional(),
  keyVaultSecretsProvider: z.boolean().optional(),
  kedaVpa: z.boolean().optional(),
});
export type CreateAksRequest = z.infer<typeof CreateAksRequest>;

// ──────────────────────────────────────────────────────────────────
// Integrations (credential-type in Phase 6; oauth flow is a later phase)
// ──────────────────────────────────────────────────────────────────
export const IntegrationAuthTypeApi = z.enum(["oauth", "credential"]);
export const IntegrationStatusApi = z.enum(["disconnected", "connected", "error", "expired"]);

export const IntegrationSummary = z.object({
  id: z.string(),
  provider: z.string(),
  name: z.string(),
  icon: z.string(),
  description: z.string(),
  authType: IntegrationAuthTypeApi,
  status: IntegrationStatusApi,
  connectedByName: z.string().nullable(),
  connectedAt: z.string().datetime().nullable(),
  lastSyncedAt: z.string().datetime().nullable(),
  // Non-secret keys + a "set" flag for each credential — never the plaintext.
  credentialKeys: z.array(z.object({ key: z.string(), isSecret: z.boolean() })),
});
export type IntegrationSummary = z.infer<typeof IntegrationSummary>;

const Credential = z.object({
  key: z.string().trim().min(1).max(60),
  value: z.string().min(1),
  isSecret: z.boolean().optional().default(true),
});

export const CreateIntegrationRequest = z.object({
  provider: z.string().trim().min(1).max(60),
  name: z.string().trim().min(1).max(80),
  icon: z.string().trim().min(1).max(40),
  description: z.string().trim().max(200).optional().default(""),
  // Phase 6 supports the credential auth type; oauth is reserved for the OAuth phase.
  authType: z.literal("credential"),
  credentials: z.array(Credential).min(1, "Provide at least one credential"),
});
export type CreateIntegrationRequest = z.infer<typeof CreateIntegrationRequest>;

export const UpdateIntegrationRequest = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    description: z.string().trim().max(200).optional(),
    credentials: z.array(Credential).optional(),
    status: IntegrationStatusApi.optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "At least one field is required" });
export type UpdateIntegrationRequest = z.infer<typeof UpdateIntegrationRequest>;
