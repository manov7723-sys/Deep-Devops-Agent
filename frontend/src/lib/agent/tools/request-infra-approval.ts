/**
 * request_infra_approval — the apply GATE. Instead of applying Terraform
 * directly, the agent calls this: it runs the deterministic policy checks and,
 * if they pass, creates a PENDING approval carrying the plan + cost + payload.
 * Nothing is provisioned until a human approves on the Approvals page (which
 * then runs the apply). If policy FAILS, no approval is created and the agent
 * must tell the user what to fix.
 */
import { prisma } from "@/lib/db/prisma";
import type { Tool } from "./types";
import { createInfraApproval, type TerraformFile } from "@/lib/devops/infra-approval";
import { estimateInfraCost } from "@/lib/cost/estimate";
import type { Cloud } from "@/lib/policy/infra-policy";

type Input = {
  envKey: string;
  cloud: Cloud;
  title: string;
  summary?: string;
  region?: string;
  instanceType?: string;
  nodeCount?: number;
  managedK8s?: boolean;
  storageGb?: number;
  loadBalancers?: number;
  publicBucket?: boolean;
  name: string;
  stack?: string;
  files: Record<string, string>;
  planSummary?: Array<{ change: "add" | "remove" | "info"; text: string }>;
};

type Output =
  | { status: "pending_approval"; approvalId: string; risk: string; costMonthly: number; message: string }
  | { status: "blocked"; violations: Array<{ rule: string; message: string; severity: string }>; message: string };

export const requestInfraApprovalTool: Tool<Input, Output> = {
  name: "request_infra_approval",
  description:
    "Submit an infrastructure change to the APPROVAL GATE instead of applying it directly. ALWAYS use this in place " +
    "of run_terraform action='apply'. It runs policy checks (blocks public storage, oversized/GPU instances, " +
    "non-allowed regions, admin ports open to the world) and, if they pass, creates a PENDING approval with the " +
    "plan + estimated monthly cost. A human then approves it on the Approvals page, which runs the apply. Pass the " +
    "same Terraform `files` (path→content map) and `stack` you'd pass to run_terraform, plus the cloud/region/" +
    "instanceType/nodeCount so the cost + policy can be evaluated. If it returns status='blocked', DO NOT retry — " +
    "tell the user which rule failed and how to fix it.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: { type: "string", description: "Env key whose cloud creds + state to use." },
      cloud: { type: "string", enum: ["aws", "azure", "gcp"], description: "Cloud provider." },
      title: { type: "string", description: "Short title for the approval, e.g. 'Create EKS cluster prod-eks'." },
      summary: { type: "string", description: "One-line description of what this change does." },
      region: { type: "string", description: "Target region (checked against the allow-list)." },
      instanceType: { type: "string", description: "Node/VM instance type (checked for oversized/GPU + priced)." },
      nodeCount: { type: "number", description: "Number of nodes/VMs (for the cost estimate)." },
      managedK8s: { type: "boolean", description: "True if this provisions a managed K8s cluster (adds control-plane cost)." },
      storageGb: { type: "number", description: "Total block storage GB (for the cost estimate)." },
      loadBalancers: { type: "number", description: "Public load balancers (for the cost estimate)." },
      publicBucket: { type: "boolean", description: "True if this creates a PUBLIC object-storage bucket (will be blocked by policy)." },
      name: { type: "string", description: "Terraform run label (same as run_terraform 'name')." },
      stack: { type: "string", description: "Stable logical stack name (same as run_terraform 'stack')." },
      files: { type: "object", description: "Terraform files as a path→content map (same as run_terraform 'files')." },
      planSummary: {
        type: "array",
        description: "Human-readable plan lines to show on the approval card.",
        items: {
          type: "object",
          properties: { change: { type: "string", enum: ["add", "remove", "info"] }, text: { type: "string" } },
          required: ["change", "text"],
          additionalProperties: false,
        },
      },
    },
    required: ["envKey", "cloud", "title", "name", "files"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const env = await prisma.env.findFirst({ where: { projectId: ctx.projectId, key: input.envKey }, select: { id: true, key: true } });
    if (!env) return { ok: false, error: `Env "${input.envKey}" not found in this project.` };

    const files: TerraformFile[] = Object.entries(input.files || {}).map(([path, content]) => ({ path, content: String(content) }));
    if (files.length === 0) return { ok: false, error: "No Terraform files provided." };

    const est = estimateInfraCost({
      cloud: input.cloud,
      instanceType: input.instanceType,
      nodeCount: input.nodeCount,
      managedK8s: input.managedK8s,
      storageGb: input.storageGb,
      loadBalancers: input.loadBalancers,
    });

    const res = await createInfraApproval({
      projectId: ctx.projectId,
      envId: env.id,
      envKey: env.key,
      title: input.title,
      summary: input.summary,
      cloud: input.cloud,
      region: input.region,
      instanceType: input.instanceType,
      publicBucket: input.publicBucket,
      name: input.name,
      stack: input.stack,
      files,
      costMonthly: est.monthly,
      planSummary: input.planSummary,
    });

    if (!res.ok) {
      return {
        ok: true,
        output: {
          status: "blocked",
          violations: res.policy.violations,
          message: `Policy blocked this change: ${res.policy.violations.map((v) => v.message).join(" ")} Fix these and resubmit — nothing was created.`,
        },
      };
    }

    return {
      ok: true,
      output: {
        status: "pending_approval",
        approvalId: res.approvalId,
        risk: res.risk,
        costMonthly: est.monthly,
        message: `Change submitted for approval (~$${est.monthly}/month, risk: ${res.risk}). It will NOT be applied until a human approves it on the Approvals page.`,
      },
    };
  },
};
