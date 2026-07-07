import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { listDeployTargets, prefillFromRepo } from "@/lib/devops/deploy";

/**
 * POST /projects/[slug]/deploy/prepare
 * Returns the deployable environments (those with a cluster wired) and, if a
 * repo is given, best-effort suggestions (app name + port) from its stack.
 */
const Body = z.object({ repoFullName: z.string().trim().min(3).optional() });

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  const repoFullName = parsed.success ? parsed.data.repoFullName : undefined;

  const [targets, prefill] = await Promise.all([
    listDeployTargets(gate.access.project.id),
    repoFullName ? prefillFromRepo(gate.access.project.id, repoFullName) : Promise.resolve(null),
  ]);

  return NextResponse.json({ ok: true, targets, prefill });
}
