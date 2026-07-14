import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { syncSecretsToCluster } from "@/lib/integrations/secrets-store";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * POST /projects/[slug]/secrets/sync { envKey }
 * Push the project's secrets to the env's cluster as one Kubernetes Secret.
 */
const Body = z.object({ envKey: z.string().trim().min(1) });

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok)
    return NextResponse.json({ ok: false, code: `status_${gate.status}` }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: "envKey is required." },
      { status: 400 },
    );

  const res = await syncSecretsToCluster(
    { projectId: gate.access.project.id, userId: gate.access.session.userId },
    parsed.data.envKey,
  );
  if (!res.ok) return NextResponse.json({ ok: false, message: res.error }, { status: 400 });

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "deployment.applied",
    targetType: "secret",
    targetId: `app-secrets@${parsed.data.envKey}`,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { secretCount: res.count, namespace: res.namespace },
  });

  return NextResponse.json(res);
}
