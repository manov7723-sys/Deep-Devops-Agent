import { NextResponse } from "next/server";
import { CreateGkeRequest } from "@/lib/api/schemas/connectivity-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import {
  buildGkeTerraform,
  GKE_DEFAULTS,
  GKE_MACHINE_TYPES,
  GKE_K8S_VERSIONS,
  GKE_DISK_TYPES,
  GKE_DISK_SIZES,
  type GkeSpec,
} from "@/lib/devops/gke";
import { envBySlugAndKey, setEnvGcsBackend } from "@/lib/devops/envs";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/** Form defaults + option lists for the GKE creation form. */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  return NextResponse.json({
    defaults: GKE_DEFAULTS,
    machineTypes: GKE_MACHINE_TYPES,
    kubernetesVersions: GKE_K8S_VERSIONS,
    diskTypes: GKE_DISK_TYPES,
    diskSizes: GKE_DISK_SIZES,
  });
}

/** Generate the GKE Terraform tree from the wizard answers. */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = CreateGkeRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const a = parsed.data;
  if (a.maxNodes < a.minNodes || a.desiredNodes < a.minNodes || a.desiredNodes > a.maxNodes) {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid_request",
        message: "Node counts must satisfy min ≤ desired ≤ max.",
      },
      { status: 400 },
    );
  }
  if (a.createNetwork === false && !a.existingNetwork?.trim()) {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid_request",
        message: "Provide an existing network name when not creating a new VPC.",
      },
      { status: 400 },
    );
  }

  const spec: GkeSpec = {
    name: a.name,
    project: a.project,
    location: a.location,
    kubernetesVersion: a.kubernetesVersion,
    machineType: a.machineType,
    desiredNodes: a.desiredNodes,
    minNodes: a.minNodes,
    maxNodes: a.maxNodes,
    privateNodes: a.privateNodes,
    createNetwork: a.createNetwork,
    existingNetwork: a.existingNetwork,
    existingSubnetwork: a.existingSubnetwork,
    // Production options.
    environment: a.environment,
    team: a.team,
    costCenter: a.costCenter,
    releaseChannel: a.releaseChannel,
    privateEndpoint: a.privateEndpoint,
    masterAuthorizedCidrs: a.masterAuthorizedCidrs,
    dataplaneV2: a.dataplaneV2,
    workloadIdentity: a.workloadIdentity,
    shieldedNodes: a.shieldedNodes,
    binaryAuthorization: a.binaryAuthorization,
    intranodeVisibility: a.intranodeVisibility,
    gatewayApi: a.gatewayApi,
    cloudDns: a.cloudDns,
    monitoring: a.monitoring,
    httpLoadBalancing: a.httpLoadBalancing,
    backupAgent: a.backupAgent,
    configConnector: a.configConnector,
    systemDiskType: a.systemDiskType,
    systemDiskSize: a.systemDiskSize,
    appNodePool: a.appNodePool,
    appMachineType: a.appMachineType,
    appSpot: a.appSpot,
    appMinNodes: a.appMinNodes,
    appMaxNodes: a.appMaxNodes,
  };

  // Remote state (GCS): prefer a bucket entered on this form (persist it onto
  // the env so future GKE creates reuse it), else fall back to whatever the
  // env already has. Matches the EKS S3-backend flow.
  if (a.envKey && a.stateBucket?.trim()) {
    spec.stateBucket = a.stateBucket.trim();
    await setEnvGcsBackend(gate.access.project.id, a.envKey, { bucket: spec.stateBucket }).catch(
      () => {},
    );
  } else if (a.envKey) {
    const env = await envBySlugAndKey(gate.access.project.id, a.envKey);
    if (env?.tfBackendGcsBucket) {
      spec.stateBucket = env.tfBackendGcsBucket;
    }
  }

  const files = buildGkeTerraform(spec);

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "gke.terraform_generated",
    targetType: "gke_cluster",
    targetId: `${slug}/${a.name}`,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: {
      project: a.project,
      location: a.location,
      version: a.kubernetesVersion,
      machineType: a.machineType,
    },
  });

  return NextResponse.json({
    ok: true,
    clusterName: a.name,
    location: a.location,
    fileCount: Object.keys(files).length,
    files,
    hasRemoteState: !!spec.stateBucket,
  });
}
