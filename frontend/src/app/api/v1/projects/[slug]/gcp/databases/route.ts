import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { listCloudSqlInstances, listCloudSqlDatabases } from "@/lib/cloud/gcp-cloudsql";

/**
 * GET /projects/[slug]/gcp/databases[?instance=<name>]
 *
 * Without `instance`: every Cloud SQL instance in the connected project.
 * With `instance`: that instance's databases, so the connect panel can offer
 * a real list instead of asking the user to remember a name.
 *
 * Read-only, app-managed (stored GCP OAuth token + REST). No `gcloud`.
 */
export async function GET(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId: gate.access.project.id, kind: "gcp" },
    select: { id: true, accountRef: true },
  });
  if (!cp?.accountRef) {
    return NextResponse.json({
      ok: true,
      connected: false,
      instances: [],
      note: "Connect a GCP project on the Cloud providers page first.",
    });
  }

  const instance = new URL(req.url).searchParams.get("instance")?.trim();
  if (instance) {
    const dbs = await listCloudSqlDatabases(cp.id, cp.accountRef, instance);
    return dbs.ok
      ? NextResponse.json({ ok: true, connected: true, databases: dbs.databases })
      : NextResponse.json({ ok: true, connected: true, databases: [], note: dbs.error });
  }

  const res = await listCloudSqlInstances(cp.id, cp.accountRef);
  if (!res.ok) {
    return NextResponse.json({ ok: true, connected: true, instances: [], note: res.error });
  }
  return NextResponse.json({ ok: true, connected: true, instances: res.instances });
}
