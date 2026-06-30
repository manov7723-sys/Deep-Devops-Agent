import type { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages";
import { listReposTool } from "./list-repos";
import { readGithubFileTool } from "./read-github-file";
import { listFilesInRepoTool } from "./list-files-in-repo";
import { writeRepoFileTool } from "./write-repo-file";
import { scaffoldHelmChartTool } from "./scaffold-helm-chart";
import { listKubernetesResourcesTool } from "./list-kubernetes-resources";
import { getKubernetesLogsTool } from "./get-kubernetes-logs";
import { runHelmUpgradeTool } from "./run-helm-upgrade";
import { listEc2InstancesTool } from "./list-ec2-instances";
import { listAzureVmsTool } from "./list-azure-vms";
import { listAzureSubscriptionsTool } from "./list-azure-subscriptions";
import { listAzureResourceGroupsTool } from "./list-azure-resource-groups";
import { setAzureContextTool } from "./set-azure-context";
import { aksRunCommandTool } from "./aks-run-command";
import { queryPrometheusTool } from "./query-prometheus";
import { queryClusterPrometheusTool } from "./query-cluster-prometheus";
import { createScrapeTargetTool } from "./create-scrape-target";
import { detectAppMetricsTool } from "./detect-app-metrics";
import { setupCloudWatchAlarmsTool } from "./setup-cloudwatch-alarms";
import { setupAzureMonitorAlarmsTool } from "./setup-azure-monitor-alarms";
import { setupGcpMonitorAlarmsTool } from "./setup-gcp-monitor-alarms";
import { listGcpInstancesTool } from "./list-gcp-instances";
import { listGcpProjectsTool, setGcpContextTool } from "./gcp-context-tools";
import { setupGithubOidcEcrTool } from "./setup-github-oidc-ecr";
import { listDockerfileStacksTool } from "./list-dockerfile-stacks";
import { generateDockerfileTool } from "./generate-dockerfile";
import { generateEcrWorkflowTool } from "./generate-ecr-workflow";
import { verifyDockerBuildTool } from "./verify-docker-build";
import { savePipelineToProjectTool } from "./save-pipeline-to-project";
import { runTerraformTool } from "./run-terraform";
import { provisionEksTool } from "./provision-eks";
import { listK8sManifestKindsTool } from "./list-k8s-manifest-kinds";
import { generateK8sManifestTool } from "./generate-k8s-manifest";
import { applyK8sManifestTool } from "./apply-k8s-manifest";
import { listHelmChartFieldsTool } from "./list-helm-chart-fields";
import { generateHelmChartTool } from "./generate-helm-chart";
import { trivyScanTool } from "./trivy-scan";
import { generateComposeTool } from "./generate-compose";
import { generateCiWorkflowTool, generateTrivyWorkflowTool } from "./generate-ci-workflow";
import { listAlertsTool } from "./list-alerts";
import { listArtifactRegistriesTool, createArtifactRegistryTool, setupGcpGithubWifTool, generateGarWorkflowTool } from "./gcp-registry-tools";
import { listAcrTool, createAcrTool, setupAzureGithubOidcTool, generateAcrWorkflowTool } from "./azure-registry-tools";
import type { Tool, ToolContext, ToolExecuteResult } from "./types";

export type { Tool, ToolContext, ToolExecuteResult } from "./types";

/**
 * The canonical list of tools the agent has access to. New tools land here.
 * Order is preserved in Claude's system prompt so put the most-used tools
 * first if you care about that heuristic.
 */
export const ALL_TOOLS: Tool[] = [
  // GitHub read
  listReposTool,
  listFilesInRepoTool,
  readGithubFileTool,
  // GitHub write
  writeRepoFileTool,
  scaffoldHelmChartTool,
  // Kubernetes read
  listKubernetesResourcesTool,
  getKubernetesLogsTool,
  // AWS read
  listEc2InstancesTool,
  // Azure read
  listAzureSubscriptionsTool,
  listAzureResourceGroupsTool,
  listAzureVmsTool,
  setAzureContextTool,
  // Azure AKS operate (no kubeconfig — via run-command)
  aksRunCommandTool,
  // GCP read
  listGcpProjectsTool,
  listGcpInstancesTool,
  setGcpContextTool,
  // Observability
  queryClusterPrometheusTool,
  queryPrometheusTool,
  detectAppMetricsTool,
  createScrapeTargetTool,
  setupCloudWatchAlarmsTool,
  setupAzureMonitorAlarmsTool,
  setupGcpMonitorAlarmsTool,
  // CI/CD (Docker + GitHub Actions -> ECR over OIDC)
  listDockerfileStacksTool,
  generateDockerfileTool,
  generateComposeTool,
  generateCiWorkflowTool,
  verifyDockerBuildTool,
  setupGithubOidcEcrTool,
  generateEcrWorkflowTool,
  savePipelineToProjectTool,
  // Security
  trivyScanTool,
  generateTrivyWorkflowTool,
  // Incidents / alerts
  listAlertsTool,
  // GCP CI → Artifact Registry (keyless WIF)
  listArtifactRegistriesTool,
  createArtifactRegistryTool,
  setupGcpGithubWifTool,
  generateGarWorkflowTool,
  // Azure CI → ACR (keyless OIDC)
  listAcrTool,
  createAcrTool,
  setupAzureGithubOidcTool,
  generateAcrWorkflowTool,
  // Infra (IaC)
  provisionEksTool,
  runTerraformTool,
  // Kubernetes manifests
  listK8sManifestKindsTool,
  generateK8sManifestTool,
  applyK8sManifestTool,
  // Helm charts
  listHelmChartFieldsTool,
  generateHelmChartTool,
  // Deploy
  runHelmUpgradeTool,
] as Tool[];

const TOOLS_BY_NAME = new Map(ALL_TOOLS.map((t) => [t.name, t]));

export function getTool(name: string): Tool | undefined {
  return TOOLS_BY_NAME.get(name);
}

/**
 * Cloud a tool REQUIRES. Tools not listed here are cloud-agnostic and always
 * available. Used for per-project tool isolation: an Azure-only project never
 * sees AWS tools (and vice-versa), so the agent can't fumble onto the wrong
 * cloud — and the smaller tool set also makes the model faster.
 */
const TOOL_CLOUD: Record<string, "aws" | "azure" | "gcp"> = {
  list_ec2_instances: "aws",
  provision_eks: "aws",
  setup_cloudwatch_alarms: "aws",
  setup_github_oidc_ecr: "aws",
  generate_ecr_workflow: "aws",
  list_azure_vms: "azure",
  setup_azure_monitor_alarms: "azure",
  list_azure_subscriptions: "azure",
  list_azure_resource_groups: "azure",
  set_azure_context: "azure",
  list_gcp_instances: "gcp",
  setup_gcp_monitor_alarms: "gcp",
  list_gcp_projects: "gcp",
  set_gcp_context: "gcp",
  list_artifact_registries: "gcp",
  create_artifact_registry: "gcp",
  setup_gcp_github_wif: "gcp",
  generate_gar_workflow: "gcp",
  list_acr: "azure",
  create_acr: "azure",
  setup_azure_github_oidc: "azure",
  generate_acr_workflow: "azure",
};

/**
 * Tools available to a project given its connected clouds: every agnostic tool
 * plus the cloud-specific tools whose cloud is connected. Pass an empty set to
 * get only the agnostic tools.
 */
export function toolsForClouds(clouds: Set<string>): Tool[] {
  return ALL_TOOLS.filter((t) => {
    const c = TOOL_CLOUD[t.name];
    return !c || clouds.has(c);
  });
}

/**
 * Anthropic's `tools` parameter shape. Each entry teaches Claude when to call
 * a tool and what shape the input must be. Defaults to all tools.
 */
export function toAnthropicTools(list: Tool[] = ALL_TOOLS): AnthropicTool[] {
  return list.map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema as AnthropicTool["input_schema"],
  }));
}

/**
 * Execute one tool the agent requested. Catches throws so a buggy tool can't
 * kill the agent loop; the failure goes back to Claude as a tool_result with
 * is_error=true so it can decide how to recover.
 */
export async function executeTool(
  name: string,
  input: unknown,
  ctx: ToolContext,
): Promise<ToolExecuteResult<unknown>> {
  const tool = getTool(name);
  if (!tool) {
    return { ok: false, error: `Unknown tool "${name}".` };
  }
  try {
    return await tool.execute(input, ctx);
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : "Tool execution failed.",
    };
  }
}
