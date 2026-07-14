import { scanRepoWithTrivy } from "@/lib/automation/trivy";
import type { Tool } from "./types";

type Input = { repoFullName: string };
type Output = {
  artifact: string;
  total: number;
  counts: Record<string, number>;
  findings: Array<{
    class: string;
    target: string;
    pkgName: string;
    vulnerabilityId: string;
    severity: string;
    fixedVersion: string;
    title: string;
  }>;
};

/**
 * Run Trivy against a connected repo and return vulnerabilities, misconfigurations
 * and secrets. Use this when the user asks to scan a repo, check security, or
 * before/after generating IaC. Summarise the findings by severity for the user.
 */
export const trivyScanTool: Tool<Input, Output> = {
  name: "trivy_scan",
  description:
    "Scan a connected GitHub repo for security issues with Trivy — vulnerable dependencies, IaC/Dockerfile " +
    "misconfigurations, and hardcoded secrets. Returns findings grouped by severity (CRITICAL/HIGH/MEDIUM/LOW). " +
    "Use when the user asks to scan, audit security, or check a repo. Summarise the top findings and offer to fix them.",
  inputSchema: {
    type: "object",
    properties: {
      repoFullName: {
        type: "string",
        description: 'The repo as "owner/name", attached to this project.',
      },
    },
    required: ["repoFullName"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const res = await scanRepoWithTrivy(ctx.projectId, input.repoFullName);
    if (!res.ok) return { ok: false, error: res.error };
    return {
      ok: true,
      output: {
        artifact: res.artifact,
        total: res.total,
        counts: res.counts,
        // Cap what we hand the model so the context stays small.
        findings: res.findings.slice(0, 40).map((f) => ({
          class: f.class,
          target: f.target,
          pkgName: f.pkgName || f.location,
          vulnerabilityId: f.vulnerabilityId,
          severity: f.severity,
          fixedVersion: f.fixedVersion,
          title: f.title,
        })),
      },
    };
  },
};
