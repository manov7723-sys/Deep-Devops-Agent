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
  fullName: z
    .string()
    .trim()
    .regex(/^[A-Za-z0-9_.\-]+\/[A-Za-z0-9_.\-]+$/, "fullName must be in 'owner/repo' form"),
  description: z.string().trim().max(500).optional().default(""),
  lang: z.string().trim().min(1).max(40),
  kind: RepoKindApi,
  defaultBranch: z.string().trim().default("main"),
  visibility: RepoVisibilityApi.default("private"),
  /** Connected GitHub identity (OAuthAccount.id) the repo was discovered through. */
  oauthAccountId: z.string().uuid().optional(),
});
export type CreateRepoRequest = z.infer<typeof CreateRepoRequest>;

export const AttachRepoRequest = z.object({
  repoId: z.string().min(1),
});
export type AttachRepoRequest = z.infer<typeof AttachRepoRequest>;

// ──────────────────────────────────────────────────────────────────
// Cloud providers
// ──────────────────────────────────────────────────────────────────
export const CloudKindApi = z.enum(["aws", "gcp", "azure"]);
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
// Terraform remote-state backend (S3 + DynamoDB lock) per environment
// ──────────────────────────────────────────────────────────────────
export const SetTfBackendRequest = z.object({
  bucket: z.string().trim().min(3).max(63),
  region: z.string().trim().min(1).max(40),
  // DynamoDB lock table is optional (Terraform can run without state locking).
  table: z.string().trim().max(255).optional(),
});
export type SetTfBackendRequest = z.infer<typeof SetTfBackendRequest>;

export const TfBackendStatus = z.object({
  bucket: z.string().nullable(),
  region: z.string().nullable(),
  table: z.string().nullable(),
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
  // Optional: tie the cluster's Terraform state to an env's S3 backend.
  envKey: z.string().trim().max(60).optional(),
  // VPC: create a new one (default) or reuse an existing VPC to avoid the
  // account's VPC-per-region limit. When createVpc=false, existingVpcId is used
  // (subnets auto-discovered unless existingSubnetIds is provided).
  createVpc: z.boolean().default(true),
  existingVpcId: z.string().trim().max(40).optional(),
  existingSubnetIds: z.array(z.string().trim().max(40)).max(12).optional(),
});
export type CreateEksRequest = z.infer<typeof CreateEksRequest>;

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
