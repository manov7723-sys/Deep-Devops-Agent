import { analyzeAppServices } from "@/lib/automation/repo-analyze";
import type { Tool } from "./types";

type Input = {
  /** owner/repo — must be attached to the current project. */
  repoFullName: string;
};

type Output = {
  monorepo: boolean;
  services: Array<{
    name: string;
    path: string;
    stack: string;
    stackTitle: string;
    port: number;
    suggestedImageName: string;
    existingDockerfile: boolean;
  }>;
  summary: string;
};

/**
 * Analyze a repo and enumerate its deployable services — one app, or a monorepo
 * with a separate frontend + backend. The deploy flow calls this FIRST (fully
 * automated mode) to decide whether to ask the user for one ECR repo or two.
 */
export const analyzeAppServicesTool: Tool<Input, Output> = {
  name: "analyze_app_services",
  description:
    "Analyze an attached repo and list every DEPLOYABLE service in it: a single app, or a monorepo with a " +
    "separate FRONTEND and BACKEND (each with its own build path, stack and port). Call this at the START of the " +
    "fully-automated deploy flow — if it returns two services, you must ask the user which ECR repo to use for EACH " +
    "(list_ecr_repos for the existing ones, plus an auto-create option). Returns each service's path, stack, port and a " +
    "suggested image/ECR name.",
  inputSchema: {
    type: "object",
    properties: {
      repoFullName: { type: "string", description: "owner/repo, must be attached to the current project." },
    },
    required: ["repoFullName"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const det = await analyzeAppServices(ctx.projectId, input.repoFullName);
    if (!det.ok) return { ok: false, error: det.error };

    const services = det.services.map((s) => ({
      name: s.name,
      path: s.path,
      stack: s.stack,
      stackTitle: s.stackTitle,
      port: s.port,
      suggestedImageName: s.suggestedImageName,
      existingDockerfile: s.existingDockerfile,
    }));
    const summary = det.monorepo
      ? `Monorepo with ${services.length} services: ${services.map((s) => `${s.name} (${s.stackTitle}${s.path ? `, ./${s.path}` : ""})`).join(", ")}.`
      : `Single service: ${services[0].name} (${services[0].stackTitle}).`;

    return { ok: true, output: { monorepo: det.monorepo, services, summary } };
  },
};
