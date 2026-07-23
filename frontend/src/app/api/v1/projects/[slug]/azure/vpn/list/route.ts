import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";

/**
 * GET /projects/[slug]/azure/vpn/list
 *
 * Lists every Azure OpenVPN endpoint (stack prefix `azure-vpn-`) approved in
 * this project. Same shape as /aws/client-vpn/list and /gcp/vpn/list.
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
    if (!stack.startsWith("azure-vpn-")) continue;
    const envKey = r.env?.key ?? p.envKey ?? "";
    const dedupKey = `${envKey}::${stack}`;
    if (bestByStack.has(dedupKey)) continue;
    bestByStack.set(dedupKey, {
      approvalId: r.id,
      name: stack.slice("azure-vpn-".length),
      stack,
      title: r.title,
      status: r.status,
      envKey,
      envName: r.env?.name ?? "",
      requestedAt: r.requestedAt.toISOString(),
      appliedAt: r.appliedAt?.toISOString() ?? null,
    });
  }
  const items = [...bestByStack.values()];

  return NextResponse.json({ ok: true, items });
}
