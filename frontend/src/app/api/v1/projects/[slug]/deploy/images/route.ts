import { NextResponse } from "next/server";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { listProjectRegistryImages } from "@/lib/cloud/registry-images";

/**
 * GET /projects/[slug]/deploy/images
 * List container images + tags from the project's connected cloud registry
 * (ECR / GAR / ACR) so the deploy wizard can offer a picker.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const result = await listProjectRegistryImages(gate.access.project.id);
  if (!result.ok) return NextResponse.json({ ok: false, message: result.error }, { status: 400 });
  return NextResponse.json(result);
}
