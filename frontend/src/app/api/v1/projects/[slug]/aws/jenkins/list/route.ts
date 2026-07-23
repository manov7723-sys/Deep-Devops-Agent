import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";

/**
 * GET /projects/[slug]/aws/jenkins/list
 *
 * Lists every Jenkins provisioning approval (stack prefix `jenkins-`). Same
 * dedupe-by-stack pattern as the Client VPN list — retries create fresh
 * approvals, but they all point at the same S3 state, so we surface only
 * the newest per stack.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const rows = await prisma.approval.findMany({
    where: { projectId: gate.access.project.id, kind: "terraform" },
    select: {
      id: true,
      title: true,
      status: true,
      requestedAt: true,
      appliedAt: true,
      payloadJson: true,
      env: { select: { key: true, name: true } },
    },
    orderBy: { requestedAt: "desc" },
    take: 50,
  });

  const bestByStack = new Map<
    string,
    {
      approvalId: string;
      name: string;
      stack: string;
      title: string;
      status: string;
      envKey: string;
      envName: string;
      requestedAt: string;
      appliedAt: string | null;
    }
  >();
  for (const r of rows) {
    const p = (r.payloadJson ?? {}) as { stack?: string; envKey?: string };
    const stack = typeof p.stack === "string" ? p.stack : "";
    if (!stack.startsWith("jenkins-")) continue;
    const envKey = r.env?.key ?? p.envKey ?? "";
    const dedupKey = `${envKey}::${stack}`;
    if (bestByStack.has(dedupKey)) continue;
    bestByStack.set(dedupKey, {
      approvalId: r.id,
      name: stack.slice("jenkins-".length),
      stack,
      title: r.title,
      status: r.status,
      envKey,
      envName: r.env?.name ?? "",
      requestedAt: r.requestedAt.toISOString(),
      appliedAt: r.appliedAt?.toISOString() ?? null,
    });
  }
  return NextResponse.json({ ok: true, items: [...bestByStack.values()] });
}
