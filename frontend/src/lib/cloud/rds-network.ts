/**
 * Make an RDS instance reachable from an EKS cluster's worker nodes.
 *
 * WHY THIS EXISTS (2026-07 incident):
 * Connecting a database used to write a Kubernetes Secret and stop there,
 * assuming the network path already worked. It usually did — until a cluster
 * was rebuilt. A rebuilt cluster gets BRAND NEW node security groups, while
 * the RDS security group still allows only the old (now-deleted) SG. Every
 * query then fails with:
 *
 *     Can't reach database server at <endpoint>:5432
 *
 * which reads like "the database is down" and sends people hunting through
 * VPCs, subnets and credentials. The real fix is one inbound rule.
 *
 * This module closes that gap: given an env's cluster and an RDS instance, it
 * finds the cluster's CURRENT node security groups, checks whether the RDS
 * security group already admits them on the DB port, and adds the rule if not.
 *
 * Deliberately narrow:
 *   • Source is always the cluster's own security group — never a CIDR, and
 *     never 0.0.0.0/0.
 *   • Only the single DB port is opened.
 *   • Purely additive. Nothing is revoked, including stale rules from previous
 *     clusters — removing them is a judgement call for a human, and a wrong
 *     revoke can break another running workload.
 */
import { resolveAwsExecEnv } from "./aws-onboard";

/**
 * How the inbound rule identifies the cluster.
 *
 *   "security-group" — narrowest, and always preferred. Admits ONLY the
 *     cluster's nodes. Works same-VPC and across SAME-REGION peering.
 *   "cidr" — required for INTER-REGION peering, where AWS refuses
 *     security-group references entirely. Coarser: admits anything in the
 *     cluster's VPC CIDR on the DB port, not just the nodes. Used only when
 *     an SG reference is genuinely impossible, and always reported so the
 *     wider blast radius is a visible choice rather than a silent downgrade.
 */
export type RdsRuleKind = "security-group" | "cidr";

export type RdsNetworkFix =
  | {
      ok: true;
      /** true when a rule was actually created (false = access already existed). */
      changed: boolean;
      nodeSecurityGroups: string[];
      rdsSecurityGroup: string;
      port: number;
      /** How access was granted — see RdsRuleKind. */
      ruleKind: RdsRuleKind;
      /** Set when ruleKind === "cidr": the CIDR that was allowed. */
      allowedCidr?: string;
      /** True when the cluster and RDS live in different VPCs. */
      crossVpc: boolean;
      /** True when they also live in different regions. */
      crossRegion: boolean;
      message: string;
      /** Non-fatal advisories (e.g. peering looks absent, CIDR is broad). */
      warnings: string[];
    }
  | { ok: false; error: string };

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

/**
 * @param cloudProviderId AWS provider whose creds to use
 * @param region          region holding BOTH the cluster and the RDS instance
 * @param clusterName     EKS cluster whose nodes need access
 * @param dbIdentifier    RDS DBInstanceIdentifier
 */
export async function ensureRdsReachableFromCluster(args: {
  cloudProviderId: string;
  /** Region of the EKS CLUSTER. */
  region: string;
  clusterName: string;
  dbIdentifier: string;
  /** Region of the RDS instance when it differs from the cluster's. Omit when
   *  they share a region (the common case). */
  dbRegion?: string;
}): Promise<RdsNetworkFix> {
  const { cloudProviderId, region, clusterName, dbIdentifier } = args;
  const dbRegion = args.dbRegion?.trim() || region;
  const crossRegion = dbRegion !== region;
  const warnings: string[] = [];
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { join } = await import("node:path");
  const { tmpdir } = await import("node:os");

  const resolved = await resolveAwsExecEnv(cloudProviderId);
  if (!resolved.ok) return { ok: false, error: resolved.message };
  const env = { ...resolved.env, AWS_REGION: region, AWS_DEFAULT_REGION: region };
  const cwd = await mkdtemp(join(tmpdir(), "dda-rdsnet-"));

  try {
    // 1 — The cluster's node security groups.
    //
    // We ask the NODE GROUPS, not the cluster: cluster.resourcesVpcConfig holds
    // the CONTROL PLANE's security group, which is not what worker pods egress
    // from. Managed node groups report the SGs actually attached to instances.
    const ngList = await awsJson(
      ["eks", "list-nodegroups", "--cluster-name", clusterName],
      env,
      region,
      cwd,
    );
    if (!ngList.ok) {
      return { ok: false, error: `Could not list node groups: ${ngList.stderr.slice(-200)}` };
    }
    const ngNames = (ngList.json.nodegroups as string[] | undefined) ?? [];

    const nodeSgs = new Set<string>();
    for (const ng of ngNames) {
      const d = await awsJson(
        ["eks", "describe-nodegroup", "--cluster-name", clusterName, "--nodegroup-name", ng],
        env,
        region,
        cwd,
      );
      if (!d.ok) continue;
      const nodegroup = d.json.nodegroup as
        | { resources?: { remoteAccessSecurityGroup?: string } }
        | undefined;
      const rsg = nodegroup?.resources?.remoteAccessSecurityGroup;
      if (rsg) nodeSgs.add(rsg);
    }

    // The per-nodegroup SG above is only present when remote access is
    // configured. The SG that actually carries pod traffic is the cluster's
    // managed "additional" SG, which EKS attaches to every node.
    const cl = await awsJson(["eks", "describe-cluster", "--name", clusterName], env, region, cwd);
    let clusterVpcId: string | undefined;
    if (cl.ok) {
      const cluster = cl.json.cluster as
        | { resourcesVpcConfig?: { clusterSecurityGroupId?: string; vpcId?: string } }
        | undefined;
      const csg = cluster?.resourcesVpcConfig?.clusterSecurityGroupId;
      if (csg) nodeSgs.add(csg);
      clusterVpcId = cluster?.resourcesVpcConfig?.vpcId;
    }

    if (nodeSgs.size === 0) {
      return {
        ok: false,
        error:
          `Could not determine the security groups for cluster "${clusterName}". ` +
          "Add an inbound rule on the RDS security group allowing the cluster's nodes on the DB port manually.",
      };
    }

    // 2 — The RDS instance's security group, port and VPC. Described in the
    //     DB's OWN region, which may differ from the cluster's.
    const rds = await awsJson(
      ["rds", "describe-db-instances", "--db-instance-identifier", dbIdentifier],
      { ...env, AWS_REGION: dbRegion, AWS_DEFAULT_REGION: dbRegion },
      dbRegion,
      cwd,
    );
    if (!rds.ok) {
      return {
        ok: false,
        error: `Could not describe RDS "${dbIdentifier}" in ${dbRegion}: ${rds.stderr.slice(-200)}`,
      };
    }
    const inst = (rds.json.DBInstances as Array<Json> | undefined)?.[0];
    if (!inst) return { ok: false, error: `RDS instance "${dbIdentifier}" not found in ${dbRegion}.` };

    const port = Number((inst.Endpoint as { Port?: number } | undefined)?.Port ?? 5432);
    const rdsVpcId = (inst.DBSubnetGroup as { VpcId?: string } | undefined)?.VpcId;
    const rdsSgs = ((inst.VpcSecurityGroups as Array<{ VpcSecurityGroupId?: string; Status?: string }>) ?? [])
      .filter((g) => g.Status !== "removing")
      .map((g) => g.VpcSecurityGroupId)
      .filter((x): x is string => !!x);
    if (rdsSgs.length === 0) {
      return { ok: false, error: `RDS "${dbIdentifier}" has no VPC security group attached.` };
    }
    const rdsSg = rdsSgs[0];

    const crossVpc = !!clusterVpcId && !!rdsVpcId && clusterVpcId !== rdsVpcId;

    // 2b — Cross-VPC sanity: a firewall rule is worthless without a ROUTE.
    //      Peering (or TGW) must already exist; we check and advise rather than
    //      create one, because building network topology is a decision with
    //      cost and blast-radius that belongs to a human.
    if (crossVpc) {
      const pcx = await awsJson(
        [
          "ec2",
          "describe-vpc-peering-connections",
          "--filters",
          `Name=status-code,Values=active`,
          `Name=accepter-vpc-info.vpc-id,Values=${clusterVpcId},${rdsVpcId}`,
        ],
        env,
        region,
        cwd,
      );
      const conns =
        (pcx.json.VpcPeeringConnections as
          | Array<{
              AccepterVpcInfo?: { VpcId?: string };
              RequesterVpcInfo?: { VpcId?: string };
            }>
          | undefined) ?? [];
      const linked = conns.some((c) => {
        const a = c.AccepterVpcInfo?.VpcId;
        const r = c.RequesterVpcInfo?.VpcId;
        return (a === clusterVpcId && r === rdsVpcId) || (a === rdsVpcId && r === clusterVpcId);
      });
      if (!linked) {
        warnings.push(
          `No ACTIVE VPC peering found between the cluster VPC (${clusterVpcId}) and the RDS VPC (${rdsVpcId}). ` +
            "The security-group rule below is necessary but NOT sufficient — without peering (or a Transit Gateway) " +
            "plus route-table entries on BOTH sides, traffic still cannot reach the database.",
        );
      } else {
        warnings.push(
          `Cluster and RDS are in different VPCs (${clusterVpcId} → ${rdsVpcId}); an active peering connection exists. ` +
            "Confirm both route tables have entries pointing at it — a missing route fails identically to a missing firewall rule.",
        );
      }
    }

    // 3 — Which node SGs are already permitted on the DB port? Read in the
    //     RDS's region, since that is where its security group lives.
    const sgDesc = await awsJson(
      ["ec2", "describe-security-groups", "--group-ids", rdsSg],
      { ...env, AWS_REGION: dbRegion, AWS_DEFAULT_REGION: dbRegion },
      dbRegion,
      cwd,
    );
    if (!sgDesc.ok) {
      return { ok: false, error: `Could not read RDS security group: ${sgDesc.stderr.slice(-200)}` };
    }
    const perms =
      ((sgDesc.json.SecurityGroups as Array<Json> | undefined)?.[0]?.IpPermissions as
        | Array<{
            FromPort?: number;
            ToPort?: number;
            IpProtocol?: string;
            UserIdGroupPairs?: Array<{ GroupId?: string }>;
            IpRanges?: Array<{ CidrIp?: string }>;
          }>
        | undefined) ?? [];

    const allowedSgs = new Set<string>();
    const allowedCidrs = new Set<string>();
    for (const p of perms) {
      const covers =
        p.IpProtocol === "-1" ||
        (typeof p.FromPort === "number" &&
          typeof p.ToPort === "number" &&
          p.FromPort <= port &&
          p.ToPort >= port);
      if (!covers) continue;
      for (const pair of p.UserIdGroupPairs ?? []) if (pair.GroupId) allowedSgs.add(pair.GroupId);
      for (const r of p.IpRanges ?? []) if (r.CidrIp) allowedCidrs.add(r.CidrIp);
    }

    const { runStage } = await import("@/lib/runner/exec");

    /** Resolve the cluster VPC's CIDR blocks — the fallback rule source. */
    const clusterCidrs = async (): Promise<string[]> => {
      if (!clusterVpcId) return [];
      const v = await awsJson(["ec2", "describe-vpcs", "--vpc-ids", clusterVpcId], env, region, cwd);
      if (!v.ok) return [];
      const vpc = (v.json.Vpcs as Array<Json> | undefined)?.[0];
      const assoc =
        (vpc?.CidrBlockAssociationSet as Array<{ CidrBlock?: string; CidrBlockState?: { State?: string } }>) ??
        [];
      const fromAssoc = assoc
        .filter((a) => a.CidrBlockState?.State === "associated")
        .map((a) => a.CidrBlock)
        .filter((x): x is string => !!x);
      const primary = vpc?.CidrBlock as string | undefined;
      return fromAssoc.length ? fromAssoc : primary ? [primary] : [];
    };

    // ── Path A: security-group reference (preferred, narrowest) ───────────
    // Valid same-VPC and across SAME-REGION peering. AWS rejects SG references
    // over INTER-REGION peering, so that case falls through to Path B.
    const missingSgs = crossRegion ? [...nodeSgs] : [...nodeSgs].filter((sg) => !allowedSgs.has(sg));
    if (!crossRegion && missingSgs.length === 0) {
      return {
        ok: true,
        changed: false,
        nodeSecurityGroups: [...nodeSgs],
        rdsSecurityGroup: rdsSg,
        port,
        ruleKind: "security-group",
        crossVpc,
        crossRegion,
        warnings,
        message: `Network path already open — ${rdsSg} admits the cluster's security group(s) on port ${port}.`,
      };
    }

    const authorize = async (source: string[], kind: RdsRuleKind) => {
      const flag = kind === "cidr" ? "--cidr" : "--source-group";
      for (const s of source) {
        const res = await runStage({
          command: "aws",
          args: [
            "ec2",
            "authorize-security-group-ingress",
            "--group-id",
            rdsSg,
            "--protocol",
            "tcp",
            "--port",
            String(port),
            flag,
            s,
            "--region",
            dbRegion,
            "--output",
            "json",
            "--no-cli-pager",
          ],
          cwd,
          env: { ...env, AWS_REGION: dbRegion, AWS_DEFAULT_REGION: dbRegion },
          timeoutMs: 30_000,
        });
        const dup = /InvalidPermission\.Duplicate/i.test(res.stderr);
        if (res.exitCode !== 0 && !dup) return { ok: false as const, stderr: res.stderr };
      }
      return { ok: true as const, stderr: "" };
    };

    if (!crossRegion) {
      const r = await authorize(missingSgs, "security-group");
      if (r.ok) {
        return {
          ok: true,
          changed: true,
          nodeSecurityGroups: [...nodeSgs],
          rdsSecurityGroup: rdsSg,
          port,
          ruleKind: "security-group",
          crossVpc,
          crossRegion,
          warnings,
          message: `Opened port ${port} on ${rdsSg} for ${missingSgs.join(", ")} so the cluster's nodes can reach the database.`,
        };
      }
      // Some accounts/configurations reject the SG reference even same-region
      // (e.g. the peering exists but is not in a state that permits it). Rather
      // than fail outright, fall through to the CIDR path below and say so.
      warnings.push(
        `Security-group reference was rejected (${r.stderr.slice(-160)}); falling back to a VPC-CIDR rule.`,
      );
    }

    // ── Path B: VPC CIDR (required for inter-region peering) ──────────────
    // AWS does not support SG references across regions, so the only way to
    // express "the cluster" is its VPC's address range. Broader than an SG
    // reference — anything in that VPC can reach the DB port — which is a
    // property of inter-region peering itself, not of this implementation.
    // It is surfaced in `warnings` so the trade-off stays visible.
    const cidrs = await clusterCidrs();
    if (cidrs.length === 0) {
      return {
        ok: false,
        error:
          `Cross-region setup (cluster in ${region}, RDS in ${dbRegion}) requires a CIDR-based rule, ` +
          `but the cluster VPC's CIDR could not be determined. Add an inbound rule on ${rdsSg} ` +
          `allowing the cluster VPC's CIDR on port ${port} manually.`,
      };
    }

    const missingCidrs = cidrs.filter((c) => !allowedCidrs.has(c) && !allowedCidrs.has("0.0.0.0/0"));
    if (missingCidrs.length === 0) {
      return {
        ok: true,
        changed: false,
        nodeSecurityGroups: [...nodeSgs],
        rdsSecurityGroup: rdsSg,
        port,
        ruleKind: "cidr",
        allowedCidr: cidrs.join(", "),
        crossVpc,
        crossRegion,
        warnings,
        message: `Network path already open — ${rdsSg} admits ${cidrs.join(", ")} on port ${port}.`,
      };
    }

    const rc = await authorize(missingCidrs, "cidr");
    if (!rc.ok) {
      return {
        ok: false,
        error:
          `Could not open port ${port} on ${rdsSg} for ${missingCidrs.join(", ")}: ${rc.stderr.slice(-200)}. ` +
          "The connected AWS identity may lack ec2:AuthorizeSecurityGroupIngress.",
      };
    }

    warnings.push(
      `Rule scope is the whole VPC CIDR (${missingCidrs.join(", ")}), not just the cluster's nodes — ` +
        "AWS does not support security-group references across regions. Anything in that VPC can now reach " +
        `port ${port} on this database.`,
    );

    return {
      ok: true,
      changed: true,
      nodeSecurityGroups: [...nodeSgs],
      rdsSecurityGroup: rdsSg,
      port,
      ruleKind: "cidr",
      allowedCidr: missingCidrs.join(", "),
      crossVpc,
      crossRegion,
      warnings,
      message: `Opened port ${port} on ${rdsSg} for ${missingCidrs.join(", ")} (cross-region: CIDR rule required).`,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "Unexpected error fixing RDS network access." };
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => {});
  }
}
