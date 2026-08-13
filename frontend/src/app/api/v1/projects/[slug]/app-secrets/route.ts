import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { getKubeconfigForEnv, kubeExecEnv } from "@/lib/runner/creds";
import { applyAppSecret, parseEnvText, findLocalhostValues } from "@/lib/devops/app-secrets";
import { wireSecretToWorkloads, type WireOutcome } from "@/lib/devops/wire-secret-to-workloads";
import { resolveTokenForRepo } from "@/lib/oauth/repo-token";
import {
  ensureRepoEnvironment,
  setEnvActionsSecret,
  setEnvActionsVariable,
} from "@/lib/github/secrets";

/**
 * Sensitive-name heuristic — same shape the repo analyzer uses. Names the
 * DeploymentPlan doesn't know get classified by this; names it DOES know use
 * the plan's own secret flag so the GitHub write always lands on the same
 * side (secrets vs vars) the generated CD workflow reads from.
 */
const SECRET_NAME_PATTERN = /KEY|TOKEN|SECRET|PASSWORD|PASS|CREDENTIAL|PRIVATE|_URL|_URI|DSN/i;

type GithubSyncResult = {
  attempted: boolean;
  repoFullName?: string;
  environment?: string;
  secretsWritten: string[];
  varsWritten: string[];
  skippedNames: string[];
  errors: string[];
};

/**
 * Mirror the saved entries into GitHub environment secrets/variables so the
 * app's env has ONE source of truth per deploy: the CD workflow re-materializes
 * `app-env` from GitHub on every run. Without this sync, a Connections-tab
 * edit would live only in the cluster Secret and silently revert to the old
 * GitHub value on the next deploy.
 *
 * Best-effort by design — the k8s write already succeeded when this runs, so
 * GitHub failures degrade to a warning in the response, never a 500.
 */
async function syncEntriesToGithub(args: {
  projectId: string;
  envKey: string;
  entries: { key: string; value: string }[];
}): Promise<GithubSyncResult> {
  const out: GithubSyncResult = {
    attempted: false,
    secretsWritten: [],
    varsWritten: [],
    skippedNames: [],
    errors: [],
  };

  // Target repo: the one the analysis ran on (deploys come from it); fall
  // back to the project's first attached repo for analysis-skipped projects.
  const plan = await prisma.deploymentPlan.findUnique({
    where: { projectId: args.projectId },
    select: { repoFullName: true, plan: true },
  });
  const repoRow = await prisma.repo.findFirst({
    where: {
      deletedAt: null,
      projectRepos: { some: { projectId: args.projectId } },
      ...(plan?.repoFullName ? { fullName: plan.repoFullName } : {}),
    },
    select: { id: true, fullName: true },
  });
  if (!repoRow) {
    out.errors.push("No GitHub repo attached to this project — skipped the GitHub sync.");
    return out;
  }
  out.attempted = true;
  out.repoFullName = repoRow.fullName;
  out.environment = args.envKey;

  const tok = await resolveTokenForRepo(repoRow.id);
  if (!tok.ok) {
    out.errors.push(`GitHub token unavailable: ${tok.message}`);
    return out;
  }

  const ensured = await ensureRepoEnvironment(tok.accessToken, repoRow.fullName, args.envKey);
  if (!ensured.ok) {
    out.errors.push(ensured.error);
    return out;
  }

  // secret-vs-variable split MUST match what the CD workflow template reads
  // (plan-flagged names → their flag; unknown names → heuristic). Classify on
  // the UNPREFIXED name: `BACKEND__DATABASE_URL` is the same variable as
  // `DATABASE_URL` as far as sensitivity goes, and the plan only knows the
  // bare name.
  const planSecretFlags = new Map<string, boolean>();
  const report = (plan?.plan as { report?: { envVars?: { name: string; secret: boolean }[] } } | null)
    ?.report;
  for (const v of report?.envVars ?? []) planSecretFlags.set(v.name, v.secret);
  const bareName = (n: string) => n.replace(/^[A-Z][A-Z0-9]*__/, "");

  for (const { key, value } of args.entries) {
    // GitHub naming rules: A-Z0-9_ starting with a letter/underscore. Skip
    // (and report) invalid names rather than fail the batch.
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      out.skippedNames.push(key);
      continue;
    }
    // GitHub RESERVES the GITHUB_ prefix — the API rejects such names
    // outright. Store them ALIASED as APP_<name>; the CD workflow's
    // materialize step maps the alias back to the real name when building
    // the app-env Secret, so the pod still sees GITHUB_OAUTH_CLIENT_ID etc.
    const ghName = key.toUpperCase().startsWith("GITHUB_") ? `APP_${key}` : key;
    const bare = bareName(key);
    const isSecret =
      planSecretFlags.get(bare) ?? planSecretFlags.get(key) ?? SECRET_NAME_PATTERN.test(bare);
    const res = isSecret
      ? await setEnvActionsSecret(tok.accessToken, repoRow.fullName, args.envKey, ghName, value)
      : await setEnvActionsVariable(tok.accessToken, repoRow.fullName, args.envKey, ghName, value);
    if (res.ok) (isSecret ? out.secretsWritten : out.varsWritten).push(ghName === key ? key : `${key} (as ${ghName})`);
    else out.errors.push(`${key}: ${res.error}`);
  }
  return out;
}

/**
 * POST /projects/[slug]/app-secrets
 *
 * Write the app's configuration secrets into a namespace and roll the
 * Deployments so running pods pick them up.
 *
 * The counterpart to /aws/rds-connect: that one owns DATABASE_URL, this one
 * owns everything else an app needs to boot (signing keys, API keys, feature
 * flags). Both end the same way — Secret applied, envFrom wired, pods rolled —
 * because a Secret nothing consumes is invisible to the app.
 *
 * The raw text is parsed server-side and never stored anywhere but the
 * cluster Secret.
 */
const Body = z.object({
  envKey: z.string().trim().min(1),
  namespace: z.string().trim().min(1),
  secretName: z
    .string()
    .trim()
    .regex(/^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$/, "Secret name must be DNS-1123 (lowercase, dashes).")
    .default("app-env"),
  /** `.env`-style text: KEY=value per line. */
  envText: z.string().min(1, "Paste at least one KEY=value line."),
  /**
   * Merge into the Secret's existing keys instead of replacing it wholesale.
   * The per-field form sends true (it only knows about the fields it renders);
   * the paste-your-whole-.env textarea sends false, since that IS the complete
   * desired state and removing a key must stay possible. See applyAppSecret.
   */
  merge: z.boolean().optional().default(false),
});

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const body = parsed.data;

  const { entries, skipped } = parseEnvText(body.envText);
  if (entries.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        code: "no_pairs",
        message:
          "No KEY=value pairs found. Paste .env-style lines, one per line (comments and blanks are ignored).",
      },
      { status: 400 },
    );
  }

  const env = await prisma.env.findFirst({
    where: { projectId: gate.access.project.id, key: body.envKey },
    select: { id: true, cloudProviderId: true },
  });
  if (!env) {
    return NextResponse.json(
      { ok: false, code: "env_not_found", message: `Env "${body.envKey}" not found.` },
      { status: 404 },
    );
  }

  const kcfg = await getKubeconfigForEnv(env.id);
  if (!kcfg.ok) {
    return NextResponse.json(
      {
        ok: false,
        code: "no_cluster",
        message: `${kcfg.message} Connect a Kubernetes cluster to "${body.envKey}" first.`,
      },
      { status: 409 },
    );
  }

  try {
    const execEnv = await kubeExecEnv(kcfg.handle.path, env.cloudProviderId);

    // Route entries the SAME way the CD workflow does, so both paths agree:
    // `<SERVICE>__NAME` → Secret `app-env-<service>` as `NAME`; everything
    // else → the shared Secret. Without this, a name typed here would reach
    // the pod verbatim ("BACKEND__JWT_SECRET") and then silently change name
    // on the next deploy — the kind of drift that costs an afternoon.
    const planServices =
      (
        (
          await prisma.deploymentPlan.findUnique({
            where: { projectId: gate.access.project.id },
            select: { plan: true },
          })
        )?.plan as { report?: { services?: { name: string }[] } } | null
      )?.report?.services?.map((s) => s.name) ?? [];
    const svcToken = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "_");
    const k8sName = (s: string) => s.toLowerCase().replace(/[^a-z0-9-]/g, "-");
    const routed = new Map<string, { key: string; value: string }[]>();
    for (const e of entries) {
      const owner = planServices.find((s) => e.key.startsWith(`${svcToken(s)}__`));
      const bare = owner ? e.key.slice(svcToken(owner).length + 2) : e.key;
      const target = owner && bare ? `app-env-${k8sName(owner)}` : body.secretName;
      const list = routed.get(target) ?? [];
      list.push({ key: owner && bare ? bare : e.key, value: e.value });
      routed.set(target, list);
    }

    const appliedKeys: string[] = [];
    const targets = [...routed.keys()];
    for (const [secretName, list] of routed) {
      const res = await applyAppSecret({
        kubeconfigPath: kcfg.handle.path,
        execEnv,
        namespace: body.namespace,
        secretName,
        entries: list,
        // Per-service Secrets are always merged: this request only carries the
        // subset the user just edited, never that Secret's complete state.
        merge: secretName === body.secretName ? body.merge : true,
      });
      if (!res.ok) {
        return NextResponse.json(
          { ok: false, code: "apply_failed", message: res.error },
          { status: 409 },
        );
      }
      appliedKeys.push(...res.keys);
    }
    const applied = { ok: true as const, keys: appliedKeys };

    // Wire + roll. Best-effort: the Secret IS written at this point, so a
    // wiring failure must not present as total failure — it downgrades to
    // "written but not picked up", which the UI states plainly.
    // Wire each Secret we just wrote. The shared one goes onto every
    // Deployment; a per-service one goes ONLY onto its own service's
    // Deployment — wiring it everywhere would hand backend config to the
    // frontend and defeat the whole point of splitting them.
    let wired: WireOutcome[] = [];
    let wireError: string | undefined;
    for (const secretName of targets) {
      const svc = secretName.startsWith("app-env-")
        ? secretName.slice("app-env-".length)
        : undefined;
      const res = await wireSecretToWorkloads({
        kubeconfigPath: kcfg.handle.path,
        execEnv,
        namespace: body.namespace,
        secretName,
        ...(svc ? { onlyServiceSuffix: svc } : {}),
      });
      if (res.ok) wired.push(...res.outcomes);
      else wireError = wireError ? `${wireError}; ${res.error}` : res.error;
    }

    const patched = wired.filter((w) => w.status === "patched");
    const already = wired.filter((w) => w.status === "already");
    const failed = wired.filter((w) => w.status === "failed");

    // Mirror to GitHub so the next CD run re-materializes the same values —
    // without this, the deploy would overwrite this edit with GitHub's old
    // state. Best-effort: cluster write above is already durable.
    const github = await syncEntriesToGithub({
      projectId: gate.access.project.id,
      envKey: body.envKey,
      entries,
    });

    const githubSummary = !github.attempted
      ? ` GitHub sync skipped (${github.errors[0] ?? "no repo"}).`
      : github.errors.length
        ? ` GitHub sync: ${github.secretsWritten.length + github.varsWritten.length} value(s) written to environment "${github.environment}", ${github.errors.length} failed.`
        : ` Synced to GitHub environment "${github.environment}" (${github.secretsWritten.length} secret(s), ${github.varsWritten.length} variable(s)) — future deploys pick these up automatically.`;

    return NextResponse.json({
      ok: true,
      secretName: body.secretName,
      namespace: body.namespace,
      github,
      keysWritten: applied.keys,
      // Keys whose value points at the developer's machine. These are written
      // as-is (only the caller knows the app's real public address) but MUST be
      // surfaced: a localhost OAuth callback in a cluster produces
      // `oauth_error=missing_nonce`, an error that names neither localhost nor
      // the real cause.
      localhostKeys: findLocalhostValues(entries).map((e) => e.key),
      // Unparseable lines are reported rather than silently dropped — a
      // mangled line usually means a multi-line value, and losing it quietly
      // produces a "why is this key empty" hunt later.
      skippedLines: skipped,
      wired,
      wireError,
      summary:
        (failed.length || wireError
          ? `Secret "${body.secretName}" written with ${applied.keys.length} key(s), but wiring did not fully succeed${
              wireError ? ` (${wireError})` : ""
            }.`
          : `Wrote ${applied.keys.length} key(s) to "${body.secretName}" and rolled ${
              patched.length + already.length
            } deployment(s). Pods restart with the new values in ~30s.`) + githubSummary,
    });
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        code: "unexpected",
        message: e instanceof Error ? e.message : "Unexpected error writing app secrets.",
      },
      { status: 500 },
    );
  } finally {
    await kcfg.handle.cleanup().catch(() => {});
  }
}
