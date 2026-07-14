import { generateManifest, getManifestKind } from "@/lib/devops/manifest-templates";
import type { Tool } from "./types";

type Input = {
  /** Kubernetes kind, e.g. "Deployment", "Service", "Namespace". */
  kind: string;
  /** apiVersion, e.g. "apps/v1". Defaults to the kind's standard apiVersion. */
  apiVersion?: string;
  /** Whether the kind is namespaced. Defaults to the kind's standard. */
  namespaced?: boolean;
  /**
   * Field values collected from the user: at least { name } (+ namespace for
   * namespaced kinds), plus per-kind fields (image, replicas, port, etc.).
   */
  values: Record<string, string>;
};

type Output = { kind: string; apiVersion: string; yaml: string };

/**
 * Deterministically generate a production-style Kubernetes manifest from
 * collected field values — the SAME templates the static manifest builder uses.
 * NEVER hand-write the YAML yourself; always use this tool so the output is
 * valid and consistent. After generating, push it with write_repo_file.
 */
export const generateK8sManifestTool: Tool<Input, Output> = {
  name: "generate_k8s_manifest",
  description:
    "Generate a production-style Kubernetes manifest (YAML) from field values, deterministically. " +
    "Use after collecting the kind, apiVersion, name/namespace and per-kind fields from the user. " +
    "Returns the YAML — then push it to a repo with write_repo_file (openPullRequest=true).",
  inputSchema: {
    type: "object",
    properties: {
      kind: { type: "string", description: 'Kubernetes kind, e.g. "Deployment".' },
      apiVersion: { type: "string", description: 'apiVersion, e.g. "apps/v1". Optional.' },
      namespaced: { type: "boolean", description: "Whether the kind is namespaced. Optional." },
      values: {
        type: "object",
        description:
          'Field values, e.g. {"name":"web","namespace":"default","image":"nginx:1.27","replicas":"2"}.',
        additionalProperties: { type: "string" },
      },
    },
    required: ["kind", "values"],
    additionalProperties: false,
  },
  async execute(input) {
    const kind = input.kind.trim();
    if (!kind) return { ok: false, error: "kind is required." };
    if (!input.values?.name?.trim()) return { ok: false, error: "values.name is required." };

    const tpl = getManifestKind(kind);
    const namespaced = input.namespaced ?? tpl?.namespaced ?? true;
    const apiVersion = (input.apiVersion ?? tpl?.apiVersion ?? "v1").trim();

    const yaml = generateManifest(input.values, { apiVersion, kind, namespaced });
    return { ok: true, output: { kind, apiVersion, yaml } };
  },
};
