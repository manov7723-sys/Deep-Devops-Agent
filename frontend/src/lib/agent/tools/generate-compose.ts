import { analyzeRepoForCompose } from "@/lib/automation/compose";
import type { Tool } from "./types";

type Input = { repoFullName: string };
type Output = {
  stackTitle: string;
  reasoning: string;
  files: Array<{ path: string; content: string }>;
  notes: string[];
  hasDockerfile: boolean;
};

/**
 * Detect a repo's stack and generate a vetted docker-compose.yml. The agent
 * detects the stack; the file comes from the vetted template (correct port
 * mapping, builds from the repo's Dockerfile). Show it, then commit with
 * write_repo_file or open a PR.
 */
export const generateComposeTool: Tool<Input, Output> = {
  name: "generate_compose",
  description:
    "Generate a vetted docker-compose.yml for a connected repo (detects the stack, maps the runtime port, " +
    "builds from the repo's Dockerfile). Use when the user wants to run the app locally with compose. Show the " +
    "file, then commit it with write_repo_file. If the repo has no Dockerfile, suggest generate_dockerfile first.",
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
    const res = await analyzeRepoForCompose(ctx.projectId, input.repoFullName);
    if (!res.ok) return { ok: false, error: res.error };
    return {
      ok: true,
      output: {
        stackTitle: res.stackTitle,
        reasoning: res.reasoning,
        files: res.files,
        notes: res.notes,
        hasDockerfile: res.hasDockerfile,
      },
    };
  },
};
