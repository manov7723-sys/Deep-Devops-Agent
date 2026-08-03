/**
 * Open a workload port inbound on an EKS cluster's node security groups.
 *
 * WHY THIS EXISTS (2026-08 incident):
 * A Next.js frontend deployed via `deploy_my_app` came up healthy — pod
 * Ready, endpoint bound, LB provisioned — but the public URL returned
 * ERR_CONNECTION_TIMED_OUT. The AWS Load Balancer Controller registers pod
 * IPs directly as NLB/ALB targets when `target-type: ip` is set (which the
 * generated manifests always do). Traffic then flows straight from the LB
 * ENIs to the pod's ENI on the pod's containerPort — bypassing the node's
 * NodePort. If the node SG doesn't admit that port from 0.0.0.0/0, every
 * connection times out with no error surface anywhere: the pod is Ready,
 * the LB is Active, the target group shows healthy — because the LB's own
 * health checks originate inside the VPC and succeed.
 *
 * Neither the AWS Load Balancer Controller nor the in-tree cloud controller
 * manages this rule automatically for `type: LoadBalancer` + `target-type: ip`;
 * the operator has always had to open it by hand. This helper closes the gap
 * so a `deploy_my_app` call yields an app that is actually reachable, without
 * anyone touching the AWS console.
 *
 * Deliberately narrow:
 *   • Only the app's container port is opened, never a range.
 *   • Rules are ADD-ONLY — nothing existing is revoked (leftovers from prior
 *     ports are a judgement call for a human).
 *   • Duplicates are treated as success (idempotent — safe to re-run on every
 *     deploy).
 */
import { resolveAwsExecEnv } from "./aws-onboard";

type Json = Record<string, unknown>;

async function awsJson(
  args: string[],
  env: Record<string, string>,
  region: string,
  cwd: string,
): Promise<{ ok: boolean; json: Json; stderr: string }> {
  const { runStage } = await import("@/lib/runner/exec");
  const res = await runStage({
    command: "aws",
    args: [...args, "--region", region, "--output", "json", "--no-cli-pager"],
    cwd,
    env,
    timeoutMs: 30_000,
    maxBufferBytes: 4 * 1024 * 1024,
  });
  if (res.exitCode !== 0) return { ok: false, json: {}, stderr: res.stderr };
  try {
    return { ok: true, json: JSON.parse(res.stdout) as Json, stderr: "" };
  } catch {
    return { ok: false, json: {}, stderr: "unparseable AWS response" };
  }
}

export type NodeSgFix =
  | {
      ok: true;
      /** true when at least one rule was actually created (false = all pre-existing). */
      changed: boolean;
      nodeSecurityGroups: string[];
      port: number;
      message: string;
    }
  | { ok: false; error: string };

/**
 * Ensure every SG attached to the cluster's worker nodes admits `port` from
 * 0.0.0.0/0 inbound on TCP. Idempotent — duplicate-rule errors are treated
 * as success. Non-fatal on partial failure so a deploy still proceeds; the
 * caller reports the message and the user can widen the rule manually if
 * needed.
 */
export async function ensureNodeSgAllowsWorkloadPort(args: {
  cloudProviderId: string;
  region: string;
  clusterName: string;
  port: number;
  /**
   * Source CIDR. Defaults to 0.0.0.0/0 because internet-facing LBs with
   * `nlb-target-type: ip` + `preserveClientIP=true` (the LBC default) forward
   * the CLIENT's public IP to the pod, not the LB's ENI. Restricting to the
   * VPC CIDR would break every request from a real browser.
   */
  sourceCidr?: string;
}): Promise<NodeSgFix> {
  const { cloudProviderId, region, clusterName, port } = args;
  const sourceCidr = args.sourceCidr || "0.0.0.0/0";
  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    return { ok: false, error: `Invalid workload port ${port}.` };
  }

  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");

  const resolved = await resolveAwsExecEnv(cloudProviderId);
  if (!resolved.ok) return { ok: false, error: resolved.message };
  const env = { ...resolved.env, AWS_REGION: region, AWS_DEFAULT_REGION: region };
  const cwd = await mkdtemp(join(tmpdir(), "dda-nodesg-"));

  try {
    // 1 — Discover the cluster's node SGs. Same logic as rds-network.ts: we
    //     query running EC2 instances tagged for this cluster, because the
    //     control-plane's `clusterSecurityGroupId` is NOT what worker pods
    //     egress from on the terraform-aws-modules EKS module (which creates
    //     a separate node SG). The instance query is the authoritative answer;
    //     the two describe fallbacks are only for scaled-to-zero clusters.
    const nodeSgs = new Set<string>();

    const cl = await awsJson(
      ["eks", "describe-cluster", "--name", clusterName],
      env,
      region,
      cwd,
    );
    let clusterSg: string | undefined;
    if (cl.ok) {
      const cluster = cl.json.cluster as
        | { resourcesVpcConfig?: { clusterSecurityGroupId?: string } }
        | undefined;
      clusterSg = cluster?.resourcesVpcConfig?.clusterSecurityGroupId;
    }

    const nodeInstances = await awsJson(
      [
        "ec2",
        "describe-instances",
        "--filters",
        `Name=tag:kubernetes.io/cluster/${clusterName},Values=owned,shared`,
        "Name=instance-state-name,Values=running",
      ],
      env,
      region,
      cwd,
    );
    if (nodeInstances.ok) {
      const reservations =
        (nodeInstances.json.Reservations as
          | Array<{ Instances?: Array<{ SecurityGroups?: Array<{ GroupId?: string }> }> }>
          | undefined) ?? [];
      for (const r of reservations)
        for (const i of r.Instances ?? [])
          for (const g of i.SecurityGroups ?? []) if (g.GroupId) nodeSgs.add(g.GroupId);
    }

    // Every AWS-managed EKS cluster attaches its `clusterSecurityGroupId` to
    // every worker ENI (and to every pod ENI via VPC CNI). Always include it,
    // not just when nodeSgs is empty — otherwise pods on ENIs that ONLY carry
    // the cluster SG (VPC CNI's default) still can't be reached.
    if (clusterSg) nodeSgs.add(clusterSg);

    if (nodeSgs.size === 0) {
      return {
        ok: false,
        error:
          `Could not determine the node security groups for cluster "${clusterName}". ` +
          `Add an inbound TCP rule on the node SG allowing ${sourceCidr} on port ${port} manually.`,
      };
    }

    // 2 — For each SG, check if the port is already open. Skip authorize calls
    //     for ones that are — cheaper than swallowing an InvalidPermission
    //     .Duplicate, and clearer in the log.
    const alreadyOpen = new Set<string>();
    for (const sgId of nodeSgs) {
      const sgDesc = await awsJson(
        ["ec2", "describe-security-groups", "--group-ids", sgId],
        env,
        region,
        cwd,
      );
      if (!sgDesc.ok) continue;
      const perms =
        ((sgDesc.json.SecurityGroups as Array<Json> | undefined)?.[0]?.IpPermissions as
          | Array<{
              FromPort?: number;
              ToPort?: number;
              IpProtocol?: string;
              IpRanges?: Array<{ CidrIp?: string }>;
            }>
          | undefined) ?? [];
      const covers = perms.some((p) => {
        const proto = p.IpProtocol === "-1" || p.IpProtocol === "tcp";
        const portOk =
          p.IpProtocol === "-1" ||
          (typeof p.FromPort === "number" &&
            typeof p.ToPort === "number" &&
            p.FromPort <= port &&
            p.ToPort >= port);
        const cidrOk = (p.IpRanges ?? []).some(
          (r) => r.CidrIp === sourceCidr || r.CidrIp === "0.0.0.0/0",
        );
        return proto && portOk && cidrOk;
      });
      if (covers) alreadyOpen.add(sgId);
    }

    const missing = [...nodeSgs].filter((sg) => !alreadyOpen.has(sg));
    if (missing.length === 0) {
      return {
        ok: true,
        changed: false,
        nodeSecurityGroups: [...nodeSgs],
        port,
        message: `Node SG(s) ${[...nodeSgs].join(", ")} already admit ${sourceCidr} on port ${port}.`,
      };
    }

    // 3 — Authorize on each missing SG. Duplicates → treat as success (a race
    //     with a parallel deploy or a rule added between describe and
    //     authorize).
    const { runStage } = await import("@/lib/runner/exec");
    const failures: string[] = [];
    let changed = false;
    for (const sgId of missing) {
      const res = await runStage({
        command: "aws",
        args: [
          "ec2",
          "authorize-security-group-ingress",
          "--group-id",
          sgId,
          "--protocol",
          "tcp",
          "--port",
          String(port),
          "--cidr",
          sourceCidr,
          "--region",
          region,
          "--output",
          "json",
          "--no-cli-pager",
        ],
        cwd,
        env,
        timeoutMs: 30_000,
      });
      const dup = /InvalidPermission\.Duplicate/i.test(res.stderr);
      if (res.exitCode !== 0 && !dup) {
        failures.push(`${sgId}: ${res.stderr.slice(-160)}`);
      } else if (!dup) {
        changed = true;
      }
    }

    if (failures.length) {
      return {
        ok: false,
        error:
          `Opened port ${port} on ${missing.length - failures.length}/${missing.length} node SG(s); ` +
          `failed on: ${failures.join(" | ")}. The connected AWS identity may lack ` +
          `ec2:AuthorizeSecurityGroupIngress on the cluster's SGs.`,
      };
    }

    return {
      ok: true,
      changed,
      nodeSecurityGroups: [...nodeSgs],
      port,
      message:
        changed
          ? `Opened port ${port} inbound from ${sourceCidr} on node SG(s): ${missing.join(", ")}.`
          : `Node SG(s) already admit ${sourceCidr} on port ${port}.`,
    };
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}
