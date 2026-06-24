import { NextResponse } from "next/server";
import { CreateEksRequest } from "@/lib/api/schemas/connectivity-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import {
  buildEksTerraform,
  EKS_DEFAULTS,
  EKS_INSTANCE_TYPES,
  EKS_K8S_VERSIONS,
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
      { ok: false, code: "invalid_request", message: "Node counts must satisfy min ≤ desired ≤ max." },
      { status: 400 },
    );
  }
  if (a.createVpc === false && !a.existingVpcId?.trim()) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: "Provide an existing VPC id when not creating a new VPC." },
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
  };

  // If the chosen env has an S3 backend, wire the cluster's remote state to it.
  if (a.envKey) {
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
