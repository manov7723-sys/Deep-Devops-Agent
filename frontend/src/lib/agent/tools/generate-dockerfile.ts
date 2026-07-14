import { generateDockerArtifacts, getStack, type DockerStackId } from "@/lib/ci/templates";
import type { Tool } from "./types";

type Input = {
  /** Stack id from list_dockerfile_stacks (static-spa | node-service | python | go). */
  stack: DockerStackId;
  /** Per-stack field values (buildDir, port, startCommand, etc.). Omitted fields use defaults. */
  params?: Record<string, unknown>;
};

type Output = {
  stack: string;
  files: Array<{ path: string; content: string }>;
  notes: string[];
};

/**
 * Generate a vetted Dockerfile (+ .dockerignore, docker-compose, and nginx.conf
 * for SPAs) for a detected stack. The templates are correct by construction —
 * multi-stage, non-root, right port, right output dir — so the agent never has
 * to (and must not) hand-write Docker syntax. Mirrors generate_k8s_manifest.
 */
export const generateDockerfileTool: Tool<Input, Output> = {
  name: "generate_dockerfile",
  description:
    "Generate a production-grade Dockerfile (plus .dockerignore, docker-compose.yml, and nginx.conf " +
    "for static SPAs) for a detected stack. ALWAYS use this instead of writing a Dockerfile yourself — " +
    "the templates are vetted (multi-stage, non-root, correct port and build output dir). First call " +
    "list_dockerfile_stacks, analyse the repo to choose the stack + fill the params, then call this. " +
    "Show the returned files to the user, then commit them with write_repo_file.",
  inputSchema: {
    type: "object",
    properties: {
      stack: {
        type: "string",
        enum: ["static-spa", "node-service", "python", "go"],
        description: "The stack id matching the analysed repo. See list_dockerfile_stacks.",
      },
      params: {
        type: "object",
        description:
          "Field values for the stack (e.g. {buildDir:'dist', nodeVersion:'20'} for static-spa, " +
          "{port:3000, startCommand:'node server.js'} for node-service). Omitted fields use safe defaults.",
        additionalProperties: true,
      },
    },
    required: ["stack"],
    additionalProperties: false,
  },
  async execute(input) {
    if (!getStack(input.stack)) {
      return {
        ok: false,
        error: `Unknown stack "${input.stack}". Call list_dockerfile_stacks for valid ids.`,
      };
    }
    try {
      const { files, notes } = generateDockerArtifacts({
        stack: input.stack,
        params: input.params,
      });
      return { ok: true, output: { stack: input.stack, files, notes } };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : "Failed to generate Dockerfile.",
      };
    }
  },
};
