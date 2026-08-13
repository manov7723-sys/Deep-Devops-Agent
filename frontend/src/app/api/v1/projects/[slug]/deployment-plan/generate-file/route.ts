import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { writeRepoFileTool } from "@/lib/agent/tools/write-repo-file";
import type { RepoAnalysisReport } from "@/lib/analysis/repo-analyzer";
import {
  DOCKERIGNORE,
  dockerfileFor,
  envExampleFor,
} from "@/lib/analysis/scaffold-templates";

/**
 * POST /projects/[slug]/deployment-plan/generate-file
 *
 * Generate ONE missing scaffolding file from the saved plan and commit it
 * directly to the repo's default branch. The only write action the plan
 * performs — repo-only, never cloud. fileId matches MissingFile.id from the
 * analysis report ("dockerfile:<path|root>", "dockerignore", "ci-workflow",
 * "env-example", "readme").
 */
const Body = z.object({ fileId: z.string().min(1).max(200) });

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: "invalid_request" }, { status: 400 });
  }
  const { fileId } = parsed.data;

  const planRow = await prisma.deploymentPlan.findUnique({
    where: { projectId: gate.access.project.id },
    select: { repoFullName: true, plan: true },
  });
  if (!planRow) return NextResponse.json({ ok: false, code: "no_plan" }, { status: 404 });
  const report = (planRow.plan as { report?: RepoAnalysisReport })?.report;
  if (!report) return NextResponse.json({ ok: false, code: "no_report" }, { status: 404 });

  const missing = report.missingFiles.find((f) => f.id === fileId);
  if (!missing || !missing.generatable) {
    return NextResponse.json({ ok: false, code: "unknown_file" }, { status: 404 });
  }

  // Resolve content + path from the file id.
  let path: string;
  let content: string;
  if (fileId.startsWith("dockerfile:")) {
    const svc = report.services.find((s) => (s.path || "root") === (missing.servicePath || "root"));
    if (!svc) return NextResponse.json({ ok: false, code: "unknown_service" }, { status: 404 });
    path = svc.path ? `${svc.path}/Dockerfile` : "Dockerfile";
    content = dockerfileFor(svc);
  } else if (fileId === "dockerignore") {
    path = ".dockerignore";
    content = DOCKERIGNORE;
  } else if (fileId === "env-example") {
    path = ".env.example";
    content = envExampleFor(report.envVars);
  } else {
    return NextResponse.json({ ok: false, code: "unknown_file" }, { status: 404 });
  }

  const res = await writeRepoFileTool.execute(
    {
      repoFullName: planRow.repoFullName,
      path,
      content,
      branch: report.defaultBranch || "main",
      message: `chore: add ${path} (generated from repo analysis)`,
      // Direct commit — no PR, per infra-push policy.
    },
    { projectId: gate.access.project.id, userId: gate.access.session.userId },
  );
  if (!res.ok) {
    return NextResponse.json({ ok: false, code: "commit_failed", message: res.error }, { status: 400 });
  }

  return NextResponse.json({ ok: true, path });
}
