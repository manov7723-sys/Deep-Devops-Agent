import { NextResponse } from "next/server";
import { SetTfBackendRequest } from "@/lib/api/schemas/connectivity-api";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey, setEnvTfBackend } from "@/lib/devops/envs";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/** Current Terraform remote-state backend (S3 + DynamoDB lock) for the env. */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const env = await envBySlugAndKey(gate.access.project.id, key);
  if (!env) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
  return NextResponse.json({
    bucket: env.tfBackendBucket,
    region: env.tfBackendRegion,
    table: env.tfBackendTable,
  });
}

/** Set the S3 state bucket / region / lock table for the env. */
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
  const res = await setEnvTfBackend(gate.access.project.id, key, parsed.data);
  if (!res.ok) return NextResponse.json({ ok: false, code: res.code }, { status: 404 });

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "env.tf_backend_set",
    targetType: "env",
    targetId: `${slug}/${key}`,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { bucket: parsed.data.bucket, region: parsed.data.region },
  });
  return NextResponse.json({ ok: true, backend: res.backend });
}
