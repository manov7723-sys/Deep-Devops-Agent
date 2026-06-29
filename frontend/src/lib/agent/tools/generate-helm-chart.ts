import { buildHelmChart } from "@/lib/devops/helm-templates";
import type { Tool } from "./types";

type Input = {
  /**
   * Field values collected from the user. At least { name, image }. See
   * list_helm_chart_fields for the full schema (tag, replicaCount, containerPort,
   * serviceType, ingressEnabled, autoscalingEnabled, env, etc.).
   */
  values: Record<string, string>;
};

type Output = {
  chartName: string;
  fileCount: number;
  /** path-relative-to-chart-dir -> file contents */
  files: Record<string, string>;
};

/**
 * Deterministically generate a complete, production-style Helm chart (Chart.yaml,
 * values.yaml, templates/*) from collected field values — the SAME templates the
 * static Helm chart builder uses. NEVER hand-write chart YAML yourself; always use
 * this tool. After generating, push the files with write_repo_file (one per file,
 * under <chartDir>/<path>, openPullRequest=true on the first) or deploy them with
 * run_helm_upgrade.
 */
export const generateHelmChartTool: Tool<Input, Output> = {
  name: "generate_helm_chart",
  description:
    "Generate a complete production-style Helm chart (Chart.yaml, values.yaml, templates/deployment, " +
    "service, ingress, hpa, serviceaccount, _helpers.tpl, NOTES.txt) from field values, deterministically. " +
    "Use after collecting the fields from list_helm_chart_fields. Returns the file tree (path -> contents); " +
    "then push each file with write_repo_file under a chart directory, or deploy with run_helm_upgrade.",
  inputSchema: {
    type: "object",
    properties: {
      values: {
        type: "object",
        description:
          'Field values, e.g. {"name":"api","image":"ghcr.io/org/api","tag":"v1.2.0","containerPort":"8080",' +
          '"replicaCount":"2","serviceType":"ClusterIP","ingressEnabled":"true","ingressHost":"api.example.com"}.',
        additionalProperties: { type: "string" },
      },
    },
    required: ["values"],
    additionalProperties: false,
  },
  async execute(input) {
    if (!input.values?.name?.trim()) return { ok: false, error: "values.name is required." };
    if (!input.values?.image?.trim()) return { ok: false, error: "values.image (image repository) is required." };
    const chart = buildHelmChart(input.values);
    return { ok: true, output: { chartName: chart.chartName, fileCount: chart.fileCount, files: chart.files } };
  },
};
