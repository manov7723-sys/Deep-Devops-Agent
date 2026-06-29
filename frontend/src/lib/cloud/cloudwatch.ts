/**
 * CloudWatch alarms for an EKS cluster — set up entirely server-side with the
 * env's stored AWS credentials (via resolveAwsExecEnv), using the `aws` CLI the
 * same way the other AWS tools do. Nothing runs on the user's machine.
 *
 * Metrics:
 *   CPU Utilization    → AWS/EC2 CPUUtilization      (native, per worker node)
 *   Status Check Failed→ AWS/EC2 StatusCheckFailed   (native, per worker node)
 *   Memory             → ContainerInsights node_memory_utilization     (needs agent)
 *   Disk               → ContainerInsights node_filesystem_utilization  (needs agent)
 *
 * Memory/Disk live in the `ContainerInsights` namespace, which only exists once
 * the CloudWatch agent (Container Insights) runs on the cluster — so we install
 * the `amazon-cloudwatch-observability` EKS addon and attach
 * CloudWatchAgentServerPolicy to the node role.
 */
import { prisma } from "@/lib/db/prisma";
import { runStage } from "@/lib/runner/exec";
import { decryptSecret } from "@/lib/auth/crypto";
import { resolveAwsExecEnv } from "@/lib/cloud/aws-onboard";

const CW_AGENT_POLICY = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy";
const CI_ADDON = "amazon-cloudwatch-observability";

export type MetricKey = "cpu" | "status" | "memory" | "disk";

export type MetricDef = {
  key: MetricKey;
  label: string;
  namespace: string;
  metricName: string;
  statistic: string;
  comparison: string;
  threshold: number;
  /** true → one alarm per worker node (InstanceId dim); false → one cluster alarm (ClusterName dim). */
  perInstance: boolean;
  /** true → needs the CloudWatch agent / Container Insights. */
  needsAgent: boolean;
  unit?: string;
};

export const METRICS: Record<MetricKey, MetricDef> = {
  cpu: { key: "cpu", label: "CPU Utilization", namespace: "AWS/EC2", metricName: "CPUUtilization", statistic: "Average", comparison: "GreaterThanThreshold", threshold: 80, perInstance: true, needsAgent: false, unit: "%" },
  status: { key: "status", label: "Status Check Failed", namespace: "AWS/EC2", metricName: "StatusCheckFailed", statistic: "Maximum", comparison: "GreaterThanOrEqualToThreshold", threshold: 1, perInstance: true, needsAgent: false },
  memory: { key: "memory", label: "Memory Utilization", namespace: "ContainerInsights", metricName: "node_memory_utilization", statistic: "Average", comparison: "GreaterThanThreshold", threshold: 80, perInstance: false, needsAgent: true, unit: "%" },
  disk: { key: "disk", label: "Disk Utilization", namespace: "ContainerInsights", metricName: "node_filesystem_utilization", statistic: "Average", comparison: "GreaterThanThreshold", threshold: 80, perInstance: false, needsAgent: true, unit: "%" },
};

type AwsRun = { ok: true; exitCode: number; stdout: string; stderr: string } | { ok: false; error: string };

/** Run an `aws` CLI command for a cloud provider in a region. */
async function aws(env: Record<string, string>, region: string, args: string[], timeoutMs = 60_000): Promise<AwsRun> {
  const res = await runStage({
    command: "aws",
    args: [...args, "--region", region, "--output", "json", "--no-cli-pager"],
    cwd: process.cwd(),
    env: { ...env, AWS_REGION: region, AWS_DEFAULT_REGION: region },
    timeoutMs,
  });
  if (res.exitCode === -1 && res.stderr.includes("ENOENT")) return { ok: false, error: "`aws` CLI isn't installed on the server." };
  return { ok: true, exitCode: res.exitCode, stdout: res.stdout, stderr: res.stderr };
}

function awsErr(r: { stderr: string; stdout: string }, fallback: string): string {
  return (r.stderr.trim() || r.stdout.trim()).slice(-400) || fallback;
}

/** Best-effort EKS cluster name from the env's kubeconfig (the EKS ARN embeds it). */
export async function eksClusterFromEnv(envId: string): Promise<string | null> {
  const env = await prisma.env.findUnique({ where: { id: envId }, select: { kubeconfigRef: true } });
  if (!env?.kubeconfigRef) return null;
  try {
    const kc = decryptSecret(env.kubeconfigRef);
    // EKS kubeconfig embeds arn:aws:eks:<region>:<acct>:cluster/<name>
    const m = kc.match(/cluster\/([A-Za-z0-9][A-Za-z0-9._-]*)/);
    return m?.[1] ?? null;
  } catch {
    return null;
  }
}

export type NodeInstance = { instanceId: string; name: string };

/** Worker EC2 instances of an EKS cluster (managed node groups carry eks:cluster-name). */
export async function listEksNodeInstances(env: Record<string, string>, region: string, clusterName: string): Promise<{ ok: true; instances: NodeInstance[] } | { ok: false; error: string }> {
  const r = await aws(env, region, [
    "ec2", "describe-instances",
    "--filters", `Name=tag:eks:cluster-name,Values=${clusterName}`, "Name=instance-state-name,Values=running",
    "--query", "Reservations[].Instances[].{id:InstanceId,name:Tags[?Key=='Name']|[0].Value}",
  ]);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.exitCode !== 0) return { ok: false, error: awsErr(r, "describe-instances failed.") };
  try {
    const rows = JSON.parse(r.stdout || "[]") as Array<{ id: string; name?: string }>;
    return { ok: true, instances: rows.map((x) => ({ instanceId: x.id, name: x.name || x.id })) };
  } catch {
    return { ok: false, error: "Could not parse instance list." };
  }
}

/** Create (idempotent) an SNS topic and subscribe an email; returns the topic ARN. */
export async function ensureSnsTopic(env: Record<string, string>, region: string, name: string, email: string): Promise<{ ok: true; topicArn: string; pendingConfirmation: boolean } | { ok: false; error: string }> {
  const create = await aws(env, region, ["sns", "create-topic", "--name", name]);
  if (!create.ok) return { ok: false, error: create.error };
  if (create.exitCode !== 0) return { ok: false, error: awsErr(create, "create-topic failed.") };
  let topicArn: string;
  try {
    topicArn = (JSON.parse(create.stdout) as { TopicArn: string }).TopicArn;
  } catch {
    return { ok: false, error: "Could not read SNS topic ARN." };
  }
  const sub = await aws(env, region, ["sns", "subscribe", "--topic-arn", topicArn, "--protocol", "email", "--notification-endpoint", email]);
  if (!sub.ok) return { ok: false, error: sub.error };
  if (sub.exitCode !== 0) return { ok: false, error: awsErr(sub, "subscribe failed.") };
  return { ok: true, topicArn, pendingConfirmation: true };
}

/** Put one CloudWatch alarm. dims: array of Name=Value strings. */
async function putAlarm(
  env: Record<string, string>,
  region: string,
  args: { name: string; def: MetricDef; dims: Array<{ Name: string; Value: string }>; topicArn?: string; description: string },
): Promise<AwsRun> {
  const cli = [
    "cloudwatch", "put-metric-alarm",
    "--alarm-name", args.name,
    "--alarm-description", args.description,
    "--namespace", args.def.namespace,
    "--metric-name", args.def.metricName,
    "--statistic", args.def.statistic,
    "--period", "300",
    "--evaluation-periods", "1",
    "--threshold", String(args.def.threshold),
    "--comparison-operator", args.def.comparison,
    "--treat-missing-data", "missing",
    "--dimensions", ...args.dims.map((d) => `Name=${d.Name},Value=${d.Value}`),
  ];
  if (args.topicArn) cli.push("--alarm-actions", args.topicArn, "--ok-actions", args.topicArn);
  return aws(env, region, cli);
}

export type AlarmResult = { name: string; metric: MetricKey; label: string; target: string; ok: boolean; error?: string };

/** Create alarms for the chosen metrics across the cluster's nodes / cluster dim. */
export async function putEksAlarms(
  env: Record<string, string>,
  region: string,
  clusterName: string,
  instances: NodeInstance[],
  metrics: MetricKey[],
  topicArn?: string,
): Promise<AlarmResult[]> {
  const out: AlarmResult[] = [];
  for (const key of metrics) {
    const def = METRICS[key];
    if (def.perInstance) {
      for (const node of instances) {
        const name = `dda-${clusterName}-${key}-${node.instanceId}`;
        const r = await putAlarm(env, region, {
          name,
          def,
          dims: [{ Name: "InstanceId", Value: node.instanceId }],
          topicArn,
          description: `${def.label} ${def.comparison} ${def.threshold} on EKS node ${node.name} (${clusterName})`,
        });
        out.push({ name, metric: key, label: def.label, target: node.name, ok: r.ok && r.exitCode === 0, error: r.ok ? (r.exitCode !== 0 ? awsErr(r, "put-metric-alarm failed.") : undefined) : r.error });
      }
    } else {
      const name = `dda-${clusterName}-${key}`;
      const r = await putAlarm(env, region, {
        name,
        def,
        dims: [{ Name: "ClusterName", Value: clusterName }],
        topicArn,
        description: `${def.label} ${def.comparison} ${def.threshold} across EKS cluster ${clusterName}`,
      });
      out.push({ name, metric: key, label: def.label, target: clusterName, ok: r.ok && r.exitCode === 0, error: r.ok ? (r.exitCode !== 0 ? awsErr(r, "put-metric-alarm failed.") : undefined) : r.error });
    }
  }
  return out;
}

/**
 * Enable Container Insights so Memory/Disk node metrics exist: attach
 * CloudWatchAgentServerPolicy to each node's IAM role, then create the
 * amazon-cloudwatch-observability EKS addon. Best-effort; returns a note.
 */
export async function installContainerInsights(
  env: Record<string, string>,
  region: string,
  clusterName: string,
  instances: NodeInstance[],
): Promise<{ ok: boolean; note: string }> {
  const roles = new Set<string>();
  for (const node of instances) {
    const prof = await aws(env, region, ["ec2", "describe-instances", "--instance-ids", node.instanceId, "--query", "Reservations[].Instances[].IamInstanceProfile.Arn"]);
    if (!prof.ok || prof.exitCode !== 0) continue;
    try {
      const arns = JSON.parse(prof.stdout || "[]") as string[];
      const profileName = arns[0]?.split("/").pop();
      if (!profileName) continue;
      const gp = await aws(env, region, ["iam", "get-instance-profile", "--instance-profile-name", profileName, "--query", "InstanceProfile.Roles[].RoleName"]);
      if (gp.ok && gp.exitCode === 0) {
        for (const rn of JSON.parse(gp.stdout || "[]") as string[]) roles.add(rn);
      }
    } catch {
      /* skip */
    }
  }
  for (const role of roles) {
    await aws(env, region, ["iam", "attach-role-policy", "--role-name", role, "--policy-arn", CW_AGENT_POLICY]);
  }
  const addon = await aws(env, region, ["eks", "create-addon", "--cluster-name", clusterName, "--addon-name", CI_ADDON], 120_000);
  if (addon.ok && addon.exitCode === 0) return { ok: true, note: "Container Insights addon installing — memory/disk metrics appear in ~5 min." };
  const err = addon.ok ? awsErr(addon, "") : addon.error;
  if (/already (exists|in use)|ResourceInUse/i.test(err)) return { ok: true, note: "Container Insights already enabled." };
  return { ok: false, note: `Could not enable Container Insights: ${err}. Memory/disk alarms won't have data until the CloudWatch agent runs.` };
}

export type AlarmState = { name: string; state: "OK" | "ALARM" | "INSUFFICIENT_DATA" | string };

/** Describe the state of this app's alarms for a cluster (for syncing into Alerts). */
export async function describeEksAlarmStates(env: Record<string, string>, region: string, clusterName: string): Promise<{ ok: true; alarms: AlarmState[] } | { ok: false; error: string }> {
  const r = await aws(env, region, ["cloudwatch", "describe-alarms", "--alarm-name-prefix", `dda-${clusterName}-`, "--query", "MetricAlarms[].{name:AlarmName,state:StateValue}"]);
  if (!r.ok) return { ok: false, error: r.error };
  if (r.exitCode !== 0) return { ok: false, error: awsErr(r, "describe-alarms failed.") };
  try {
    return { ok: true, alarms: JSON.parse(r.stdout || "[]") as AlarmState[] };
  } catch {
    return { ok: false, error: "Could not parse alarm states." };
  }
}

export type SetupResult = {
  ok: boolean;
  clusterName: string;
  region: string;
  nodeCount: number;
  topicArn?: string;
  alarms: AlarmResult[];
  containerInsights?: string;
  error?: string;
};

/** Full orchestration: discover nodes → SNS → Container Insights (if needed) → alarms. */
export async function setupEksCloudWatchAlarms(opts: {
  cloudProviderId: string;
  clusterName: string;
  region?: string;
  email?: string;
  metrics: MetricKey[];
}): Promise<SetupResult> {
  const resolved = await resolveAwsExecEnv(opts.cloudProviderId);
  if (!resolved.ok) return { ok: false, clusterName: opts.clusterName, region: opts.region ?? "", nodeCount: 0, alarms: [], error: resolved.message };
  const region = (opts.region || resolved.region).trim();
  const env = resolved.env;

  const nodes = await listEksNodeInstances(env, region, opts.clusterName);
  if (!nodes.ok) return { ok: false, clusterName: opts.clusterName, region, nodeCount: 0, alarms: [], error: nodes.error };
  if (nodes.instances.length === 0) {
    return { ok: false, clusterName: opts.clusterName, region, nodeCount: 0, alarms: [], error: `No running worker nodes found for cluster "${opts.clusterName}" in ${region}. Check the cluster name/region.` };
  }

  let topicArn: string | undefined;
  if (opts.email) {
    const topic = await ensureSnsTopic(env, region, `dda-eks-${opts.clusterName}-alarms`, opts.email);
    if (topic.ok) topicArn = topic.topicArn;
    else return { ok: false, clusterName: opts.clusterName, region, nodeCount: nodes.instances.length, alarms: [], error: `SNS setup failed: ${topic.error}` };
  }

  let ciNote: string | undefined;
  if (opts.metrics.some((m) => METRICS[m].needsAgent)) {
    const ci = await installContainerInsights(env, region, opts.clusterName, nodes.instances);
    ciNote = ci.note;
  }

  const alarms = await putEksAlarms(env, region, opts.clusterName, nodes.instances, opts.metrics, topicArn);
  return {
    ok: alarms.some((a) => a.ok),
    clusterName: opts.clusterName,
    region,
    nodeCount: nodes.instances.length,
    topicArn,
    alarms,
    containerInsights: ciNote,
  };
}
