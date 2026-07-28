import { NextResponse } from "next/server";
import { CreateEksRequest } from "@/lib/api/schemas/connectivity-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey, setEnvTfBackend } from "@/lib/devops/envs";
import { detectAwsCallerIdentity } from "@/lib/cloud/aws-onboard";
import {
  buildEksTerraform,
  EKS_DEFAULTS,
  EKS_INSTANCE_TYPES,
  EKS_K8S_VERSIONS,
  EKS_DISK_SIZES,
  EKS_CAPACITY_TYPES,
  EKS_ACCESS_POLICIES,
  type EksSpec,
} from "@/lib/devops/eks";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/** Form defaults + option lists for the EKS creation form. */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  return NextResponse.json({
    defaults: EKS_DEFAULTS,
    instanceTypes: EKS_INSTANCE_TYPES,
    kubernetesVersions: EKS_K8S_VERSIONS,
    diskSizes: EKS_DISK_SIZES,
    capacityTypes: EKS_CAPACITY_TYPES,
    accessPolicies: EKS_ACCESS_POLICIES,
  });
}

/** Generate the EKS Terraform tree from the wizard answers. */
export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = CreateEksRequest.safeParse(await req.json().catch(() => ({})));
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
  // Per-node-group scaling check (each row of the multi-group array).
  for (const g of a.nodeGroups ?? []) {
    if (g.maxNodes < g.minNodes || g.desiredNodes < g.minNodes || g.desiredNodes > g.maxNodes) {
      return NextResponse.json(
        {
          ok: false,
          code: "invalid_request",
          message: `Node group "${g.name}": min ≤ desired ≤ max.`,
        },
        { status: 400 },
      );
    }
  }
  if (a.createVpc === false && !a.existingVpcId?.trim()) {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid_request",
        message: "Provide an existing VPC id when not creating a new VPC.",
      },
      { status: 400 },
    );
  }

  const spec: EksSpec = {
    name: a.name,
    region: a.region,
    kubernetesVersion: a.kubernetesVersion,
    instanceType: a.instanceType,
    desiredNodes: a.desiredNodes,
    minNodes: a.minNodes,
    maxNodes: a.maxNodes,
    endpointPublic: a.endpointPublic,
    createVpc: a.createVpc,
    existingVpcId: a.existingVpcId,
    existingSubnetIds: a.existingSubnetIds,
    nodeSubnetIds: a.nodeSubnetIds,
    // Production options.
    environment: a.environment,
    team: a.team,
    costCenter: a.costCenter,
    publicAccessCidrs: a.publicAccessCidrs,
    controlPlaneLogs: a.controlPlaneLogs,
    secretsEncryption: a.secretsEncryption,
    systemDiskSize: a.systemDiskSize,
    ebsCsi: a.ebsCsi,
    nodeGroupName: a.nodeGroupName,
    capacityType: a.capacityType,
    nodeGroups: a.nodeGroups,
    appNodeGroup: a.appNodeGroup,
    appInstanceTypes: a.appInstanceTypes,
    appCapacityType: a.appCapacityType,
    appMinNodes: a.appMinNodes,
    appMaxNodes: a.appMaxNodes,
    appDesiredNodes: a.appDesiredNodes,
    accessEntries: a.accessEntries,
  };

  // Auto-add the caller's IAM USER to Access Entries so the customer can view
  // the cluster in the AWS console. `enable_cluster_creator_admin_permissions`
  // in the EKS Terraform module only covers the identity that RAN Terraform —
  // i.e. DeepAgent's stored role (agent-role1213 etc.) — NOT the customer's
  // personal AWS console login. Without this step, the customer opens the
  // EKS console and hits "your IAM principal doesn't have access to K8s
  // objects" on a cluster they just created.
  //
  // Skips silently when:
  //   - the caller is already a ROLE (DeepAgent's own role — Terraform
  //     handles that path itself)
  //   - the caller is :root (adding root as an Access Entry is dangerous
  //     and pointless — root implicitly has cluster access already)
  //   - the user already listed the same ARN in the wizard's "Additional
  //     users/roles" field (avoid duplicate access-entry errors)
  //   - AWS creds can't be resolved (offline dev, missing env — this is a
  //     UX enhancement, never a hard requirement)
  if (a.envKey) {
    const env = await envBySlugAndKey(gate.access.project.id, a.envKey);
    if (env?.cloudProviderId) {
      const who = await detectAwsCallerIdentity(env.cloudProviderId);
      // Helper to append an entry if not already present.
      const addEntry = (arn: string) => {
        const already = (spec.accessEntries ?? []).some(
          (e) => e.principalArn.trim().toLowerCase() === arn.toLowerCase(),
        );
        if (!already) {
          spec.accessEntries = [
            ...(spec.accessEntries ?? []),
            { principalArn: arn, policy: "AmazonEKSClusterAdminPolicy" },
          ];
        }
      };
      // IMPORTANT: we do NOT auto-add the connected IAM user here. The
      // Terraform module already sets `enable_cluster_creator_admin_permissions
      // = true` which creates an Access Entry for whoever ran Terraform (the
      // connected creds). Adding a second explicit entry for the same ARN
      // makes AWS return 409 ResourceInUseException and the apply fails
      // partway through — leaving a half-built cluster. The IAM user always
      // has admin regardless of the wizard toggle; keep the toggle in the UI
      // only for teammates (via the "Additional users/roles" list) and for
      // the root-user branch below.
      // Root toggle (default OFF) — flip when the customer signs into the
      // console as root. Root is NEVER the identity Terraform runs as, so
      // this doesn't collide with enable_cluster_creator_admin_permissions.
      if (a.grantRootAccess && who.ok) {
        addEntry(`arn:aws:iam::${who.accountId}:root`);
      }
    }
  }

  // Remote state: prefer a bucket entered on this form (and persist it onto the
  // env for future creates), else fall back to whatever the env already has.
  if (a.envKey && a.stateBucket?.trim()) {
    const backend = {
      bucket: a.stateBucket.trim(),
      region: a.region,
      table: a.stateTable?.trim() || undefined,
    };
    spec.stateBucket = backend.bucket;
    spec.stateRegion = backend.region;
    spec.stateTable = backend.table;
    await setEnvTfBackend(gate.access.project.id, a.envKey, backend).catch(() => {});
  } else if (a.envKey) {
    const env = await envBySlugAndKey(gate.access.project.id, a.envKey);
    if (env?.tfBackendBucket) {
      spec.stateBucket = env.tfBackendBucket;
      spec.stateRegion = env.tfBackendRegion ?? a.region;
      spec.stateTable = env.tfBackendTable ?? undefined;
    }
  }

  const files = buildEksTerraform(spec);

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "eks.terraform_generated",
    targetType: "eks_cluster",
    targetId: `${slug}/${a.name}`,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { region: a.region, version: a.kubernetesVersion, instanceType: a.instanceType },
  });

  return NextResponse.json({
    ok: true,
    clusterName: a.name,
    region: a.region,
    fileCount: Object.keys(files).length,
    files,
    hasRemoteState: !!spec.stateBucket,
  });
}
