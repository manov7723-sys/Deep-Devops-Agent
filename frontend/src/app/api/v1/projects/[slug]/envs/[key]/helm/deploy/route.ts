import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { runHelmUpgradeTool } from "@/lib/agent/tools/run-helm-upgrade";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * POST /projects/[slug]/envs/[key]/helm/deploy
 *
 * Deploy a Helm chart that already lives in an attached repo via
 * `helm upgrade --install`. Thin wrapper over the agent's run_helm_upgrade tool
 * so the static Helm chart builder's "Deploy" button runs the exact same path
 * (kubeconfig + EKS exec-plugin auth + rollout wait) as the AI chat.
 */
const Body = z.object({
  repoFullName: z.string().trim().min(3),
  chartPath: z.string().trim().max(280),
  releaseName: z.string().trim().min(1).max(120),
  imageRepository: z.string().trim().max(280).optional(),
  imageTag: z.string().trim().max(120).optional(),
  ref: z.string().trim().max(200).optional(),
  timeoutSeconds: z.number().int().positive().max(3600).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }

  const toolCtx = { projectId: gate.access.project.id, userId: gate.access.session.userId };
  const res = await runHelmUpgradeTool.execute({ envKey: key, ...parsed.data }, toolCtx);
  if (!res.ok) {
    return NextResponse.json(
      { ok: false, code: "deploy_failed", message: res.error },
      { status: 400 },
    );
  }

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "deployment.triggered",
    targetType: "env",
    targetId: key,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: {
      releaseName: parsed.data.releaseName,
      chartPath: parsed.data.chartPath,
      via: "helm_builder",
    },
  });

  return NextResponse.json({ ok: true, result: res.output });
}
