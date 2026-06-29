import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { listTerraformRuns, startTerraformRun } from "@/lib/devops/terraform-run";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * Terraform pipeline for an environment.
 *
 *   GET  — list recent runs for the env (status + per-stage state for polling).
 *   POST — start an init → plan → (apply) run over a generated Terraform tree,
 *          using the env's Vault AWS creds + S3 state backend.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const env = await envBySlugAndKey(gate.access.project.id, key);
  if (!env) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, runs: listTerraformRuns(env.id) });
}

const StartBody = z.object({
  action: z.enum(["plan", "apply"]).default("plan"),
  name: z.string().trim().min(1).max(80).default("infra"),
  // Generated Terraform tree: relative path → contents. Comes from the EKS box
  // or any infra generator. Capped to keep request + workdir sane.
  files: z
    .record(z.string().min(1).max(200), z.string().max(200_000))
    .refine((f) => Object.keys(f).length > 0, { message: "No Terraform files provided." })
    .refine((f) => Object.keys(f).length <= 50, { message: "Too many files (max 50)." }),
  /** Stable logical stack id (keeps state consistent across runs). */
  stack: z.string().trim().max(120).optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  // Applying infra is a developer+ action.
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const env = await envBySlugAndKey(gate.access.project.id, key);
  if (!env) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });

  const parsed = StartBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const { action, name, files, stack } = parsed.data;

  // `apply` without a configured S3 backend would leave state in a throwaway
  // temp dir — refuse so users don't think their infra state is durable.
  if (action === "apply" && !env.tfBackendBucket) {
    return NextResponse.json(
      {
        ok: false,
        code: "no_state_backend",
        message:
          "Set a Terraform state bucket for this environment before applying (Cloud tab → Terraform state).",
      },
      { status: 409 },
    );
  }

  const run = startTerraformRun({
    projectId: gate.access.project.id,
    envId: env.id,
    envKey: env.key,
    cloudProviderId: env.cloudProviderId,
    name,
    action,
    files,
    stack,
    backend: env.tfBackendBucket
      ? {
          bucket: env.tfBackendBucket,
          region: env.tfBackendRegion ?? "us-east-1",
          table: env.tfBackendTable ?? undefined,
        }
      : null,
  });

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "terraform.run_started",
    targetType: "env",
    targetId: env.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { runId: run.id, action, name, fileCount: Object.keys(files).length },
  });

  return NextResponse.json({ ok: true, run });
}
