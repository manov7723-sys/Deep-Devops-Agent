import { NextResponse } from "next/server";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";

/**
 * GET /projects/[slug]/aws/client-vpn/[approvalId]/user-certs
 *
 * Lists every per-user cert previously issued against this Client VPN
 * endpoint. Powers the "Issued user certs" section on the sidebar page —
 * users see who has an active cert + can re-download or revoke.
 *
 * Never returns PEM contents; those only leave the server through the
 * per-cert download endpoint (which decrypts + streams a zip).
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string; approvalId: string }> },
) {
  const { slug, approvalId } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const projectId = gate.access.project.id;

  const rows = await prisma.vpnUserCert.findMany({
    where: { projectId, approvalId },
    orderBy: { issuedAt: "desc" },
    select: {
      id: true,
      userName: true,
      serial: true,
      issuedAt: true,
      revokedAt: true,
      validityDays: true,
    },
  });

  return NextResponse.json({
    ok: true,
    items: rows.map((r) => ({
      id: r.id,
      userName: r.userName,
      serial: r.serial,
      issuedAt: r.issuedAt.toISOString(),
      revokedAt: r.revokedAt?.toISOString() ?? null,
      validityDays: r.validityDays,
    })),
  });
}
