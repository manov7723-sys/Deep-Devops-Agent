import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { createRdsK8sSecretTool } from "@/lib/agent/tools/rds-tools";
import { applyK8sManifestTool } from "@/lib/agent/tools/apply-k8s-manifest";

/**
 * POST /projects/[slug]/aws/rds-connect
 *
 * The Connections page's submit action — same shape as the chat playbook's
 * "connect_existing_rds" flow, but driven from a real UI:
 *   1. Build the K8s Secret from the form values (via createRdsK8sSecretTool).
 *   2. Apply the manifest to the env's connected cluster (via applyK8sManifestTool).
 *   3. Return the applied Secret's name + namespace + kubectl output so the UI
 *      can show what happened.
 *
 * The tool code paths are the same the chat agent uses — the UI is just a
 * different entry point. Placeholder / empty inputs are rejected inside the
 * tool (see createRdsK8sSecretTool).
 */
const Body = z.object({
  envKey: z.string().trim().min(1),
  namespace: z.string().trim().min(1),
  secretName: z
    .string()
    .trim()
    .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, "Secret name must be DNS-1123 (lowercase, dashes)."),
  host: z.string().trim().min(1),
  port: z.number().int().positive().max(65535),
  database: z.string().trim().min(1),
  username: z.string().trim().min(1),
  password: z.string().min(1),
  engine: z.enum(["postgres", "mysql"]).optional(),
  alsoStoreInAppSecret: z.boolean().optional(),
  appSecretKey: z.string().trim().optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const body = parsed.data;
  const toolCtx = { projectId: gate.access.project.id, userId: gate.access.session.userId };

  // Step 1: build the Secret YAML. The tool validates against placeholders +
  // empty values and rejects with a helpful message — surface that as a 400.
  const built = await createRdsK8sSecretTool.execute(
    {
      envKey: body.envKey,
      namespace: body.namespace,
      secretName: body.secretName,
      host: body.host,
      port: body.port,
      database: body.database,
      username: body.username,
      password: body.password,
      engine: body.engine,
      alsoStoreInAppSecret: body.alsoStoreInAppSecret,
      appSecretKey: body.appSecretKey,
    },
    toolCtx,
  );
  if (!built.ok) {
    return NextResponse.json(
      { ok: false, code: "secret_build_failed", message: built.error },
      { status: 400 },
    );
  }

  // Step 2: apply the manifest to the env's connected cluster. If the env has
  // no cluster, the apply tool returns a clear "connect a cluster first"
  // message — bubble it up as 409 so the UI can suggest the fix.
  const applied = await applyK8sManifestTool.execute(
    {
      envKey: body.envKey,
      manifest: built.output.manifest,
      namespace: body.namespace,
    },
    toolCtx,
  );
  if (!applied.ok) {
    return NextResponse.json(
      {
        ok: false,
        code: "apply_failed",
        message: applied.error,
        manifest: built.output.manifest, // still return YAML so user can retry manually
      },
      { status: 409 },
    );
  }

  return NextResponse.json({
    ok: true,
    secretName: built.output.secretName,
    namespace: built.output.namespace,
    keysWritten: built.output.keysWritten,
    appSecretKey: built.output.appSecretKey,
    kubectl: {
      command: applied.output.command,
      stdout: applied.output.stdout,
    },
    note: built.output.note,
  });
}
