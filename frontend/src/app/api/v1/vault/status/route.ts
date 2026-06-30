import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { vaultStatus } from "@/lib/cloud/vault";

/** HashiCorp Vault connectivity for the per-PROJECT "Vault config" UI section. Scoped by `?slug=`. */
export async function GET(req: Request) {
  const slug = new URL(req.url).searchParams.get("slug") ?? "";
  if (!slug) return NextResponse.json({ ok: false, code: "missing_slug" }, { status: 400 });
  const g = await requireProjectAccess(slug, "viewer");
  if (!g.ok) return NextResponse.json({ ok: false }, { status: g.status });
  return NextResponse.json(await vaultStatus(g.access.project.id));
}
