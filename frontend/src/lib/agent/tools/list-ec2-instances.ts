import { prisma } from "@/lib/db/prisma";
import { runStage } from "@/lib/runner/exec";
import { resolveAwsExecEnv } from "@/lib/cloud/aws-onboard";
import type { Tool } from "./types";

type Input = {
  /** AWS region to query. Defaults to the connected provider's region. */
  region?: string;
  /** Optional state filter: running, stopped, pending, terminated, stopping. */
  state?: string;
};

type Ec2Item = {
  instanceId: string;
  name?: string;
  type: string;
  state: string;
  privateIp?: string;
  publicIp?: string;
  az?: string;
  launchTime?: string;
};

type Output = {
  region: string;
  count: number;
  items: Ec2Item[];
};

const ALLOWED_STATES = new Set([
  "running",
  "stopped",
  "pending",
  "terminated",
  "stopping",
  "shutting-down",
]);

/**
 * Find the AWS CloudProvider this project should use. Prefers a provider linked
 * to one of the project's envs; falls back to the user's most recent AWS account.
 */
async function resolveAwsProviderId(projectId: string, userId: string): Promise<string | null> {
  const env = await prisma.env.findFirst({
    where: { projectId, cloudProvider: { kind: "aws" } },
    select: { cloudProviderId: true },
    orderBy: { createdAt: "asc" },
  });
  if (env?.cloudProviderId) return env.cloudProviderId;

  const cp = await prisma.cloudProvider.findFirst({
    where: { userId, kind: "aws" },
    select: { id: true },
    orderBy: { createdAt: "desc" },
  });
  return cp?.id ?? null;
}

/**
 * Read-only EC2 inventory tool. Lists EC2 instances in the project's connected
 * AWS account using the cross-account role (assumed via STS) or stored Vault
 * keys. Never mutates anything. Output is normalized so the agent can reason
 * about it without raw AWS JSON.
 */
export const listEc2InstancesTool: Tool<Input, Output> = {
  name: "list_ec2_instances",
  description:
    "List EC2 instances in the project's connected AWS account. Use this to answer " +
    "questions like 'what EC2 instances are running?', 'list my servers', 'show stopped instances'. " +
    "Read-only — never starts/stops/terminates anything. Requires an AWS account connected on the " +
    "Cloud providers tab. Optionally filter by region or instance state (running, stopped, etc.).",
  inputSchema: {
    type: "object",
    properties: {
      region: {
        type: "string",
        description: "AWS region (e.g. us-east-1). Defaults to the connected account's region.",
      },
      state: {
        type: "string",
        description: "Optional state filter: running, stopped, pending, terminated, stopping.",
      },
    },
    required: [],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const providerId = await resolveAwsProviderId(ctx.projectId, ctx.userId);
    if (!providerId) {
      return {
        ok: false,
        error:
          "No AWS account is connected. Connect one on the project's Cloud providers tab first.",
      };
    }

    const resolved = await resolveAwsExecEnv(providerId);
    if (!resolved.ok) {
      return { ok: false, error: resolved.message };
    }

    const region = (input.region ?? resolved.region).trim();
    const args = [
      "ec2",
      "describe-instances",
      "--region",
      region,
      "--output",
      "json",
      "--no-cli-pager",
    ];

    const state = input.state?.toLowerCase().trim();
    if (state) {
      if (!ALLOWED_STATES.has(state)) {
        return {
          ok: false,
          error: `Unsupported state "${input.state}". Allowed: running, stopped, pending, terminated, stopping.`,
        };
      }
      args.push("--filters", `Name=instance-state-name,Values=${state}`);
    }

    const res = await runStage({
      command: "aws",
      args,
      cwd: process.cwd(),
      env: { ...resolved.env, AWS_REGION: region, AWS_DEFAULT_REGION: region },
      timeoutMs: 30_000,
    });

    if (res.exitCode !== 0) {
      if (res.exitCode === -1 && (res.stderr.includes("ENOENT") || res.stderr.includes("[exec]"))) {
        return {
          ok: false,
          error: "The `aws` CLI isn't installed on the server. Install it on the runner host.",
        };
      }
      return { ok: false, error: `aws ec2 describe-instances failed: ${res.stderr.slice(-500)}` };
    }

    let parsed: { Reservations?: Array<{ Instances?: unknown[] }> };
    try {
      parsed = JSON.parse(res.stdout) as { Reservations?: Array<{ Instances?: unknown[] }> };
    } catch {
      return { ok: false, error: "aws returned non-JSON output." };
    }

    const items: Ec2Item[] = [];
    for (const r of parsed.Reservations ?? []) {
      for (const raw of r.Instances ?? []) {
        items.push(normalise(raw));
        if (items.length >= 200) break;
      }
    }

    return { ok: true, output: { region, count: items.length, items } };
  },
};

function normalise(raw: unknown): Ec2Item {
  const i = raw as {
    InstanceId?: string;
    InstanceType?: string;
    State?: { Name?: string };
    PrivateIpAddress?: string;
    PublicIpAddress?: string;
    Placement?: { AvailabilityZone?: string };
    LaunchTime?: string;
    Tags?: Array<{ Key?: string; Value?: string }>;
  };
  const name = i.Tags?.find((t) => t.Key === "Name")?.Value;
  return {
    instanceId: i.InstanceId ?? "(unknown)",
    ...(name ? { name } : {}),
    type: i.InstanceType ?? "?",
    state: i.State?.Name ?? "?",
    ...(i.PrivateIpAddress ? { privateIp: i.PrivateIpAddress } : {}),
    ...(i.PublicIpAddress ? { publicIp: i.PublicIpAddress } : {}),
    ...(i.Placement?.AvailabilityZone ? { az: i.Placement.AvailabilityZone } : {}),
    ...(i.LaunchTime ? { launchTime: i.LaunchTime } : {}),
  };
}
