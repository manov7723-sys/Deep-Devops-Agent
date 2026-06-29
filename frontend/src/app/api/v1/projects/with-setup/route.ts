import { NextResponse } from "next/server";
import { z } from "zod";
import type { CloudKind, RepoKind, RepoVisibility } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { getActiveSession } from "@/lib/auth/session";
import { createProject } from "@/lib/projects/projects";
import { createRepo, attachRepoToProject } from "@/lib/repos/repos";
import { createEnv, setEnvTfBackend } from "@/lib/devops/envs";
import { createProvider } from "@/lib/cloud/providers";
import { getUserExternalId } from "@/lib/cloud/aws-onboard";
import { audit } from "@/lib/audit/log";
import { recordActivity } from "@/lib/agentops/activity";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * POST /projects/with-setup
 *
 * Single bundled call used by the create-project wizard. Creates the
 * Project + Memberships first, then dispatches the optional repo / env /
 * cloud setup. Each side step is best-effort: a failed sub-step is reported
 * back to the client per-item so the user can retry just that piece
 * without losing the rest of the project.
 */
const RepoChoice = z.object({
  githubId: z.string().min(1),
  name: z.string().min(1),
  fullName: z.string().min(1),
  defaultBranch: z.string().default("main"),
  visibility: z.enum(["private", "public"]).default("private"),
  lang: z.string().default("—"),
  /** Free-form GitHub description. */
  description: z.string().default(""),
  /** UI lets the user pick a RepoKind; defaults to Service. */
  kind: z.enum(["Service", "Frontend", "Terraform", "Kubernetes", "Library", "Worker"]).default("Service"),
  /**
   * OAuthAccount.id whose access token grants visibility into this repo.
   * Required when the user has more than one connected GitHub identity so
   * deploy/sync flows pick the right token later.
   */
  oauthAccountId: z.string().uuid().optional(),
});

const EnvChoice = z.object({
  key: z.string().trim().min(1).max(40),
  name: z.string().trim().min(1).max(60),
  isProduction: z.boolean().default(false),
  autoDeploy: z.boolean().default(false),
  promotionRank: z.number().int().min(0).max(99).default(0),
  region: z.string().trim().max(40).optional(),
});

const CloudChoice = z.object({
  kind: z.enum(["aws", "gcp", "azure"]),
  name: z.string().trim().min(1).max(80),
  accountRef: z.string().trim().min(1).max(120),
  accountId: z.string().trim().max(120).optional(),
  region: z.string().trim().min(1).max(40),
  roleArn: z.string().trim().max(280).optional(),
  externalId: z.string().trim().max(120).optional(),
  // AWS long-lived keys — stored in Vault (never Postgres), like the original
  // backend. Optional: the wizard only sends them when the user fills them in.
  awsAccessKeyId: z.string().trim().min(16).max(128).optional(),
  awsSecretAccessKey: z.string().trim().min(1).max(256).optional(),
  // Terraform remote-state backend (S3 + optional DynamoDB lock). Applied to
  // every env created in this wizard so `terraform` runs share one state store.
  tfBackend: z
    .object({
      bucket: z.string().trim().min(3).max(63),
      region: z.string().trim().min(1).max(40),
      table: z.string().trim().max(255).optional(),
    })
    .optional(),
});

const Body = z.object({
  name: z.string().trim().min(1).max(80),
  description: z.string().trim().max(500).default(""),
  colorHue: z.number().int().min(0).max(360).default(285),
  repos: z.array(RepoChoice).max(50).default([]),
  envs: z.array(EnvChoice).max(20).default([]),
  cloud: CloudChoice.nullable().default(null),
  // The project's intended cloud (records the wizard pick; locks the Connect UI).
  cloudKind: z.enum(["aws", "gcp", "azure"]).nullable().default(null),
});

type StepReport = {
  step: "repo" | "env" | "cloud" | "vault" | "tfstate";
  ok: boolean;
  label: string;
  code?: string;
  message?: string;
};

export async function POST(req: Request) {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.json({ ok: false, code: "unauthenticated" }, { status: 401 });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message ?? "Invalid input." },
      { status: 400 },
    );
  }
  const data = parsed.data;

  // Step 1 — Project itself (required). If this fails, nothing else runs.
  const project = await createProject({
    ownerId: sess.userId,
    name: data.name,
    description: data.description,
    colorHue: data.colorHue,
    cloud: data.cloudKind,
  });
  const meta = extractRequestMeta(req);
  await audit({
    userId: sess.userId,
    action: "project.created",
    targetType: "project",
    targetId: project.id,
    projectId: project.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { slug: project.slug, name: data.name, wizard: true },
  });
  await recordActivity({
    projectId: project.id,
    actorUserId: sess.userId,
    action: "created",
    targetType: "project",
    targetLabel: data.name,
    icon: "projects",
  }).catch(() => {});

  const steps: StepReport[] = [];

  // Step 2 — Cloud provider (before envs so we can link them).
  let cloudProviderId: string | null = null;
  if (data.cloud) {
    try {
      const provider = await createProvider({
        userId: sess.userId,
        kind: data.cloud.kind as CloudKind,
        name: data.cloud.name,
        accountRef: data.cloud.accountRef,
        accountId: data.cloud.accountId,
        region: data.cloud.region,
        roleArn: data.cloud.roleArn,
        // For AWS the ExternalId is app-owned and derived from the user — never
        // taken from the client. Other clouds may pass their own value.
        externalId:
          data.cloud.kind === "aws" ? getUserExternalId(sess.userId) : data.cloud.externalId,
      });
      cloudProviderId = provider.id;
      steps.push({ step: "cloud", ok: true, label: `${data.cloud.kind} (${data.cloud.region})` });
      await recordActivity({
        projectId: project.id,
        actorUserId: sess.userId,
        action: "connected",
        targetType: "cloud_provider",
        targetLabel: `${data.cloud.kind} · ${data.cloud.region}`,
        icon: "cloud",
      }).catch(() => {});
      // AWS keys are no longer collected in the wizard — the user connects the
      // account and stores keys later on the Cloud providers tab (Vault section).
    } catch (err) {
      steps.push({
        step: "cloud",
        ok: false,
        label: data.cloud.kind,
        code: "cloud_create_failed",
        message: err instanceof Error ? err.message : "Unknown error",
      });
    }
  }

  // Step 3 — Repos: upsert Repo (identity = (oauthAccountId, fullName) when
  // we have one, else (ownerId, fullName)) then attach.
  for (const r of data.repos) {
    const created = await createRepo({
      ownerId: sess.userId,
      oauthAccountId: r.oauthAccountId,
      fullName: r.fullName,
      description: r.description,
      lang: r.lang,
      kind: r.kind as RepoKind,
      defaultBranch: r.defaultBranch,
      visibility: r.visibility as RepoVisibility,
    });
    let repoId: string | null = null;
    if (created.ok) {
      repoId = created.repo.id;
    } else {
      // Re-resolve the existing Repo to attach to it.
      const existing = r.oauthAccountId
        ? await prisma.repo.findUnique({
            where: {
              oauthAccountId_fullName: {
                oauthAccountId: r.oauthAccountId,
                fullName: r.fullName,
              },
            },
            select: { id: true, deletedAt: true },
          })
        : await prisma.repo.findUnique({
            where: { ownerId_fullName: { ownerId: sess.userId, fullName: r.fullName } },
            select: { id: true, deletedAt: true },
          });
      if (existing && !existing.deletedAt) repoId = existing.id;
    }
    if (!repoId) {
      steps.push({
        step: "repo",
        ok: false,
        label: r.fullName,
        code: "repo_create_failed",
        message: "Could not create or resolve repo.",
      });
      continue;
    }
    const attach = await attachRepoToProject(sess.userId, project.id, repoId);
    if (!attach.ok) {
      steps.push({
        step: "repo",
        ok: false,
        label: r.fullName,
        code: attach.code,
        message: `Could not attach ${r.fullName} to project.`,
      });
    } else {
      steps.push({ step: "repo", ok: true, label: r.fullName });
      await recordActivity({
        projectId: project.id,
        actorUserId: sess.userId,
        action: "attached",
        targetType: "repo",
        targetLabel: r.fullName,
        icon: "github",
      }).catch(() => {});
    }
  }

  // Step 4 — Envs (linked to cloud if it was created in step 2).
  const createdEnvKeys: string[] = [];
  for (const e of data.envs) {
    const result = await createEnv({
      projectId: project.id,
      ownerId: sess.userId,
      key: e.key,
      name: e.name,
      isProduction: e.isProduction,
      autoDeploy: e.autoDeploy,
      promotionRank: e.promotionRank,
      ...(cloudProviderId ? { cloudProviderId } : {}),
      ...(e.region ? { region: e.region } : {}),
    });
    if (!result.ok) {
      steps.push({
        step: "env",
        ok: false,
        label: e.name,
        code: result.code,
        message: `Could not create env ${e.name}.`,
      });
    } else {
      createdEnvKeys.push(e.key);
      steps.push({ step: "env", ok: true, label: e.name });
      await recordActivity({
        projectId: project.id,
        actorUserId: sess.userId,
        action: "created",
        targetType: "env",
        targetLabel: e.name,
        icon: "branch",
      }).catch(() => {});
    }
  }

  // Step 5 — Terraform remote-state backend. Apply the chosen S3 bucket/region
  // (+ optional lock table) to every env we just created so all `terraform`
  // runs for this project share one state store. Best-effort, per-env reported.
  if (data.cloud?.tfBackend && createdEnvKeys.length > 0) {
    const tf = data.cloud.tfBackend;
    for (const key of createdEnvKeys) {
      const res = await setEnvTfBackend(project.id, key, {
        bucket: tf.bucket,
        region: tf.region,
        table: tf.table,
      });
      if (res.ok) {
        steps.push({ step: "tfstate", ok: true, label: `${key} → s3://${tf.bucket}` });
      } else {
        steps.push({
          step: "tfstate",
          ok: false,
          label: `${key} → s3://${tf.bucket}`,
          code: res.code,
          message: `Could not set Terraform state backend for ${key}.`,
        });
      }
    }
  }

  return NextResponse.json({
    ok: true,
    project: { id: project.id, slug: project.slug },
    steps,
    summary: {
      totalSteps: steps.length,
      okSteps: steps.filter((s) => s.ok).length,
      failedSteps: steps.filter((s) => !s.ok).length,
    },
  });
}
