/**
 * Grant an IAM principal (a role) Kubernetes RBAC on an EKS cluster via **EKS
 * Access Entries** — the modern, additive, API-driven way. NO `aws-auth`
 * ConfigMap surgery (which risks breaking the node role and bricking the
 * cluster). This is what lets a GitHub-Actions CD role — or the app's own
 * assumed role, on a cluster it didn't create — actually deploy.
 *
 * Every step is idempotent and shells out to the `aws` CLI through runStage
 * (same model as github-oidc.ts), so we don't pull in the AWS SDK.
 *
 * Steps:
 *   1. describe-cluster → authenticationMode. If CONFIG_MAP (legacy), bump to
 *      API_AND_CONFIG_MAP — SAFE/additive: keeps existing aws-auth entries
 *      working — and wait for the cluster to go ACTIVE again.
 *   2. create-access-entry for the principal (already-exists → fine).
 *   3. associate-access-policy — Edit on a namespace (least-priv, default) or
 *      ClusterAdmin.
 *   4. (optional) put-role-policy adding eks:DescribeCluster on the cluster so
 *      the role's own `aws eks update-kubeconfig` works.
 */
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runStage } from "@/lib/runner/exec";

/** AWS-managed EKS access policies (cluster-access-policy ARNs are global — no account/region). */
const EDIT_POLICY = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSEditPolicy";
const ADMIN_POLICY = "arn:aws:eks::aws:cluster-access-policy/AmazonEKSClusterAdminPolicy";

export type GrantEksAccessInput = {
  /** Ready-to-use AWS credential env from resolveAwsExecEnv() — must be an identity that already has admin on the cluster. */
  awsEnv: Record<string, string>;
  /** Region the cluster lives in (parse from the env's kubeconfig ARN). */
  region: string;
  /** EKS cluster name. */
  clusterName: string;
  /** IAM principal (role ARN) to grant. */
  roleArn: string;
  /** 'edit' = namespace-scoped least-privilege (default), 'admin' = cluster-admin. */
  accessLevel?: "edit" | "admin";
  /** Namespaces for edit scope (default ["default"]). */
  namespaces?: string[];
  /** When set, ALSO add an inline eks:DescribeCluster policy to this role (so its `aws eks update-kubeconfig` works). */
  roleName?: string;
};

export type GrantEksAccessResult =
  | { ok: true; clusterName: string; roleArn: string; authenticationMode: string; steps: string[] }
  | { ok: false; code: "cli_not_installed" | "creds_missing" | "bad_input" | "aws_error"; message: string; stderr?: string };

/** Run one `aws` CLI invocation with the resolved creds + region (same as github-oidc.ts). */
async function aws(
  args: string[],
  env: Record<string, string>,
  region: string,
  cwd: string,
): Promise<{ ok: boolean; stdout: string; stderr: string; notInstalled: boolean }> {
  const res = await runStage({
    command: "aws",
    args: [...args, "--region", region, "--output", "json", "--no-cli-pager"],
    cwd,
    env: { ...env, AWS_REGION: region, AWS_DEFAULT_REGION: region },
    timeoutMs: 60_000,
  });
  const notInstalled = res.exitCode === -1 && (res.stderr.includes("ENOENT") || res.stderr.includes("[exec]"));
  return { ok: res.exitCode === 0, stdout: res.stdout, stderr: res.stderr, notInstalled };
}

function tail(s: string): string {
  return s.slice(-1_000);
}

/**
 * Extract { region, accountId, clusterName } from an EKS kubeconfig. `aws eks
 * update-kubeconfig` writes the full cluster ARN as the context/cluster name,
 * so one regex over the whole file is the reliable source of truth.
 */
export function parseEksClusterRef(kubeconfig: string): { region: string; accountId: string; clusterName: string } | null {
  const m = kubeconfig.match(/arn:aws:eks:([a-z0-9-]+):(\d{12}):cluster\/([A-Za-z0-9._-]+)/);
  if (!m) return null;
  return { region: m[1], accountId: m[2], clusterName: m[3] };
}

export async function grantEksAccess(input: GrantEksAccessInput): Promise<GrantEksAccessResult> {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(input.clusterName)) {
    return { ok: false, code: "bad_input", message: `Invalid cluster name "${input.clusterName}".` };
  }
  if (!/^arn:aws:iam::\d{12}:role\/.+/.test(input.roleArn)) {
    return { ok: false, code: "bad_input", message: `"${input.roleArn}" is not a valid IAM role ARN.` };
  }

  const { awsEnv, region, clusterName, roleArn } = input;
  const level = input.accessLevel ?? "edit";
  const namespaces = input.namespaces?.length ? input.namespaces : ["default"];
  const steps: string[] = [];
  const workdir = await mkdtemp(join(tmpdir(), "dda-eks-access-"));

  try {
    // 1 — Authentication mode. Access Entries require API or API_AND_CONFIG_MAP.
    const desc = await aws(["eks", "describe-cluster", "--name", clusterName], awsEnv, region, workdir);
    if (desc.notInstalled) {
      return { ok: false, code: "cli_not_installed", message: "The `aws` CLI isn't on the server's PATH." };
    }
    if (!desc.ok) {
      const lower = desc.stderr.toLowerCase();
      if (lower.includes("unable to locate credentials") || lower.includes("no credentials")) {
        return { ok: false, code: "creds_missing", message: "No usable AWS credentials for this account." };
      }
      return { ok: false, code: "aws_error", message: `eks describe-cluster failed for "${clusterName}".`, stderr: tail(desc.stderr) };
    }
    let authMode = "CONFIG_MAP";
    try {
      authMode = (JSON.parse(desc.stdout) as { cluster?: { accessConfig?: { authenticationMode?: string } } }).cluster?.accessConfig?.authenticationMode ?? "CONFIG_MAP";
    } catch {
      /* keep default */
    }

    if (authMode === "CONFIG_MAP") {
      const upd = await aws(
        ["eks", "update-cluster-config", "--name", clusterName, "--access-config", "authenticationMode=API_AND_CONFIG_MAP"],
        awsEnv, region, workdir,
      );
      if (!upd.ok) {
        return { ok: false, code: "aws_error", message: "Couldn't enable EKS access entries (update authentication mode) — the AWS identity may lack eks:UpdateClusterConfig.", stderr: tail(upd.stderr) };
      }
      steps.push("Enabled access-entry auth mode (API_AND_CONFIG_MAP) — existing aws-auth entries kept.");
      // update-cluster-config is async; wait for the cluster to settle before writing an entry.
      for (let i = 0; i < 25; i++) {
        await new Promise((r) => setTimeout(r, 6_000));
        const d = await aws(["eks", "describe-cluster", "--name", clusterName], awsEnv, region, workdir);
        let status = "";
        try {
          status = (JSON.parse(d.stdout) as { cluster?: { status?: string } }).cluster?.status ?? "";
        } catch {
          /* ignore */
        }
        if (status === "ACTIVE") break;
      }
      authMode = "API_AND_CONFIG_MAP";
    } else {
      steps.push(`Cluster auth mode is ${authMode} — access entries supported.`);
    }

    // 2 — Access entry for the principal (idempotent).
    const createEntry = await aws(
      ["eks", "create-access-entry", "--cluster-name", clusterName, "--principal-arn", roleArn, "--type", "STANDARD"],
      awsEnv, region, workdir,
    );
    if (createEntry.ok) {
      steps.push(`Created access entry for ${roleArn}.`);
    } else if (createEntry.stderr.includes("ResourceInUseException")) {
      steps.push(`Access entry for ${roleArn} already existed — reused.`);
    } else {
      return { ok: false, code: "aws_error", message: "Could not create the EKS access entry.", stderr: tail(createEntry.stderr) };
    }

    // 3 — Associate the access policy (idempotent).
    const policyArn = level === "admin" ? ADMIN_POLICY : EDIT_POLICY;
    const scope = level === "admin" ? ["--access-scope", "type=cluster"] : ["--access-scope", `type=namespace,namespaces=${namespaces.join(",")}`];
    const assoc = await aws(
      ["eks", "associate-access-policy", "--cluster-name", clusterName, "--principal-arn", roleArn, "--policy-arn", policyArn, ...scope],
      awsEnv, region, workdir,
    );
    if (!assoc.ok && !assoc.stderr.includes("ResourceInUseException")) {
      return { ok: false, code: "aws_error", message: "Could not associate the EKS access policy.", stderr: tail(assoc.stderr) };
    }
    steps.push(level === "admin" ? "Associated cluster-admin access." : `Associated edit access on namespace(s): ${namespaces.join(", ")}.`);

    // 4 — Optional: give the role eks:DescribeCluster so its own update-kubeconfig works.
    if (input.roleName) {
      const accountId = roleArn.split(":")[4];
      const doc = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Action: "eks:DescribeCluster", Resource: `arn:aws:eks:${region}:${accountId}:cluster/${clusterName}` }] };
      const docPath = join(workdir, "eks-describe.json");
      await writeFile(docPath, JSON.stringify(doc), "utf8");
      const put = await aws(
        ["iam", "put-role-policy", "--role-name", input.roleName, "--policy-name", "eks-describe", "--policy-document", `file://${docPath}`],
        awsEnv, region, workdir,
      );
      steps.push(put.ok ? `Added eks:DescribeCluster permission to ${input.roleName}.` : `(warning) couldn't add eks:DescribeCluster to ${input.roleName}.`);
    }

    return { ok: true, clusterName, roleArn, authenticationMode: authMode, steps };
  } finally {
    await rm(workdir, { recursive: true, force: true }).catch(() => {});
  }
}
