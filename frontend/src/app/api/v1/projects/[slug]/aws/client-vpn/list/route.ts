import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";

/**
 * GET /projects/[slug]/aws/client-vpn/list
 *
 * Lists every Client VPN that's been approved (and probably applied) in this
 * project. Powers the sidebar-native Client VPN page — one row per stack,
 * with a Download button on each row that hits the download endpoint below.
 *
 * We identify Client VPN approvals by their stack name prefix (`client-vpn-`)
 * inside payloadJson, which matches how the API route stores the stack id.
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

  // Dedupe by (envKey, stack): each wizard run creates a fresh approval
  // snapshot, so a stack that was retried a few times has multiple rows in
  // the DB. All of them point at the same S3 state → same certs. Keep only
  // the newest row per stack to avoid confusing duplicate cards.
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
    if (!stack.startsWith("client-vpn-")) continue;
    const envKey = r.env?.key ?? p.envKey ?? "";
    const dedupKey = `${envKey}::${stack}`;
    // Rows are already ordered by requestedAt desc, so first-seen = newest.
    if (bestByStack.has(dedupKey)) continue;
    bestByStack.set(dedupKey, {
      approvalId: r.id,
      name: stack.slice("client-vpn-".length),
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
