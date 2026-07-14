import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { SetTfBackendRequest } from "@/lib/api/schemas/connectivity-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { setEnvAzureBackend, setEnvGcsBackend, setEnvTfBackend } from "@/lib/devops/envs";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * Current Terraform remote-state backend for the env. Returns all three
 * shapes so the UI can render the right form based on `cloudKind`:
 *   • AWS: bucket + region + table (S3)
 *   • GCP: gcsBucket (GCS — no separate lock table)
 *   • Azure: azureResourceGroup + azureStorageAccount + azureContainer
 * cloudKind is derived from the env's attached CloudProvider row.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const env = await prisma.env.findUnique({
    where: { projectId_key: { projectId: gate.access.project.id, key } },
    select: {
      tfBackendBucket: true,
      tfBackendRegion: true,
      tfBackendTable: true,
      tfBackendGcsBucket: true,
      tfBackendAzureResourceGroup: true,
      tfBackendAzureStorageAccount: true,
      tfBackendAzureContainer: true,
      cloudProvider: { select: { kind: true } },
    },
  });
  if (!env) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
  return NextResponse.json({
    bucket: env.tfBackendBucket,
    region: env.tfBackendRegion,
    table: env.tfBackendTable,
    gcsBucket: env.tfBackendGcsBucket,
    azureResourceGroup: env.tfBackendAzureResourceGroup,
    azureStorageAccount: env.tfBackendAzureStorageAccount,
    azureContainer: env.tfBackendAzureContainer,
    cloudKind: env.cloudProvider?.kind ?? null,
  });
}

/**
 * Set the remote-state backend. Body shape is discriminated:
 *   { bucket, region, table? }                              → S3 (AWS)
 *   { gcsBucket }                                            → GCS (GCP)
 *   { azureResourceGroup, azureStorageAccount, azureContainer } → Azure
 */
export async function PUT(req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const parsed = SetTfBackendRequest.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }

  const meta = extractRequestMeta(req);
  const auditTail = {
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "env.tf_backend_set" as const,
    targetType: "env" as const,
    targetId: `${slug}/${key}`,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
  };

  if ("gcsBucket" in parsed.data) {
    const res = await setEnvGcsBackend(gate.access.project.id, key, {
      bucket: parsed.data.gcsBucket,
    });
    if (!res.ok) return NextResponse.json({ ok: false, code: res.code }, { status: 404 });
    await audit({ ...auditTail, metadata: { gcsBucket: parsed.data.gcsBucket } });
    return NextResponse.json({ ok: true, backend: res.backend });
  }

  if ("azureStorageAccount" in parsed.data) {
    const res = await setEnvAzureBackend(gate.access.project.id, key, {
      resourceGroup: parsed.data.azureResourceGroup,
      storageAccount: parsed.data.azureStorageAccount,
      container: parsed.data.azureContainer,
    });
    if (!res.ok) return NextResponse.json({ ok: false, code: res.code }, { status: 404 });
    await audit({
      ...auditTail,
      metadata: {
        azureStorageAccount: parsed.data.azureStorageAccount,
        azureContainer: parsed.data.azureContainer,
      },
    });
    return NextResponse.json({ ok: true, backend: res.backend });
  }

  const res = await setEnvTfBackend(gate.access.project.id, key, parsed.data);
  if (!res.ok) return NextResponse.json({ ok: false, code: res.code }, { status: 404 });
  await audit({
    ...auditTail,
    metadata: { bucket: parsed.data.bucket, region: parsed.data.region },
  });
  return NextResponse.json({ ok: true, backend: res.backend });
}
