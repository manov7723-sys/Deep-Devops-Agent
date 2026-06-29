import { HELM_FIELDS } from "@/lib/devops/helm-templates";
import type { Tool } from "./types";

type Output = {
  fields: Array<{
    name: string;
    label: string;
    type: string;
    required: boolean;
    options?: string[];
    default?: string;
    hint?: string;
  }>;
};

/**
 * Catalog for the Helm chart wizard: every field the chart builder needs, with
 * its type, options and defaults. The agent calls this FIRST when the user wants
 * a Helm chart, so it can ask the right questions (one at a time) and then call
 * generate_helm_chart with the collected values.
 */
export const listHelmChartFieldsTool: Tool<Record<string, never>, Output> = {
  name: "list_helm_chart_fields",
  description:
    "List the fields the Helm chart builder needs (name, image, port, replicas, service, ingress, " +
    "autoscaling, env, etc.), their types, options and defaults. Call this FIRST when the user wants " +
    "to build/create a Helm chart, so you know which questions to ask before calling generate_helm_chart.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute() {
    const fields = HELM_FIELDS.map((f) => ({
      name: f.name,
      label: f.label,
      type: f.type,
      required: !!f.required,
      ...(f.options ? { options: f.options } : {}),
      ...(f.default !== undefined ? { default: f.default } : {}),
      ...(f.hint ? { hint: f.hint } : {}),
    }));
    return { ok: true, output: { fields } };
  },
};
