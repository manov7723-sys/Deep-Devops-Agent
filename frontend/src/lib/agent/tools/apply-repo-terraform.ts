/**
 * apply_repo_terraform — plan or apply Terraform that ALREADY EXISTS in a
 * connected repo, in ONE call. Reads every .tf file at the given path itself
 * (list + read, server-side) and feeds them straight into the same plan /
 * approval-gate machinery run_terraform and request_infra_approval use.
 *
 * Exists specifically so the agent never has to ask the user to paste file
 * contents, or chain list_files_in_repo + read_github_file + run_terraform +
 * request_infra_approval across multiple turns — that multi-step dance is
 * exactly what was causing the agent to loop asking permission repeatedly.
 * One tool call in, one deterministic result out.
 */
import { prisma } from "@/lib/db/prisma";
import { resolveRepoClient } from "@/lib/git";
import { startTerraformRun } from "@/lib/devops/terraform-run";
import { pickBackendForEnv } from "@/lib/devops/envs";
import { createInfraApproval, type TerraformFile } from "@/lib/devops/infra-approval";
import { estimateInfraCost } from "@/lib/cost/estimate";
import type { Cloud } from "@/lib/policy/infra-policy";
import type { Tool } from "./types";

type Input = {
  repoFullName: string;
  /** Folder inside the repo containing the .tf files, e.g. "terraform/eks/agent". Not recursive. */
  path: string;
  envKey: string;
  action: "plan" | "apply";
  ref?: string;
  /** Stable logical stack name. Defaults to the repo path (slashes → dashes). */
  stack?: string;
};

type PlanOutput = {
  mode: "plan";
  runId: string;
  status: string;
  filesRead: string[];
  note: string;
};
type ApplyOutput = {
  mode: "apply";
  status: "pending_approval" | "blocked";
  approvalId?: string;
  risk?: string;
  costMonthly?: number;
  violations?: Array<{ rule: string; message: string; severity: string }>;
  filesRead: string[];
  message: string;
};

// Best-effort extraction from OUR OWN generated Terraform (eks.ts/gke.ts/aks.ts)
// so the cost estimate + policy check are accurate for the common case: a repo
// path that was pushed by this app's own cluster-creation flow.
function sniffSpec(combined: string): { managedK8s: boolean; instanceType?: string; nodeCount?: number; region?: string } {
  const managedK8s = /module\s+"(eks|gke|aks)"|terraform-aws-modules\/eks|google_container_cluster|azurerm_kubernetes_cluster/.test(combined);
  const instanceType =
    combined.match(/instance_types\s*=\s*\["([^"]+)"/)?.[1] ??
    combined.match(/machine_type\s*=\s*"([^"]+)"/)?.[1] ??
    combined.match(/vm_size\s*=\s*"([^"]+)"/)?.[1];
  const nodeCountRaw = combined.match(/desired_size\s*=\s*(\d+)/)?.[1] ?? combined.match(/node_count\s*=\s*(\d+)/)?.[1];
  const region = combined.match(/region\s*=\s*"([^"]+)"/)?.[1] ?? combined.match(/location\s*=\s*"([^"]+)"/)?.[1];
  return { managedK8s, instanceType, nodeCount: nodeCountRaw ? Number(nodeCountRaw) : undefined, region };
}

export const applyRepoTerraformTool: Tool<Input, PlanOutput | ApplyOutput> = {
  name: "apply_repo_terraform",
  description:
    "Plan or apply Terraform that ALREADY EXISTS in a connected repo — use this whenever the user references " +
    "Terraform already pushed to a repo path (e.g. 'apply the terraform in <repo>/<path>'), instead of asking them " +
    "to paste file contents or chaining list_files_in_repo/read_github_file yourself. This ONE call reads every " +
    ".tf file at the path, then action='plan' previews it, or action='apply' submits it to the approval gate " +
    "(same as request_infra_approval — nothing is provisioned until a human approves). Cloud + credentials are " +
    "inferred automatically from the environment's connected provider.",
  inputSchema: {
    type: "object",
    properties: {
      repoFullName: { type: "string", description: 'owner/repo, must be attached to this project.' },
      path: { type: "string", description: "Folder inside the repo containing the .tf files, e.g. 'terraform/eks/agent'. Not recursive." },
      envKey: { type: "string", description: "Env whose cloud credentials + state backend to use." },
      action: { type: "string", enum: ["plan", "apply"], description: "plan = preview, apply = submit for approval." },
      ref: { type: "string", description: "Optional branch/tag/commit. Defaults to the repo's default branch." },
      stack: { type: "string", description: "Stable logical stack name. Defaults to the path." },
    },
    required: ["repoFullName", "path", "envKey", "action"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const repo = await prisma.repo.findFirst({
      where: { fullName: input.repoFullName, deletedAt: null, projectRepos: { some: { projectId: ctx.projectId } } },
      select: { id: true, defaultBranch: true, fullName: true },
    });
    if (!repo) return { ok: false, error: `Repo "${input.repoFullName}" isn't attached to this project.` };

    const resolved = await resolveRepoClient(repo.id);
    if (!resolved.ok) return { ok: false, error: `Cannot access ${input.repoFullName}: ${resolved.message}` };

    const ref = input.ref ?? repo.defaultBranch;
    const cleanPath = input.path.replace(/^\/+|\/+$/g, "");
    if (!cleanPath) return { ok: false, error: "Path is required — the repo root is refused (too broad)." };

    let entries: Array<{ name: string; path: string; type: "file" | "dir" }>;
    try {
      entries = await resolved.client.listFiles(cleanPath, ref);
    } catch (err) {
      return { ok: false, error: `Could not list ${repo.fullName}/${cleanPath}@${ref}: ${err instanceof Error ? err.message : "unknown"}` };
    }
    const tfEntries = entries.filter((e) => e.type === "file" && e.name.endsWith(".tf"));
    if (tfEntries.length === 0) {
      return {
        ok: false,
        error: `No .tf files found at ${repo.fullName}/${cleanPath}@${ref}. Double-check the path — if it looks like a segment repeated twice (e.g. "terraform/eks/x/terraform/eks/x"), use the single non-repeated form instead.`,
      };
    }

    const files: Record<string, string> = {};
    for (const e of tfEntries) {
      const content = await resolved.client.readFile(e.path, ref);
      if (content === null) return { ok: false, error: `Could not read ${e.path} — it disappeared or isn't a file.` };
      files[e.name] = content;
    }

    const env = await prisma.env.findFirst({
      where: { projectId: ctx.projectId, key: input.envKey },
      select: {
        id: true,
        key: true,
        cloudProviderId: true,
        tfBackendBucket: true,
        tfBackendRegion: true,
        tfBackendTable: true,
        tfBackendGcsBucket: true,
        tfBackendAzureResourceGroup: true,
        tfBackendAzureStorageAccount: true,
        tfBackendAzureContainer: true,
        cloudProvider: { select: { kind: true } },
      },
    });
    if (!env) return { ok: false, error: `Env "${input.envKey}" not found in this project.` };

    const stack = input.stack?.trim() || cleanPath.replace(/\//g, "-");
    const filesRead = Object.keys(files);

    if (input.action === "plan") {
      // Pick the backend that matches the env's cloud (never blindly S3) —
      // so a GKE apply on a GCP env uses GCS, an AKS apply on Azure uses
      // azurerm, etc. Legacy S3 columns are ignored when the env is not AWS.
      const backend = pickBackendForEnv(env);
      const run = startTerraformRun({
        projectId: ctx.projectId,
        envId: env.id,
        envKey: env.key,
        cloudProviderId: env.cloudProviderId,
        name: `${stack}-plan`,
        action: "plan",
        files,
        backend,
        stack,
      });
      return {
        ok: true,
        output: {
          mode: "plan",
          runId: run.id,
          status: run.status,
          filesRead,
          note: `Plan started (run ${run.id}) for ${filesRead.length} file(s) read from ${repo.fullName}/${cleanPath}. Track live stages on the Infrastructure tab.`,
        },
      };
    }

    // action === "apply" — always through the approval gate, never a direct apply.
    if (!env.cloudProviderId) {
      return { ok: false, error: `Env "${input.envKey}" has no cloud provider connected — connect one before applying.` };
    }
    const provider = await prisma.cloudProvider.findUnique({ where: { id: env.cloudProviderId }, select: { kind: true, region: true } });
    const cloud = (provider?.kind ?? "aws") as Cloud;

    const combined = Object.values(files).join("\n");
    const sniffed = sniffSpec(combined);

    const est = estimateInfraCost({
      cloud,
      instanceType: sniffed.instanceType,
      nodeCount: sniffed.nodeCount,
      managedK8s: sniffed.managedK8s,
    });

    const res = await createInfraApproval({
      projectId: ctx.projectId,
      envId: env.id,
      envKey: env.key,
      title: `Apply ${stack} (from ${repo.fullName}/${cleanPath})`,
      summary: `Applying ${filesRead.length} Terraform file(s) already committed at ${repo.fullName}/${cleanPath}@${ref}.`,
      cloud,
      region: sniffed.region ?? provider?.region ?? undefined,
      instanceType: sniffed.instanceType,
      name: `${stack}-apply`,
      stack,
      files: Object.entries(files).map(([path, content]): TerraformFile => ({ path, content })),
      costMonthly: est.monthly,
      planSummary: filesRead.map((f) => ({ change: "info" as const, text: `Apply ${f} (from ${repo.fullName}/${cleanPath})` })),
    });

    if (!res.ok) {
      return {
        ok: true,
        output: {
          mode: "apply",
          status: "blocked",
          violations: res.policy.violations,
          filesRead,
          message: `Policy blocked this change: ${res.policy.violations.map((v) => v.message).join(" ")} Fix these in the repo and resubmit — nothing was created.`,
        },
      };
    }

    return {
      ok: true,
      output: {
        mode: "apply",
        status: "pending_approval",
        approvalId: res.approvalId,
        risk: res.risk,
        costMonthly: est.monthly,
        filesRead,
        message: `Submitted for approval (~$${est.monthly}/month, risk: ${res.risk}). Nothing is applied until a human approves it.`,
      },
    };
  },
};
