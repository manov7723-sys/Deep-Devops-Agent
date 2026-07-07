/**
 * estimate_infra_cost — a BEFORE-you-provision monthly cost estimate. The agent
 * calls this ahead of provision_eks / run_terraform (or any infra creation) and
 * shows the user the ballpark monthly bill so they can confirm before spending.
 */
import type { Tool } from "./types";
import { estimateInfraCost, type Cloud, type EstimateResult } from "@/lib/cost/estimate";

type Input = {
  cloud: Cloud;
  instanceType?: string;
  nodeCount?: number;
  managedK8s?: boolean;
  storageGb?: number;
  loadBalancers?: number;
};

export const estimateInfraCostTool: Tool<Input, EstimateResult> = {
  name: "estimate_infra_cost",
  description:
    "Estimate the MONTHLY cost of infrastructure BEFORE creating it. Call this before provision_eks / run_terraform " +
    "or any provisioning, then show the user the monthly total + breakdown and ask them to confirm the spend. " +
    "Pass the node instance type, node count, whether it's a managed Kubernetes cluster (adds control-plane cost), " +
    "storage GB, and number of public load balancers. Returns an approximate USD/month figure with line items.",
  inputSchema: {
    type: "object",
    properties: {
      cloud: { type: "string", enum: ["aws", "azure", "gcp"], description: "Cloud provider." },
      instanceType: { type: "string", description: "Node instance type, e.g. 't3.medium' (AWS), 'D2s_v3' (Azure), 'e2-medium' (GCP)." },
      nodeCount: { type: "number", description: "Number of worker nodes / VMs." },
      managedK8s: { type: "boolean", description: "True if this is a managed Kubernetes cluster (EKS/AKS/GKE) — adds the control-plane charge." },
      storageGb: { type: "number", description: "Total persistent/block storage in GB." },
      loadBalancers: { type: "number", description: "Number of public load balancers (exposed Services/Ingress)." },
    },
    required: ["cloud"],
    additionalProperties: false,
  },
  async execute(input) {
    return { ok: true, output: estimateInfraCost(input) };
  },
};
