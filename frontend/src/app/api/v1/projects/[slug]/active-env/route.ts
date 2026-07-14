import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { listEnvs } from "@/lib/devops/envs";

/**
 * The project's ACTIVE environment — env-scoped pages default to it.
 *   GET → { activeEnvKey }
 *   PUT { envKey } → set it (envKey must be one of the project's envs; null clears)
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const p = await prisma.project.findUnique({
    where: { id: gate.access.project.id },
    select: { activeEnvKey: true },
  });
  return NextResponse.json({ ok: true, activeEnvKey: p?.activeEnvKey ?? null });
}

const Body = z.object({ envKey: z.string().trim().min(1).nullable() });

export async function PUT(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json(
      { ok: false, message: parsed.error.issues[0]?.message },
      { status: 400 },
    );

  const envKey = parsed.data.envKey;
  if (envKey) {
    const envs = await listEnvs(gate.access.project.id);
    if (!envs.some((e) => e.key === envKey))
      return NextResponse.json(
        { ok: false, message: `Env "${envKey}" not found in this project.` },
        { status: 400 },
      );
  }
  await prisma.project.update({
    where: { id: gate.access.project.id },
    data: { activeEnvKey: envKey },
  });
  return NextResponse.json({ ok: true, activeEnvKey: envKey });
}
