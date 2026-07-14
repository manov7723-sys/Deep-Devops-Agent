import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";

function projectShape(p: {
  id: string;
  slug: string;
  name: string;
  description: string;
  colorHue: number;
  health: "ok" | "warn" | "danger";
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  ownerId: string;
}) {
  return {
    id: p.id,
    slug: p.slug,
    name: p.name,
    description: p.description,
    colorHue: p.colorHue,
    health: p.health,
    archivedAt: p.archivedAt?.toISOString() ?? null,
    createdAt: p.createdAt.toISOString(),
    updatedAt: p.updatedAt.toISOString(),
    ownerId: p.ownerId,
  };
}

async function getOrInitSetting(projectId: string) {
  const existing = await prisma.projectSetting.findUnique({
    where: { projectId },
    include: { defaultModel: { select: { name: true } } },
  });
  if (existing) return existing;
  const created = await prisma.projectSetting.create({
    data: { projectId },
    include: { defaultModel: { select: { name: true } } },
  });
  return created;
}

export async function GET(_req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok)
    return NextResponse.json({ ok: false, code: `status_${gate.status}` }, { status: gate.status });
  const setting = await getOrInitSetting(gate.access.project.id);
  return NextResponse.json({
    project: projectShape(gate.access.project),
    meta: {
      defaultBranch: setting.defaultBranch,
      autoDeployNonProd: setting.autoDeployNonProd,
      requireApprovalRelease: setting.requireApprovalRelease,
      defaultModel: setting.defaultModel?.name ?? "Claude Sonnet 4.5",
      description: gate.access.project.description,
    },
  });
}

const PatchSettings = z
  .object({
    name: z.string().trim().min(1).max(120).optional(),
    description: z.string().trim().max(800).optional(),
    colorHue: z.number().int().min(0).max(360).optional(),
    defaultBranch: z.string().trim().min(1).max(120).optional(),
    autoDeployNonProd: z.boolean().optional(),
    requireApprovalRelease: z.boolean().optional(),
    defaultModel: z.string().trim().min(1).max(120).optional(),
  })
  .refine((d) => Object.keys(d).length > 0, { message: "At least one field is required" });

export async function PATCH(req: Request, { params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  // Editing settings requires owner/developer; viewers can only read.
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok)
    return NextResponse.json({ ok: false, code: `status_${gate.status}` }, { status: gate.status });
  const parsed = PatchSettings.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_input", issues: parsed.error.issues },
      { status: 400 },
    );
  }
  const patch = parsed.data;

  const projectPatch: Parameters<typeof prisma.project.update>[0]["data"] = {};
  if (patch.name !== undefined) projectPatch.name = patch.name;
  if (patch.description !== undefined) projectPatch.description = patch.description;
  if (patch.colorHue !== undefined) projectPatch.colorHue = patch.colorHue;

  const settingPatch: Parameters<typeof prisma.projectSetting.update>[0]["data"] = {};
  if (patch.defaultBranch !== undefined) settingPatch.defaultBranch = patch.defaultBranch;
  if (patch.autoDeployNonProd !== undefined)
    settingPatch.autoDeployNonProd = patch.autoDeployNonProd;
  if (patch.requireApprovalRelease !== undefined)
    settingPatch.requireApprovalRelease = patch.requireApprovalRelease;
  if (patch.defaultModel !== undefined) {
    const model = await prisma.model.findFirst({
      where: { name: patch.defaultModel },
      select: { id: true },
    });
    settingPatch.defaultModelId = model?.id ?? null;
  }

  const projectId = gate.access.project.id;
  if (Object.keys(projectPatch).length > 0) {
    await prisma.project.update({ where: { id: projectId }, data: projectPatch });
  }
  await getOrInitSetting(projectId);
  if (Object.keys(settingPatch).length > 0) {
    await prisma.projectSetting.update({ where: { projectId }, data: settingPatch });
  }

  const fresh = await prisma.project.findUnique({
    where: { id: projectId },
    select: {
      id: true,
      slug: true,
      name: true,
      description: true,
      colorHue: true,
      health: true,
      archivedAt: true,
      createdAt: true,
      updatedAt: true,
      ownerId: true,
    },
  });
  const setting = await prisma.projectSetting.findUnique({
    where: { projectId },
    include: { defaultModel: { select: { name: true } } },
  });

  return NextResponse.json({
    ok: true,
    project: fresh ? projectShape(fresh) : null,
    meta: setting
      ? {
          defaultBranch: setting.defaultBranch,
          autoDeployNonProd: setting.autoDeployNonProd,
          requireApprovalRelease: setting.requireApprovalRelease,
          defaultModel: setting.defaultModel?.name ?? "Claude Sonnet 4.5",
          description: fresh?.description ?? "",
        }
      : null,
  });
}
