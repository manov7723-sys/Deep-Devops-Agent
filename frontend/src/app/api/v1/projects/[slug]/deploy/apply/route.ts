import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { listDeployTargets, runDeploy } from "@/lib/devops/deploy";
import { createDeployApproval } from "@/lib/devops/deploy-approval";
import type { DeploySpec } from "@/lib/devops/deploy-manifest";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * POST /projects/[slug]/deploy/apply
 * Build the Deployment/Service(/Ingress) manifest and apply it to the target
 * env's cluster. Set dryRun for a server-side validation that changes nothing.
 */
const Body = z.object({
  envKey: z.string().trim().min(1),
  appName: z.string().trim().min(1).max(63),
  image: z.string().trim().min(1).max(400),
  namespace: z.string().trim().max(63).optional(),
  replicas: z.number().int().min(1).max(50).default(1),
  containerPort: z.number().int().min(1).max(65535).default(8080),
  env: z.array(z.object({ key: z.string(), value: z.string() })).max(100).default([]),
  expose: z.boolean().default(false),
  host: z.string().trim().max(253).optional(),
  servicePort: z.number().int().min(1).max(65535).optional(),
  dryRun: z.boolean().default(false),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false, code: `status_${gate.status}` }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: "invalid_request", message: parsed.error.issues[0]?.message }, { status: 400 });
  }
  const b = parsed.data;

  const targets = await listDeployTargets(gate.access.project.id);
  const target = targets.find((t) => t.envKey === b.envKey);
  if (!target) {
    return NextResponse.json({ ok: false, code: "env_not_deployable", message: "That environment has no cluster connected." }, { status: 400 });
  }
  if (b.expose && !(b.host || "").trim()) {
    return NextResponse.json({ ok: false, code: "host_required", message: "A host is required to expose the app publicly." }, { status: 400 });
  }

  const namespace = (b.namespace || "").trim() || target.namespace;
  const spec: DeploySpec = {
    appName: b.appName,
    image: b.image,
    namespace,
    replicas: b.replicas,
    containerPort: b.containerPort,
    env: b.env,
    expose: b.expose,
    host: b.host,
    servicePort: b.servicePort,
  };

  // dryRun = validate against the cluster now (no approval, no change).
  if (b.dryRun) {
    const result = await runDeploy(
      { projectId: gate.access.project.id, userId: gate.access.session.userId },
      { envKey: target.envKey, envId: target.envId, namespace },
      spec,
      { dryRun: true },
    );
    if (!result.ok) return NextResponse.json({ ok: false, code: "deploy_failed", message: result.error }, { status: 400 });
    return NextResponse.json({ ...result, namespace, appName: spec.appName, envKey: target.envKey });
  }

  // Real deploy → APPROVAL GATE. Create a pending approval; the deploy runs when a human approves it.
  const { approvalId, risk } = await createDeployApproval(
    gate.access.project.id,
    { envKey: target.envKey, envId: target.envId, namespace, isProduction: target.isProduction },
    spec,
    "manual",
  );
  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "approval.created",
    targetType: "approval",
    targetId: approvalId,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { image: spec.image, namespace, envKey: target.envKey, risk },
  });

  return NextResponse.json({
    ok: true,
    pendingApproval: true,
    approvalId,
    risk,
    namespace,
    appName: spec.appName,
    envKey: target.envKey,
    message: `Deploy submitted for approval — approve it on the Approvals page to run it.`,
  });
}
