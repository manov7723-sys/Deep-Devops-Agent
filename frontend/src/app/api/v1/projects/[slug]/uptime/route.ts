import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { prisma } from "@/lib/db/prisma";

/**
 * Uptime monitors for a project.
 *   GET  → monitors (with recent checks for a sparkline)
 *   POST { name, url, expectedStatus?, intervalSec? } → create
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const monitors = await prisma.uptimeMonitor.findMany({
    where: { projectId: gate.access.project.id },
    orderBy: { createdAt: "asc" },
    include: {
      checks: {
        orderBy: { at: "desc" },
        take: 20,
        select: { at: true, ok: true, latencyMs: true, status: true },
      },
    },
  });
  return NextResponse.json({ ok: true, monitors });
}

const Body = z.object({
  name: z.string().trim().min(1).max(80),
  url: z
    .string()
    .trim()
    .url()
    .refine((u) => /^https?:\/\//.test(u), "Must be an http(s) URL."),
  method: z.enum(["GET", "HEAD"]).default("GET"),
  expectedStatus: z.number().int().min(100).max(599).default(200),
  intervalSec: z.number().int().min(30).max(86400).default(300),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  const m = await prisma.uptimeMonitor.create({
    data: { projectId: gate.access.project.id, ...parsed.data },
  });
  return NextResponse.json({ ok: true, monitor: m });
}
