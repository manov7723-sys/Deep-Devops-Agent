import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { prisma } from "@/lib/db/prisma";

/**
 * Notification email recipients for a project (in addition to project members).
 *   GET → { emails: string[] }
 *   PUT { emails: string[] } → replace the list
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const p = await prisma.project.findUnique({ where: { id: gate.access.project.id }, select: { alertEmails: true } });
  return NextResponse.json({ ok: true, emails: p?.alertEmails ?? [] });
}

const Body = z.object({
  emails: z.array(z.string().trim().email()).max(50),
});

export async function PUT(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) return NextResponse.json({ ok: false, code: "invalid_request", message: parsed.error.issues[0]?.message }, { status: 400 });
  const emails = [...new Set(parsed.data.emails.map((e) => e.toLowerCase()))];
  await prisma.project.update({ where: { id: gate.access.project.id }, data: { alertEmails: emails } });
  return NextResponse.json({ ok: true, emails });
}
