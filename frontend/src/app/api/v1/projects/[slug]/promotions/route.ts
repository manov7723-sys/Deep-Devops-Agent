import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { getPromotionMatrix, promoteApp } from "@/lib/devops/promotion";

/**
 * Environment promotion.
 *   GET  → the app × env version matrix (what's deployed where).
 *   POST { appName, fromEnvKey, toEnvKey } → promote that version to the target env
 *          as a PENDING deploy approval.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const namespace = new URL(req.url).searchParams.get("namespace") || undefined;
  const matrix = await getPromotionMatrix(gate.access.project.id, namespace);
  return NextResponse.json({ ok: true, ...matrix });
}

const Body = z.object({
  appName: z.string().trim().min(1),
  fromEnvKey: z.string().trim().min(1),
  toEnvKey: z.string().trim().min(1),
  namespace: z.string().trim().optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json(
      { ok: false, message: parsed.error.issues[0]?.message },
      { status: 400 },
    );

  const res = await promoteApp(
    gate.access.project.id,
    parsed.data.appName,
    parsed.data.fromEnvKey,
    parsed.data.toEnvKey,
    parsed.data.namespace,
  );
  if (!res.ok) return NextResponse.json({ ok: false, message: res.error }, { status: 400 });
  return NextResponse.json({
    ok: true,
    pendingApproval: true,
    approvalId: res.approvalId,
    message: `Promotion of ${parsed.data.appName} (${res.image}) to ${parsed.data.toEnvKey} was submitted for approval — approve it on the Approvals page to deploy.`,
  });
}
