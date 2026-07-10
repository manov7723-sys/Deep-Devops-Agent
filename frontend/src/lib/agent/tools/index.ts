import type { Tool as AnthropicTool } from "@anthropic-ai/sdk/resources/messages";
import { listReposTool } from "./list-repos";
import { readGithubFileTool } from "./read-github-file";
import { listFilesInRepoTool } from "./list-files-in-repo";
import { writeRepoFileTool } from "./write-repo-file";
import { setGithubSecretTool } from "./set-github-secret";
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
import { grantEksAccessTool } from "./grant-eks-access";
import { listEcrReposTool } from "./list-ecr-repos";
import { analyzeAppServicesTool } from "./analyze-app-services";
import { deployMyAppTool } from "./deploy-my-app";
import { listDockerfileStacksTool } from "./list-dockerfile-stacks";
import { generateDockerfileTool } from "./generate-dockerfile";
import { generateEcrWorkflowTool } from "./generate-ecr-workflow";
import { verifyDockerBuildTool } from "./verify-docker-build";
import { savePipelineToProjectTool } from "./save-pipeline-to-project";
import { runTerraformTool } from "./run-terraform";
import { provisionEksTool } from "./provision-eks";
import { provisionProxmoxVmTool } from "./provision-proxmox-vm";
import { requestInfraApprovalTool } from "./request-infra-approval";
import { listK8sManifestKindsTool } from "./list-k8s-manifest-kinds";
import { generateK8sManifestTool } from "./generate-k8s-manifest";
import { applyK8sManifestTool } from "./apply-k8s-manifest";
import { listHelmChartFieldsTool } from "./list-helm-chart-fields";
import { generateHelmChartTool } from "./generate-helm-chart";
import { trivyScanTool } from "./trivy-scan";
import { generateComposeTool } from "./generate-compose";
import { generateCiWorkflowTool, generateTrivyWorkflowTool } from "./generate-ci-workflow";
import { listAlertsTool } from "./list-alerts";
import { listAlertThresholdsTool, setAlertThresholdTool, resetAlertThresholdTool } from "./alert-threshold-tools";
import { listAppSecretsTool, setAppSecretTool, syncAppSecretsTool } from "./secret-tools";
import { getProjectCostTool } from "./get-project-cost";
import { analyzeCostOptimizationTool } from "./cost-optim-tool";
import { estimateInfraCostTool } from "./estimate-infra-cost";
import { listArtifactRegistriesTool, createArtifactRegistryTool, setupGcpGithubWifTool, generateGarWorkflowTool } from "./gcp-registry-tools";
import { listAcrTool, createAcrTool, setupAzureGithubOidcTool, generateAcrWorkflowTool } from "./azure-registry-tools";
import { listDeployTargetsTool, listRegistryImagesTool, deployAppTool, deploymentStatusTool, writeCdFilesTool, waitForWorkflowRunTool, setKubeconfigSecretTool } from "./deploy-tools";
import { scheduleDeploymentTool, listScheduledDeploymentsTool, cancelScheduledDeploymentTool } from "./scheduled-deploy-tools";
import { rollbackDeploymentTool, listRolloutHistoryTool } from "./rollback-tools";
import { listAvailableReposTool, attachProjectRepoTool } from "./repo-tools";
import { listEnvironmentsTool, createEnvironmentTool, updateEnvironmentTool, deleteEnvironmentTool } from "./env-tools";
import { triggerPipelineTool } from "./pipeline-tools";
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
  setGithubSecretTool,
  scaffoldHelmChartTool,
  // Repo attach (project ↔ repo wiring, replaces the "CI/CD & Repos" tab)
  listAvailableReposTool,
  attachProjectRepoTool,
  // Environments CRUD (replaces the "Environments" tab)
  listEnvironmentsTool,
  createEnvironmentTool,
  updateEnvironmentTool,
  deleteEnvironmentTool,
  // Manual pipeline trigger (replaces "Trigger deployment")
  triggerPipelineTool,
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
  listAlertThresholdsTool,
  setAlertThresholdTool,
  resetAlertThresholdTool,
  // App secrets
  listAppSecretsTool,
  setAppSecretTool,
  syncAppSecretsTool,
  // Cost / FinOps
  getProjectCostTool,
  analyzeCostOptimizationTool,
  estimateInfraCostTool,
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
  provisionProxmoxVmTool,
  runTerraformTool,
  requestInfraApprovalTool,
  // Kubernetes manifests
  listK8sManifestKindsTool,
  generateK8sManifestTool,
  applyK8sManifestTool,
  // Deploy my app (image → running on cluster)
  listDeployTargetsTool,
  waitForWorkflowRunTool,
  listRegistryImagesTool,
  deployAppTool,
  writeCdFilesTool,
  setKubeconfigSecretTool,
  deploymentStatusTool,
  // Scheduled deploys (deploy later)
  scheduleDeploymentTool,
  listScheduledDeploymentsTool,
  cancelScheduledDeploymentTool,
  // Rollback (manual; auto-rollback is built into deploy)
  rollbackDeploymentTool,
  listRolloutHistoryTool,
  // Helm charts
  listHelmChartFieldsTool,
  generateHelmChartTool,
  // Deploy
  runHelmUpgradeTool,
  // EKS cluster access — grant an IAM role K8s RBAC via Access Entries (no aws-auth)
  grantEksAccessTool,
  // Registry + service analysis for the deploy flow (list ECR repos, detect frontend/backend)
  listEcrReposTool,
  analyzeAppServicesTool,
  // The single from-scratch flow: analyze repo → Dockerfile + CI + manifests → registry → (build → deploy)
  deployMyAppTool,
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
const TOOL_CLOUD: Record<string, "aws" | "azure" | "gcp" | "proxmox"> = {
  list_ec2_instances: "aws",
  provision_eks: "aws",
  provision_proxmox_vm: "proxmox",
  setup_cloudwatch_alarms: "aws",
  setup_github_oidc_ecr: "aws",
  generate_ecr_workflow: "aws",
  grant_eks_access: "aws",
  list_ecr_repos: "aws",
  // analyze_app_services + deploy_my_app are cloud-agnostic at the gating level:
  // deploy_my_app supports AWS (EKS/ECR), GCP (GKE/Artifact Registry) AND Azure
  // (AKS/ACR), picking the path from the env's cloud — so it must stay visible
  // on all three, not gated to one.
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
 * Git provider a tool REQUIRES. These set up keyless GitHub-Actions OIDC
 * federation to a cloud registry (or emit GitHub Actions YAML), so they only
 * make sense for GitHub repos. A GitLab-only project shouldn't see them —
 * GitLab OIDC federation is a later phase, and GitLab CI is generated by the
 * provider-aware generate_ci_workflow instead.
 */
const TOOL_GIT_PROVIDER: Record<string, "github"> = {
  setup_github_oidc_ecr: "github",
  generate_ecr_workflow: "github",
  setup_gcp_github_wif: "github",
  generate_gar_workflow: "github",
  setup_azure_github_oidc: "github",
  generate_acr_workflow: "github",
  generate_trivy_workflow: "github",
  set_github_actions_secret: "github",
  deploy_my_app: "github",
};

/**
 * Tools available to a project given its connected clouds AND attached git
 * providers: every agnostic tool, plus cloud-specific tools whose cloud is
 * connected, plus git-specific tools whose provider is present among the
 * project's repos. This is the isolation the agent should use.
 */
export function toolsForProject(args: { clouds: Set<string>; gitProviders: Set<string> }): Tool[] {
  return ALL_TOOLS.filter((t) => {
    const c = TOOL_CLOUD[t.name];
    if (c && !args.clouds.has(c)) return false;
    const g = TOOL_GIT_PROVIDER[t.name];
    if (g && !args.gitProviders.has(g)) return false;
    return true;
  });
}

/**
 * Tools available to a project given its connected clouds: every agnostic tool
 * plus the cloud-specific tools whose cloud is connected. Pass an empty set to
 * get only the agnostic tools. Kept for callers that don't yet thread git
 * providers; prefer toolsForProject.
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
