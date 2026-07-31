import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { listAzureDatabaseServers } from "@/lib/cloud/azure-postgres";

/**
 * GET /projects/[slug]/azure/databases
 *
 * Lists the connected subscription's Azure Database for PostgreSQL / MySQL
 * Flexible Servers so the Connections page can offer them in a picker —
 * the Azure counterpart of /aws/rds.
 *
 * Read-only, app-managed (stored Azure credentials + ARM REST). Never shells
 * out to `az`.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId: gate.access.project.id, kind: "azure" },
    select: { id: true, accountRef: true },
  });
  if (!cp?.accountRef) {
    return NextResponse.json({
      ok: true,
      connected: false,
      servers: [],
      note: "Connect an Azure subscription on the Cloud providers page first.",
    });
  }

  const res = await listAzureDatabaseServers(cp.id, cp.accountRef);
  if (!res.ok) {
    return NextResponse.json({ ok: true, connected: true, servers: [], note: res.error });
  }
  return NextResponse.json({ ok: true, connected: true, servers: res.servers });
}
