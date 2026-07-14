import { DOCKER_STACKS } from "@/lib/ci/templates";
import type { Tool } from "./types";

type Input = Record<string, never>;
type Output = {
  stacks: Array<{
    id: string;
    title: string;
    detect: string;
    fields: Array<{
      key: string;
      type: string;
      description: string;
      default?: string | number;
      options?: string[];
    }>;
  }>;
};

/**
 * Discovery tool for Dockerfile generation. The agent calls this first to see
 * which stacks are supported and which fields each needs, then picks the stack
 * matching the repo it analysed and calls generate_dockerfile. Same pattern as
 * list_k8s_manifest_kinds / list_helm_chart_fields.
 */
export const listDockerfileStacksTool: Tool<Input, Output> = {
  name: "list_dockerfile_stacks",
  description:
    "List the supported Docker stacks (static SPA→nginx, Node service, Python, Go) and the fields " +
    "each needs. Call this BEFORE generate_dockerfile so you know which stack matches the repo you " +
    "analysed and which parameters to pass. NEVER hand-write a Dockerfile — always generate it.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute() {
    return {
      ok: true,
      output: {
        stacks: DOCKER_STACKS.map((s) => ({
          id: s.id,
          title: s.title,
          detect: s.detect,
          fields: s.fields.map((f) => ({
            key: f.key,
            type: f.type,
            description: f.description,
            ...(f.default !== undefined ? { default: f.default } : {}),
            ...(f.options ? { options: f.options } : {}),
          })),
        })),
      },
    };
  },
};
