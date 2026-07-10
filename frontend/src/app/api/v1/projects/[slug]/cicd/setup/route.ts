import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { prisma } from "@/lib/db/prisma";
import { setupGithubOidcEcrTool } from "@/lib/agent/tools/setup-github-oidc-ecr";
import { writeRepoFileTool } from "@/lib/agent/tools/write-repo-file";
import { setKubeconfigSecretTool } from "@/lib/agent/tools/deploy-tools";
import { savePipelineToProjectTool } from "@/lib/agent/tools/save-pipeline-to-project";
import { setRepoActionsVariable } from "@/lib/github/secrets";
import { resolveTokenForRepo } from "@/lib/oauth/repo-token";
import { listDeployTargets } from "@/lib/devops/deploy";
import { buildCicdArtifacts, type CicdRegistry } from "@/lib/devops/cicd-pipeline";
import { sanitizeAppName } from "@/lib/devops/deploy-manifest";
import { DOCKER_STACKS } from "@/lib/ci/templates";

/**
 * GET /projects/[slug]/cicd/setup
 * Options the "Set up CI/CD" box prefills from: GitHub repos (+ default branch),
 * deploy envs (+ namespace), connected clouds, and the Docker stack catalog.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false, code: `status_${gate.status}` }, { status: gate.status });
  const projectId = gate.access.project.id;

  const [repos, clouds, targets] = await Promise.all([
    prisma.repo.findMany({
      where: { deletedAt: null, provider: "github", projectRepos: { some: { projectId } } },
      select: { fullName: true, defaultBranch: true },
      orderBy: { fullName: "asc" },
    }),
    prisma.cloudProvider.findMany({ where: { projectId }, select: { kind: true }, distinct: ["kind"] }),
    listDeployTargets(projectId),
  ]);
  const kinds = clouds.map((c) => c.kind);

  return NextResponse.json({
    ok: true,
    repos: repos.map((r) => ({ fullName: r.fullName, defaultBranch: r.defaultBranch || "main" })),
    envs: targets.map((t) => ({ envKey: t.envKey, name: t.name, namespace: t.namespace, cloudKind: t.cloudKind })),
    clouds: kinds,
    registrySupported: kinds.includes("aws"),
    stacks: DOCKER_STACKS.map((s) => ({ id: s.id, title: s.title, fields: s.fields })),
  });
}

/**
 * POST /projects/[slug]/cicd/setup
 *
 * One-shot CI/CD setup for the "Set up CI/CD" box. Deterministically:
 *   1. ensures the AWS OIDC provider + IAM role + ECR repo exist (idempotent),
 *   2. generates the full file set (Dockerfile, CI build/scan/push workflow,
 *      K8s manifests, CD deploy workflow) via buildCicdArtifacts,
 *   3. commits them all to one branch and opens a SINGLE PR,
 *   4. best-effort sets the KUBECONFIG_B64 repo secret so CD can reach the
 *      cluster.
 *
 * No LLM — every artifact comes from the vetted generators, so nothing is
 * hallucinated or half-written (the failure mode of the conversational flow).
 */
const Body = z.object({
  repoFullName: z.string().trim().min(3),
  envKey: z.string().trim().min(1),
  stack: z.enum(["static-spa", "node-service", "python", "go"]),
  dockerParams: z.record(z.union([z.string(), z.number()])).optional(),
  scanGate: z.boolean().optional(),
  appName: z.string().trim().min(1).max(63),
  /** Container image (ECR repo) name — used in BOTH the CI push and the Deployment. */
  imageName: z.string().trim().max(200).optional(),
  containerPort: z.coerce.number().int().min(1).max(65535).optional(),
  replicas: z.coerce.number().int().min(1).max(50).optional(),
  env: z.array(z.object({ key: z.string(), value: z.string() })).max(100).optional(),
  expose: z.boolean().optional(),
  host: z.string().trim().max(253).optional(),
  namespace: z.string().trim().max(63).optional(),
  /** CI trigger branch — defaults to the repo's stored default branch. */
  branch: z.string().trim().max(255).optional(),
  /** Repo folder the manifests live in. Defaults to k8s/<envKey>. */
  manifestDir: z.string().trim().max(200).optional(),
  /** Per-file include flags (each defaults to true). */
  include: z
    .object({
      dockerfile: z.boolean().optional(),
      compose: z.boolean().optional(),
      nginx: z.boolean().optional(),
      ciWorkflow: z.boolean().optional(),
      cdWorkflow: z.boolean().optional(),
      manifest: z.boolean().optional(),
    })
    .optional(),
  /** Register on the CI/CD tab with agent auto-review (auto-fix + re-run failed tracked runs). */
  agentReview: z.boolean().optional(),
  /** Set the KUBECONFIG_B64 secret from the env's kubeconfig. Default true. */
  setKubeconfig: z.boolean().optional(),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false, code: `status_${gate.status}` }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json({ ok: false, code: "invalid_request", message: parsed.error.issues[0]?.message }, { status: 400 });
  }
  const a = parsed.data;
  const toolCtx = { projectId: gate.access.project.id, userId: gate.access.session.userId };

  // The registry (ECR + OIDC) is only needed when we emit the CI workflow or a
  // manifest (whose image points at the registry). If both are toggled off, we
  // skip AWS entirely — e.g. "just write me a Dockerfile".
  const wantCi = a.include?.ciWorkflow !== false;
  const wantManifest = a.include?.manifest !== false;
  const wantCd = a.include?.cdWorkflow !== false;
  const needsRegistry = wantCi || wantManifest;

  let registry: CicdRegistry | undefined;
  let ecrRepositoryUri: string | undefined;
  if (needsRegistry) {
    // Detect the connected cloud. AWS ECR is wired for auto-setup today.
    const clouds = await prisma.cloudProvider.findMany({
      where: { projectId: toolCtx.projectId },
      select: { kind: true },
      distinct: ["kind"],
    });
    const kinds = clouds.map((c) => c.kind);
    if (!kinds.includes("aws")) {
      return NextResponse.json(
        {
          ok: false,
          code: "registry_unsupported",
          message: `The CI workflow / manifest need a container registry — automatic setup currently targets AWS ECR. Connected clouds: ${kinds.join(", ") || "none"}. Connect an AWS account on the Cloud tab, or turn off the CI workflow + manifest to write just the Docker files.`,
        },
        { status: 400 },
      );
    }
    // Ensure OIDC provider + IAM role + ECR repo (idempotent). The image name
    // becomes the ECR repo name, so CI push URI + Deployment image stay in sync.
    const oidc = await setupGithubOidcEcrTool.execute(
      { repoFullName: a.repoFullName, ecrRepoName: a.imageName?.trim() || undefined },
      toolCtx,
    );
    if (!oidc.ok) {
      return NextResponse.json({ ok: false, code: "registry_setup_failed", message: oidc.error }, { status: 400 });
    }
    registry = { cloud: "aws", roleArn: oidc.output.roleArn, region: oidc.output.region, ecrRepositoryUri: oidc.output.ecrRepositoryUri };
    ecrRepositoryUri = oidc.output.ecrRepositoryUri;

    // Publish the config as GitHub Actions VARIABLES (production style — the
    // generated workflow references vars.* instead of hardcoding ARN/region/URI).
    const repoRow = await prisma.repo.findFirst({
      where: { fullName: a.repoFullName, deletedAt: null, projectRepos: { some: { projectId: toolCtx.projectId } } },
      select: { id: true },
    });
    if (repoRow) {
      const tok = await resolveTokenForRepo(repoRow.id);
      if (tok.ok) {
        await setRepoActionsVariable(tok.accessToken, a.repoFullName, "AWS_ROLE_ARN", oidc.output.roleArn);
        await setRepoActionsVariable(tok.accessToken, a.repoFullName, "AWS_REGION", oidc.output.region);
        await setRepoActionsVariable(tok.accessToken, a.repoFullName, "ECR_REPOSITORY", oidc.output.ecrRepositoryUri);
      }
    }
  }

  // 3) CI trigger branch = the repo's default branch (fixes the main/master bug).
  const repo = await prisma.repo.findFirst({
    where: { fullName: a.repoFullName, deletedAt: null, projectRepos: { some: { projectId: toolCtx.projectId } } },
    select: { defaultBranch: true },
  });
  const branch = (a.branch || repo?.defaultBranch || "main").trim();

  // 4) Namespace from the chosen env (unless overridden).
  const targets = await listDeployTargets(toolCtx.projectId);
  const target = targets.find((t) => t.envKey === a.envKey);
  const namespace = (a.namespace || "").trim() || target?.namespace || "default";
  const manifestDir = (a.manifestDir || `k8s/${a.envKey}`).trim();

  // 5) Build the full CI + CD file set (Docker + CI workflow + manifest + CD workflow).
  const built = buildCicdArtifacts({
    stack: a.stack,
    dockerParams: a.dockerParams,
    branch,
    scanGate: a.scanGate,
    registry,
    include: a.include,
    deploy: {
      appName: a.appName,
      namespace,
      replicas: Math.max(1, a.replicas ?? 1),
      containerPort: Math.max(1, a.containerPort ?? 8080),
      env: a.env ?? [],
      expose: !!a.expose,
      host: a.host,
    },
    manifestDir,
  });

  if (built.files.length === 0) {
    return NextResponse.json(
      { ok: false, code: "no_files", message: "No files selected — enable at least one file to write." },
      { status: 400 },
    );
  }

  // 6) Commit every file to one branch and open a SINGLE PR (first file opens it).
  const prBranch = `cicd/${sanitizeAppName(a.appName)}`;
  const prBody =
    "CI/CD pipeline generated by DeepAgent (deterministic — no hand-written files).\n\n" +
    "- **Dockerfile** (+ `.dockerignore`, `docker-compose.yml`, `nginx.conf`)\n" +
    "- **`.github/workflows/build-and-push.yml`** — build → Trivy scan (stops on HIGH/CRITICAL) → push to ECR\n" +
    `- **\`${manifestDir}/manifest.yaml\`** — Deployment + Service${a.expose ? " + Ingress" : ""}\n` +
    "- **`.github/workflows/deploy.yml`** — deploys to the cluster ONLY after CI succeeds\n\n" +
    `Merge to \`${branch}\` to run it. The CD workflow needs the repo secret \`KUBECONFIG_B64\` (the app sets this for you).`;

  const committed: string[] = [];
  let pullRequest: { number: number; url: string } | undefined;
  let first = true;
  for (const f of built.files) {
    const res = await writeRepoFileTool.execute(
      {
        repoFullName: a.repoFullName,
        path: f.path,
        content: f.content,
        branch: prBranch,
        message: "Add CI/CD pipeline (DeepAgent)",
        openPullRequest: first,
        pullRequestBody: prBody,
      },
      toolCtx,
    );
    if (!res.ok) {
      return NextResponse.json(
        { ok: false, code: "push_failed", message: `Failed writing ${f.path}: ${res.error}`, filesPushed: committed },
        { status: 400 },
      );
    }
    committed.push(f.path);
    if (res.output.pullRequest) pullRequest = res.output.pullRequest;
    first = false;
  }

  // 7) Best-effort: set KUBECONFIG_B64 so the CD workflow can reach the cluster.
  let kubeconfigSet = false;
  let kubeconfigNote: string | undefined;
  if (a.setKubeconfig !== false && wantCd) {
    const sec = await setKubeconfigSecretTool.execute({ repoFullName: a.repoFullName, envKey: a.envKey }, toolCtx);
    kubeconfigSet = sec.ok;
    if (!sec.ok) kubeconfigNote = sec.error;
  }

  // Register the pipeline on the CI/CD tab so DeepAgent can track its runs. With
  // agentReview on, a failed TRACKED run (one started via "Run pipeline") is
  // auto-fixed + re-run by the agent — it reads the failed log, rewrites the
  // workflow, re-commits to the default branch, and re-triggers (up to 3×).
  let registeredPipeline: { id: string; name: string; agentReview: boolean } | undefined;
  if (a.agentReview) {
    const saved = await savePipelineToProjectTool.execute(
      { repoFullName: a.repoFullName, name: `CI/CD — ${a.appName}`, files: built.files, agentReview: true },
      toolCtx,
    );
    if (saved.ok) registeredPipeline = { id: saved.output.id, name: saved.output.name, agentReview: true };
  }

  return NextResponse.json({
    ok: true,
    pullRequest,
    files: committed,
    branch,
    prBranch,
    imageRef: built.imageRef,
    namespace,
    ecrRepositoryUri,
    kubeconfigSet,
    kubeconfigNote,
    registeredPipeline,
    notes: built.notes,
  });
}
