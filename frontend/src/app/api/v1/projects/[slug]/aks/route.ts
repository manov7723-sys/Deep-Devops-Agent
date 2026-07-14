import { NextResponse } from "next/server";
import { CreateAksRequest } from "@/lib/api/schemas/connectivity-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import {
  buildAksTerraform,
  AKS_DEFAULTS,
  AKS_VM_SIZES,
  AKS_K8S_VERSIONS,
  AKS_REGIONS,
  AKS_DISK_SIZES,
  type AksSpec,
} from "@/lib/devops/aks";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/** Form defaults + option lists for the AKS creation form. */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  return NextResponse.json({
    defaults: AKS_DEFAULTS,
    vmSizes: AKS_VM_SIZES,
    kubernetesVersions: AKS_K8S_VERSIONS,
    regions: AKS_REGIONS,
    diskSizes: AKS_DISK_SIZES,
  });
}

/** Generate the AKS Terraform tree from the wizard answers. */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = CreateAksRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const a = parsed.data;
  if (a.maxNodes < a.minNodes || a.desiredNodes < a.minNodes || a.desiredNodes > a.maxNodes) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: "Node counts must satisfy min ≤ desired ≤ max." },
      { status: 400 },
    );
  }

  const spec: AksSpec = {
    name: a.name,
    location: a.location,
    kubernetesVersion: a.kubernetesVersion,
    vmSize: a.vmSize,
    desiredNodes: a.desiredNodes,
    minNodes: a.minNodes,
    maxNodes: a.maxNodes,
    resourceGroup: a.resourceGroup,
    createResourceGroup: a.createResourceGroup,
    vnetSubnetId: a.vnetSubnetId?.trim() || undefined,
    // Production options.
    environment: a.environment,
    team: a.team,
    costCenter: a.costCenter,
    skuTier: a.skuTier,
    zones: a.zones,
    automaticUpgrade: a.automaticUpgrade,
    networkPolicy: a.networkPolicy,
    serviceCidr: a.serviceCidr,
    dnsServiceIp: a.dnsServiceIp,
    privateCluster: a.privateCluster,
    authorizedIpRanges: a.authorizedIpRanges,
    azureRbac: a.azureRbac,
    disableLocalAccounts: a.disableLocalAccounts,
    workloadIdentity: a.workloadIdentity,
    azurePolicy: a.azurePolicy,
    systemDiskSize: a.systemDiskSize,
    systemOsDiskType: a.systemOsDiskType,
    systemMaxPods: a.systemMaxPods,
    appNodePool: a.appNodePool,
    appVmSize: a.appVmSize,
    appSpot: a.appSpot,
    appMinNodes: a.appMinNodes,
    appMaxNodes: a.appMaxNodes,
    monitoring: a.monitoring,
    keyVaultSecretsProvider: a.keyVaultSecretsProvider,
    kedaVpa: a.kedaVpa,
  };

  // Remote state (Azure): read from the env's stored backend if one is set on
  // the Connection page. Nothing to persist here — the state fields live on
  // the env, updated only via the tf-backend endpoint. Blank fields fall back
  // to local state.
  if (a.envKey) {
    const env = await envBySlugAndKey(gate.access.project.id, a.envKey);
    if (env?.tfBackendAzureStorageAccount && env.tfBackendAzureContainer) {
      spec.stateResourceGroup = env.tfBackendAzureResourceGroup ?? undefined;
      spec.stateStorageAccount = env.tfBackendAzureStorageAccount;
      spec.stateContainer = env.tfBackendAzureContainer;
    }
  }

  const files = buildAksTerraform(spec);

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "aks.terraform_generated",
    targetType: "aks_cluster",
    targetId: `${slug}/${a.name}`,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { resourceGroup: a.resourceGroup, location: a.location, version: a.kubernetesVersion, vmSize: a.vmSize },
  });

  return NextResponse.json({
    ok: true,
    clusterName: a.name,
    location: a.location,
    fileCount: Object.keys(files).length,
    files,
    hasRemoteState: !!(spec.stateStorageAccount && spec.stateContainer),
  });
}
