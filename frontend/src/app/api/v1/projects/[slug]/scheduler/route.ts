import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { listDeployTargets } from "@/lib/devops/deploy";
import { scheduleDeploy, listScheduledDeploys } from "@/lib/devops/scheduled-deploy";

/**
 * Scheduled deployments for a project (the UI counterpart to the agent's
 * schedule_deployment tool — works without the LLM).
 *   GET  → scheduled deploys + the deployable envs (for the create form).
 *   POST { envKey, appName, image, runAt, ... } → schedule one.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const [scheduled, targets] = await Promise.all([
    listScheduledDeploys(gate.access.project.id),
    listDeployTargets(gate.access.project.id),
  ]);
  return NextResponse.json({ ok: true, scheduled, targets });
}

const Body = z.object({
  envKey: z.string().trim().min(1),
  appName: z.string().trim().min(1).max(63),
  image: z.string().trim().min(1),
  runAt: z.string().trim().min(1), // ISO 8601 from the client (datetime-local → ISO)
  containerPort: z.number().int().min(1).max(65535).default(8080),
  replicas: z.number().int().min(1).max(50).default(1),
  expose: z.boolean().default(false),
  host: z.string().trim().optional(),
  namespace: z.string().trim().optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ ok: false, code: "invalid_request", message: parsed.error.issues[0]?.message }, { status: 400 });
  const b = parsed.data;

  const runAt = new Date(b.runAt);
  if (Number.isNaN(runAt.getTime())) return NextResponse.json({ ok: false, message: "Invalid run time." }, { status: 400 });
  if (runAt.getTime() <= Date.now() + 30_000) return NextResponse.json({ ok: false, message: "The scheduled time must be in the future." }, { status: 400 });
  if (b.expose && !(b.host || "").trim()) return NextResponse.json({ ok: false, message: "A host is required to expose the app publicly." }, { status: 400 });

  const targets = await listDeployTargets(gate.access.project.id);
  const target = targets.find((t) => t.envKey === b.envKey);
  if (!target) return NextResponse.json({ ok: false, message: `No deployable env "${b.envKey}". Connect a cluster first.` }, { status: 400 });

  const sd = await scheduleDeploy(gate.access.project.id, gate.access.session.userId, {
    envKey: target.envKey,
    appName: b.appName,
    image: b.image,
    containerPort: b.containerPort,
    replicas: b.replicas,
    expose: b.expose,
    host: b.host,
    namespace: (b.namespace || "").trim() || target.namespace,
  }, runAt);

  return NextResponse.json({ ok: true, scheduled: sd });
}
