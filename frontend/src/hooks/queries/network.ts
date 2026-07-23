import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api, apiErrorMessage } from "@/lib/api/client";

const pk = (slug: string, ...parts: (string | undefined | null)[]) =>
  ["p", slug, "network", ...parts.filter((p): p is string => !!p)] as const;

export type AwsVpc = { vpcId: string; name: string | null; cidr: string; isDefault: boolean };

type VpcsResponse =
  | { ok: true; connected: true; region: string; vpcs: AwsVpc[]; subnets: unknown[] }
  | { ok: true; connected: false; vpcs: AwsVpc[]; subnets: unknown[]; note: string };

/**
 * Fetch every VPC in a given AWS region for the project's connected account.
 * Uses the region query param only (no `env=`) so the same endpoint's
 * project-provider fallback path picks up the credentials — matches the
 * pattern the Network > Peering page uses to independently pick VPCs from
 * two different regions.
 */
export function useAwsVpcsInRegion(slug: string, region: string | null) {
  return useQuery({
    queryKey: pk(slug, "vpcs", region ?? ""),
    queryFn: () =>
      api.get<VpcsResponse>(`/projects/${slug}/aws/vpcs`, region ? { region } : undefined),
    enabled: !!region,
    staleTime: 30_000,
  });
}

export type SubmitPeeringInput = {
  name: string;
  envKey: string;
  left: { region: string; vpcId: string; cidr: string };
  right: { region: string; vpcId: string; cidr: string };
};
export type SubmitPeeringResult = {
  ok: boolean;
  approvalId?: string;
  risk?: "low" | "medium" | "high";
  committedFiles?: Array<{ path: string; commitSha: string }>;
  repoPath?: string;
  repoFullName?: string;
  message?: string;
  code?: string;
};

/**
 * Submit the peering form. Server-side: generates HCL, commits it to the
 * repo, creates an infra approval (with policy checks + cost), returns the
 * approvalId the page renders inline via <ApprovalCard>. Same end-to-end as
 * the chat playbook does — just driven from a real UI.
 */
export function useSubmitVpcPeering(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SubmitPeeringInput) => {
      const res = await api.post<SubmitPeeringResult>(`/projects/${slug}/aws/vpc-peering`, input);
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Peering submit failed.");
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["p", slug, "approvals"] });
    },
  });
}

// ── Subnets ─────────────────────────────────────────────────────────────
export type AwsSubnet = {
  subnetId: string;
  cidr: string;
  az: string;
  name: string;
  /** True when the subnet has a working internet path (IGW OR NAT). */
  isPublic: boolean;
  /** True only when the subnet's route table has 0.0.0.0/0 → IGW. Needed for
   *  Client VPN full-tunnel + full internet — NAT is NOT enough there because
   *  the VPN endpoint terminates traffic in the subnet without a public IP. */
  hasIgwRoute?: boolean;
  hasNatRoute?: boolean;
  /** Kept for callers still reading MapPublicIpOnLaunch. */
  mapPublicIpOnLaunch?: boolean;
};
type SubnetsResponse = { ok: boolean; region?: string; vpcId?: string; subnets: AwsSubnet[]; message?: string };

/** Fetch subnets in a chosen VPC — used by the EC2 form's subnet picker. */
export function useAwsSubnetsInVpc(slug: string, region: string | null, vpcId: string | null) {
  return useQuery({
    queryKey: pk(slug, "subnets", region ?? "", vpcId ?? ""),
    queryFn: () =>
      api.get<SubnetsResponse>(`/projects/${slug}/aws/subnets`, {
        region: region ?? "",
        vpcId: vpcId ?? "",
      }),
    enabled: !!region && !!vpcId,
    staleTime: 30_000,
  });
}

// ── VPC + EC2 + S3 submits — all three share the same result shape. ─────
type ResourceSubmitResult = {
  ok: boolean;
  approvalId?: string;
  risk?: "low" | "medium" | "high";
  committedFiles?: Array<{ path: string; commitSha: string }>;
  repoPath?: string;
  repoFullName?: string;
  message?: string;
  code?: string;
};

export type SubmitVpcInput = {
  name: string;
  envKey: string;
  region: string;
  vpcCidr: string;
  azCount?: 1 | 2 | 3;
  includePrivateSubnets?: boolean;
  natStrategy?: "none" | "single" | "per_az";
  dnsHostnames?: boolean;
  dnsSupport?: boolean;
};

export function useSubmitVpc(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SubmitVpcInput) => {
      const res = await api.post<ResourceSubmitResult>(`/projects/${slug}/aws/vpc`, input);
      if (!res.ok) throw new Error(res.message ?? res.code ?? "VPC submit failed.");
      return res;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["p", slug, "approvals"] }),
  });
}

export type SubmitEc2Input = {
  name: string;
  envKey: string;
  region: string;
  vpcId: string;
  subnetId: string;
  ami?:
    | "al2023"
    | "ubuntu-22.04"
    | "ubuntu-24.04"
    | "windows-2022"
    | "rhel-9"
    | "sles-15"
    | "debian-12";
  instanceType?: string;
  diskGb?: number;
  volumeType?: "gp3" | "gp2" | "io2";
  volumeIops?: number;
  encryptVolume?: boolean;
  sshCidr?: string;
  sshKeyName?: string;
  allowHttp?: boolean;
  allowHttps?: boolean;
  userData?: string;
  customTags?: Record<string, string>;
};

export function useSubmitEc2(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SubmitEc2Input) => {
      const res = await api.post<ResourceSubmitResult>(`/projects/${slug}/aws/ec2`, input);
      if (!res.ok) throw new Error(res.message ?? res.code ?? "EC2 submit failed.");
      return res;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["p", slug, "approvals"] }),
  });
}

// ── S3 name availability (live check) ─────────────────────────────────────

export type S3NameStatus = "available" | "taken" | "invalid" | "unknown";
export type S3NameCheckResult = { ok: boolean; status: S3NameStatus; message: string };

/**
 * Live "is this bucket name available globally?" probe, debounced so it
 * doesn't fire on every keystroke. Returns `disabled: true` while the name
 * is empty or the caller hasn't stopped typing long enough — the UI should
 * treat that as "not checked yet" (neutral, no badge).
 */
export function useS3NameAvailability(slug: string, name: string, debounceMs = 500) {
  const [debounced, setDebounced] = useState<string>(name);
  useEffect(() => {
    const t = setTimeout(() => setDebounced(name), debounceMs);
    return () => clearTimeout(t);
  }, [name, debounceMs]);
  return useQuery({
    queryKey: ["p", slug, "s3-name-check", debounced],
    queryFn: () =>
      api.get<S3NameCheckResult>(`/projects/${slug}/aws/s3/name-check`, { name: debounced }),
    enabled: debounced.length >= 3,
    // The name check is a live network call to AWS — cache aggressively
    // within a single edit session so nudge-fixing typos ("my-buket" →
    // "my-bucket") doesn't hit the API on every backspace.
    staleTime: 30_000,
  });
}

export type SubmitS3Input = {
  name: string;
  envKey: string;
  region: string;
  encryptionMode?: "AES256" | "aws:kms";
  versioning?: boolean;
  noncurrentVersionExpirationDays?: number;
  addRandomSuffix?: boolean;
};

export function useSubmitS3(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SubmitS3Input) => {
      const res = await api.post<ResourceSubmitResult>(`/projects/${slug}/aws/s3`, input);
      if (!res.ok) throw new Error(res.message ?? res.code ?? "S3 submit failed.");
      return res;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["p", slug, "approvals"] }),
  });
}

// ── Jenkins provisioning + list (for the Jenkins page + wizard) ─────────

export type AwsSecurityGroup = {
  groupId: string;
  groupName: string;
  description: string;
  vpcId: string;
  inboundRuleCount: number;
};

type SgResponse =
  | { ok: true; connected: true; region: string; vpcId: string; securityGroups: AwsSecurityGroup[]; note?: string }
  | { ok: true; connected: false; securityGroups: AwsSecurityGroup[]; note: string };

/** List security groups in a picked VPC — powers the Jenkins wizard's SG multi-select. */
export function useAwsSecurityGroupsInVpc(
  slug: string,
  region: string | null,
  vpcId: string | null,
) {
  return useQuery({
    queryKey: pk(slug, "sgs", region ?? "", vpcId ?? ""),
    queryFn: () =>
      api.get<SgResponse>(`/projects/${slug}/aws/security-groups`, {
        region: region ?? "",
        vpcId: vpcId ?? "",
      }),
    enabled: !!region && !!vpcId,
    staleTime: 30_000,
  });
}

export type AwsKeyPair = { name: string; type: string; fingerprint: string | null };

type KeyPairsResponse =
  | { ok: true; connected: true; region: string; keyPairs: AwsKeyPair[]; note?: string }
  | { ok: true; connected: false; keyPairs: AwsKeyPair[]; note: string };

/** List EC2 key pairs in a region — powers the Jenkins wizard's SSH picker. */
export function useAwsKeyPairsInRegion(slug: string, region: string | null) {
  return useQuery({
    queryKey: pk(slug, "keypairs", region ?? ""),
    queryFn: () =>
      api.get<KeyPairsResponse>(`/projects/${slug}/aws/keypairs`, region ? { region } : undefined),
    enabled: !!region,
    staleTime: 30_000,
  });
}

export type SubmitJenkinsInput = {
  name: string;
  envKey: string;
  region: string;
  vpcId: string;
  subnetId: string;
  instanceType?: string;
  diskGb?: number;
  adminUsername?: string;
  adminPassword: string;
  keyName?: string;
  sshCidr?: string;
  jenkinsCidr?: string;
  /**
   * When set + non-empty, the generator SKIPS creating a new security group
   * and attaches these existing SGs to the instance instead. Mutually
   * exclusive with sshCidr/jenkinsCidr (which only apply to the auto-created
   * SG).
   */
  existingSecurityGroupIds?: string[];
};

export function useSubmitJenkinsProvision(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SubmitJenkinsInput) => {
      try {
        const res = await api.post<ResourceSubmitResult & { jenkinsfileCreated?: boolean }>(
          `/projects/${slug}/aws/jenkins/provision`,
          input,
        );
        if (!res.ok) throw new Error(res.message ?? res.code ?? "Jenkins provision submit failed.");
        return res;
      } catch (e) {
        // api.post throws ApiRequestError on non-2xx with the response body
        // in `details`. Extract the real message so the wizard shows "port
        // 22 conflict" instead of the useless "Bad Request" statusText.
        throw new Error(apiErrorMessage(e, "Jenkins provision submit failed."));
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["p", slug, "approvals"] }),
  });
}

export type JenkinsServerItem = {
  approvalId: string;
  name: string;
  stack: string;
  title: string;
  status: string;
  envKey: string;
  envName: string;
  requestedAt: string;
  appliedAt: string | null;
};

export function useJenkinsList(slug: string) {
  return useQuery({
    queryKey: pk(slug, "jenkins-list"),
    queryFn: () => api.get<{ ok: boolean; items: JenkinsServerItem[] }>(`/projects/${slug}/aws/jenkins/list`),
    staleTime: 30_000,
  });
}

// Terraform outputs for a specific Jenkins stack. Used by the Jenkins page
// to render the *actual* SSH command (with the real key pair name and IP),
// the Jenkins URL, and a Reveal-on-click admin password. Set includeSecret
// to fetch the password too — server audits each reveal as a separate GET.
export type JenkinsOutputs = {
  jenkinsUrl?: string;
  jenkinsPublicIp?: string;
  jenkinsAdminUsername?: string;
  jenkinsAdminPassword?: string;
  keyName?: string | null;
  instanceId?: string;
  shellCommand?: string;
  region?: string;
};

export function useJenkinsOutputs(slug: string, approvalId: string | null, includeSecret = false) {
  return useQuery({
    queryKey: pk(slug, "jenkins-outputs", approvalId ?? "", String(includeSecret)),
    queryFn: async () => {
      try {
        return await api.get<{ ok: boolean; outputs: JenkinsOutputs; includedSecret: boolean }>(
          `/projects/${slug}/aws/jenkins/${approvalId}/outputs`,
          includeSecret ? { includeSecret: "1" } : undefined,
        );
      } catch (e) {
        throw new Error(apiErrorMessage(e, "Failed to load Jenkins outputs."));
      }
    },
    enabled: !!approvalId,
    // Outputs are stable — cache aggressively so paging around doesn't
    // re-run terraform init/output for the same stack every time.
    staleTime: 60_000,
    // Never cache the password — always re-fetch when the user hits Reveal.
    gcTime: includeSecret ? 0 : undefined,
  });
}

// ── Client VPN list (for the Client VPN page's rows + downloads) ─────────

export type ClientVpnItem = {
  approvalId: string;
  name: string;
  stack: string;
  title: string;
  status: string;
  envKey: string;
  envName: string;
  requestedAt: string;
  appliedAt: string | null;
};

export function useClientVpnList(slug: string) {
  return useQuery({
    queryKey: pk(slug, "client-vpn-list"),
    queryFn: () => api.get<{ ok: boolean; items: ClientVpnItem[] }>(`/projects/${slug}/aws/client-vpn/list`),
    staleTime: 30_000,
  });
}

// ── VPN certificate sets (standalone PKI, listed on the Client VPN page) ──

export type VpnCertificateSetItem = {
  approvalId: string;
  name: string;
  stack: string;
  title: string;
  status: string;
  envKey: string;
  envName: string;
  requestedAt: string;
  appliedAt: string | null;
};

export function useVpnCertificatesList(slug: string) {
  return useQuery({
    queryKey: pk(slug, "vpn-certificates-list"),
    queryFn: () =>
      api.get<{ ok: boolean; items: VpnCertificateSetItem[] }>(
        `/projects/${slug}/aws/vpn-certificates/list`,
      ),
    staleTime: 30_000,
  });
}

// ── Per-user certs issued against a specific Client VPN ──────────────────

export type VpnUserCertItem = {
  id: string;
  userName: string;
  serial: string;
  issuedAt: string;
  revokedAt: string | null;
  validityDays: number | null;
};

export function useVpnUserCerts(slug: string, approvalId: string | null) {
  return useQuery({
    queryKey: pk(slug, "vpn-user-certs", approvalId ?? ""),
    queryFn: () =>
      api.get<{ ok: boolean; items: VpnUserCertItem[] }>(
        `/projects/${slug}/aws/client-vpn/${approvalId}/user-certs`,
      ),
    enabled: !!approvalId,
    staleTime: 30_000,
  });
}

export function useRevokeVpnUserCert(slug: string, approvalId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (certId: string) => {
      try {
        return await api.del<{ ok: boolean; serial: string; note?: string }>(
          `/projects/${slug}/aws/client-vpn/${approvalId}/user-certs/${certId}`,
        );
      } catch (e) {
        throw new Error(apiErrorMessage(e, "Revoke failed."));
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: pk(slug, "vpn-user-certs", approvalId) }),
  });
}

// ── Azure VNet submit (chat wizard) ──────────────────────────────────────

export type SubmitAzureVnetInput = {
  name: string;
  envKey: string;
  location: string;
  vnetCidr: string;
  subnetCount?: 1 | 2 | 3;
  includePrivateSubnets?: boolean;
  natStrategy?: "none" | "single";
  createDefaultNsgs?: boolean;
};

export function useSubmitAzureVnet(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SubmitAzureVnetInput) => {
      const res = await api.post<ResourceSubmitResult>(`/projects/${slug}/azure/vnet`, input);
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Azure VNet submit failed.");
      return res;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["p", slug, "approvals"] }),
  });
}

// ── Azure VNets listing (used by the Azure VM wizard) ────────────────────

export type AzureVnetItem = {
  name: string;
  location: string;
  resourceGroup: string;
  addressSpace: string[];
  subnets: Array<{ name: string; addressPrefix: string }>;
};

type AzureVnetsResponse =
  | { ok: true; connected: true; location: string | null; vnets: AzureVnetItem[] }
  | { ok: true; connected: false; vnets: AzureVnetItem[]; note: string };

export function useAzureVnetsInLocation(slug: string, location: string | null) {
  return useQuery({
    queryKey: pk(slug, "azure-vnets", location ?? ""),
    queryFn: () =>
      api.get<AzureVnetsResponse>(`/projects/${slug}/azure/vnets`, location ? { location } : undefined),
    enabled: !!location,
    staleTime: 30_000,
  });
}

// ── Azure VM submit (chat wizard) ────────────────────────────────────────

export type SubmitAzureVmInput = {
  name: string;
  envKey: string;
  location: string;
  resourceGroupName: string;
  vnetName: string;
  subnetName: string;
  image?: "ubuntu-22.04" | "ubuntu-24.04" | "debian-12" | "rhel-9" | "windows-2022";
  vmSize?: string;
  diskGb?: number;
  publicIp?: boolean;
  adminUsername?: string;
  sshPublicKey?: string;
  adminPassword?: string;
  allowSsh?: boolean;
  allowRdp?: boolean;
  allowHttp?: boolean;
  allowHttps?: boolean;
  sshCidr?: string;
};

export function useSubmitAzureVm(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SubmitAzureVmInput) => {
      const res = await api.post<ResourceSubmitResult>(`/projects/${slug}/azure/vm`, input);
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Azure VM submit failed.");
      return res;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["p", slug, "approvals"] }),
  });
}

// ── Azure OpenVPN (self-hosted, chat wizard) ─────────────────────────────
// Azure's managed VPN Gateway P2S costs ~$140/mo. This wizard self-hosts
// OpenVPN on a Standard_B1s VM (~$13/mo) for cost parity with GCP.

export type SubmitAzureVpnInput = {
  name: string;
  envKey: string;
  location: string;
  resourceGroupName: string;
  vnetName: string;
  subnetName: string;
  vpcCidr: string;
  vmSize?: string;
  diskGb?: number;
  clientCidr?: string;
  certOwnerName?: string;
  splitTunnel?: boolean;
  transportProtocol?: "udp" | "tcp";
  vpnPort?: 1194 | 443;
  sourceRanges?: string[];
  adminUsername?: string;
  /** Empty string → server auto-generates an RSA-2048 OpenSSH keypair. */
  sshPublicKey?: string;
};

export function useSubmitAzureVpn(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SubmitAzureVpnInput) => {
      try {
        const res = await api.post<ResourceSubmitResult>(`/projects/${slug}/azure/vpn`, input);
        if (!res.ok) throw new Error(res.message ?? res.code ?? "Azure VPN submit failed.");
        return res;
      } catch (e) {
        throw new Error(apiErrorMessage(e, "Azure VPN submit failed."));
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["p", slug, "approvals"] }),
  });
}

export type AzureVpnItem = {
  approvalId: string;
  name: string;
  stack: string;
  title: string;
  status: string;
  envKey: string;
  envName: string;
  requestedAt: string;
  appliedAt: string | null;
};

export function useAzureVpnList(slug: string) {
  return useQuery({
    queryKey: pk(slug, "azure-vpn-list"),
    queryFn: () => api.get<{ ok: boolean; items: AzureVpnItem[] }>(`/projects/${slug}/azure/vpn/list`),
    staleTime: 30_000,
  });
}

// ── Live Azure VM sizes (quota + region availability) ────────────────────
// Live-query the user's Azure subscription for which VM sizes they can
// actually provision in a picked region. Powers the VPN wizard's size
// dropdown so users don't hit SkuNotAvailable or quota 409s.

export type AzureVmSizeAvailable = {
  vmSize: string;
  family: string;
  vCPUs: number;
  memoryGB: number;
  monthlyCost: number;
  /** 0-10 — higher = more likely to actually deploy without capacity 409. */
  reliability: number;
  notes?: string;
  quotaRemaining: number;
};
export type AzureVmSizeUnavailable = {
  vmSize: string;
  family: string;
  vCPUs: number;
  reason: "not_in_region" | "region_restricted" | "no_quota";
  detail: string;
};
export type AzureVmSizesResponse = {
  ok: boolean;
  location?: string;
  available?: AzureVmSizeAvailable[];
  unavailable?: AzureVmSizeUnavailable[];
  recommendedVmSize?: string | null;
  note?: string;
  code?: string;
  message?: string;
};

export function useAzureAvailableVmSizes(slug: string, location: string | null) {
  return useQuery({
    queryKey: pk(slug, "azure-vm-sizes", location ?? ""),
    queryFn: () =>
      api.get<AzureVmSizesResponse>(`/projects/${slug}/azure/vm-sizes`, {
        location: location ?? "",
      }),
    enabled: !!location,
    staleTime: 5 * 60_000,
  });
}

// ── GCP VPC submit (chat wizard) ─────────────────────────────────────────

export type SubmitGcpVpcInput = {
  name: string;
  envKey: string;
  region: string;
  vpcCidr: string;
  subnetCount?: 1 | 2 | 3;
  privateGoogleAccess?: boolean;
  enableCloudNat?: boolean;
  allowIapSsh?: boolean;
};

export function useSubmitGcpVpc(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SubmitGcpVpcInput) => {
      const res = await api.post<ResourceSubmitResult>(`/projects/${slug}/gcp/vpc`, input);
      if (!res.ok) throw new Error(res.message ?? res.code ?? "GCP VPC submit failed.");
      return res;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["p", slug, "approvals"] }),
  });
}

// ── GCP context + networks + VM (chat wizard) ────────────────────────────

type GcpContextResponse = {
  ok: boolean;
  connected?: boolean;
  activeProjectId?: string;
  projects?: Array<{ projectId: string; name: string; lifecycleState: string }>;
  region?: string | null;
  note?: string;
};

/** Which GCP project is the agent currently pointed at. Used by GCP wizards to auto-fill. */
export function useGcpContext(slug: string) {
  return useQuery({
    queryKey: pk(slug, "gcp-context"),
    queryFn: () => api.get<GcpContextResponse>(`/projects/${slug}/gcp/context`),
    staleTime: 60_000,
  });
}

type GcpNetworksResponse = {
  ok: boolean;
  connected?: boolean;
  region?: string;
  networks?: Array<{ name: string; selfLink: string }>;
  subnetworks?: Array<{ name: string; network: string; region: string; ipCidrRange: string }>;
  note?: string;
};

export function useGcpNetworksInRegion(
  slug: string,
  gcpProjectId: string | null,
  region: string | null,
) {
  return useQuery({
    queryKey: pk(slug, "gcp-networks", gcpProjectId ?? "", region ?? ""),
    queryFn: () =>
      api.get<GcpNetworksResponse>(`/projects/${slug}/gcp/networks`, {
        project: gcpProjectId ?? "",
        region: region ?? "",
      }),
    enabled: !!gcpProjectId && !!region,
    staleTime: 30_000,
  });
}

export type SubmitGcpVmInput = {
  name: string;
  envKey: string;
  zone: string;
  region: string;
  networkName: string;
  subnetName: string;
  image?: "debian-12" | "ubuntu-2204-lts" | "ubuntu-2404-lts" | "rocky-linux-9" | "windows-2022";
  machineType?: string;
  diskGb?: number;
  diskType?: "pd-standard" | "pd-balanced" | "pd-ssd";
  publicIp?: boolean;
  sshUsername?: string;
  sshPublicKey?: string;
  windowsAdminUsername?: string;
  windowsAdminPassword?: string;
  allowIapSsh?: boolean;
  allowHttp?: boolean;
  allowHttps?: boolean;
};

export function useSubmitGcpVm(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SubmitGcpVmInput) => {
      const res = await api.post<ResourceSubmitResult>(`/projects/${slug}/gcp/vm`, input);
      if (!res.ok) throw new Error(res.message ?? res.code ?? "GCP VM submit failed.");
      return res;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["p", slug, "approvals"] }),
  });
}

// ── AWS Client VPN submit (chat wizard) ──────────────────────────────────

export type SubmitClientVpnInput = {
  name: string;
  envKey: string;
  region: string;
  vpcId: string;
  vpcCidr: string;
  subnetIds: string[];
  clientCidr?: string;
  certOwnerName?: string;
  certMode?: "auto" | "manual";
  serverCertificateArn?: string;
  authMode?: "certificate" | "federated";
  clientRootCertificateArn?: string;
  samlProviderArn?: string;
  splitTunnel?: boolean;
  transportProtocol?: "udp" | "tcp";
  vpnPort?: 443 | 1194;
  allowInternetEgress?: boolean;
};

export function useSubmitClientVpn(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SubmitClientVpnInput) => {
      const res = await api.post<ResourceSubmitResult>(`/projects/${slug}/aws/client-vpn`, input);
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Client VPN submit failed.");
      return res;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["p", slug, "approvals"] }),
  });
}

// ── GCP OpenVPN (self-hosted, chat wizard) ───────────────────────────────
// GCP has no managed Client VPN. We provision an OpenVPN endpoint on a
// small Compute Engine VM. Same cert flow as AWS (auto-generated CA + certs)
// so the shared cert-download / issue-user UI works uniformly.

export type SubmitGcpVpnInput = {
  name: string;
  envKey: string;
  region: string;
  zone: string;
  networkName: string;
  subnetName: string;
  vpcCidr: string;
  machineType?: string;
  diskGb?: number;
  clientCidr?: string;
  certOwnerName?: string;
  splitTunnel?: boolean;
  transportProtocol?: "udp" | "tcp";
  vpnPort?: 1194 | 443;
  sourceRanges?: string[];
};

export function useSubmitGcpVpn(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SubmitGcpVpnInput) => {
      try {
        const res = await api.post<ResourceSubmitResult>(`/projects/${slug}/gcp/vpn`, input);
        if (!res.ok) throw new Error(res.message ?? res.code ?? "GCP VPN submit failed.");
        return res;
      } catch (e) {
        throw new Error(apiErrorMessage(e, "GCP VPN submit failed."));
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["p", slug, "approvals"] }),
  });
}

export type GcpVpnItem = {
  approvalId: string;
  name: string;
  stack: string;
  title: string;
  status: string;
  envKey: string;
  envName: string;
  requestedAt: string;
  appliedAt: string | null;
};

export function useGcpVpnList(slug: string) {
  return useQuery({
    queryKey: pk(slug, "gcp-vpn-list"),
    queryFn: () => api.get<{ ok: boolean; items: GcpVpnItem[] }>(`/projects/${slug}/gcp/vpn/list`),
    staleTime: 30_000,
  });
}

// ── Standalone VPN certificate set (create once, reference from multiple VPNs) ──

export type SubmitVpnCertificatesInput = {
  name: string;
  envKey: string;
  region: string;
  clientCertCount?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | 10;
  clientNames?: string[];
};

export function useSubmitVpnCertificates(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SubmitVpnCertificatesInput) => {
      try {
        const res = await api.post<ResourceSubmitResult>(`/projects/${slug}/aws/vpn-certificates`, input);
        if (!res.ok) throw new Error(res.message ?? res.code ?? "VPN certificate submit failed.");
        return res;
      } catch (e) {
        throw new Error(apiErrorMessage(e, "VPN certificate submit failed."));
      }
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["p", slug, "approvals"] }),
  });
}

// ── RDS listing + connect (Connections page) ─────────────────────────────
//
// Same shape as `useAwsVpcsInRegion` — read-only describe against the AWS
// account tied to the project, used to build the Connections page's RDS
// picker. `useSubmitRdsConnect` posts to /aws/rds-connect which builds the
// K8s Secret + kubectl-applies it via the same tool code paths the chat
// playbook uses.

export type AwsRdsInstance = {
  identifier: string;
  engine: string;
  endpoint: string | null;
  port: number | null;
  status: string;
  vpcId: string | null;
  database: string | null;
  username: string | null;
};

type RdsListResponse =
  | { ok: true; connected: true; region: string; instances: AwsRdsInstance[]; note?: string }
  | { ok: true; connected: false; instances: AwsRdsInstance[]; note: string };

export function useAwsRdsInRegion(slug: string, region: string | null) {
  return useQuery({
    queryKey: pk(slug, "rds", region ?? ""),
    queryFn: () =>
      api.get<RdsListResponse>(`/projects/${slug}/aws/rds`, region ? { region } : undefined),
    enabled: !!region,
    staleTime: 30_000,
  });
}

export type SubmitRdsConnectInput = {
  envKey: string;
  namespace: string;
  secretName: string;
  host: string;
  port: number;
  database: string;
  username: string;
  password: string;
  engine?: "postgres" | "mysql";
  alsoStoreInAppSecret?: boolean;
  appSecretKey?: string;
};

export type SubmitRdsConnectResult = {
  ok: boolean;
  secretName?: string;
  namespace?: string;
  keysWritten?: string[];
  appSecretKey?: string | null;
  kubectl?: { command: string; stdout: string };
  note?: string;
  manifest?: string; // returned on apply failure so the user can retry
  message?: string;
  code?: string;
};

export function useSubmitRdsConnect(slug: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: async (input: SubmitRdsConnectInput) => {
      const res = await api.post<SubmitRdsConnectResult>(`/projects/${slug}/aws/rds-connect`, input);
      if (!res.ok) throw new Error(res.message ?? res.code ?? "RDS connect failed.");
      return res;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["p", slug, "secrets"] }),
  });
}
