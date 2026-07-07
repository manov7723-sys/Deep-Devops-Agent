import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { writeCdFilesTool } from "@/lib/agent/tools/deploy-tools";

/**
 * POST /projects/[slug]/deploy/cd-files
 * Write the CD files (k8s/manifest.yaml + .github/workflows/deploy.yml) into the
 * repo and open a PR. Shares the exact agent tool so UI and agent behave alike.
 */
const Body = z.object({
  repoFullName: z.string().trim().min(3),
  envKey: z.string().trim().min(1),
  appName: z.string().trim().min(1).max(63),
  image: z.string().trim().min(1).max(400),
  containerPort: z.number().int().min(1).max(65535).optional(),
  replicas: z.number().int().min(1).max(50).optional(),
  env: z.array(z.object({ key: z.string(), value: z.string() })).max(100).optional(),
  expose: z.boolean().optional(),
  host: z.string().trim().max(253).optional(),
  namespace: z.string().trim().max(63).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false, code: `status_${gate.status}` }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: "invalid_request", message: parsed.error.issues[0]?.message }, { status: 400 });
  }

  const res = await writeCdFilesTool.execute(parsed.data, {
    projectId: gate.access.project.id,
    userId: gate.access.session.userId,
  });
  if (!res.ok) return NextResponse.json({ ok: false, message: res.error }, { status: 400 });
  return NextResponse.json({ ok: true, ...res.output });
}
