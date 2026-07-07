/**
 * Infra cost estimator — a deterministic (no-AI) "what will this cost per month?"
 * calculator you run BEFORE provisioning, so there are no billing surprises.
 *
 * Prices are approximate on-demand US-region list prices (USD) and are meant for
 * a ballpark, not an invoice — actual cost varies by region, commitment
 * (savings plans / reserved), and data transfer. We surface the assumptions.
 */
export type Cloud = "aws" | "azure" | "gcp" | "proxmox";

export type EstimateSpec = {
  cloud: Cloud;
  instanceType?: string;
  nodeCount?: number;
  /** Add a managed-Kubernetes control-plane charge (EKS/AKS/GKE). */
  managedK8s?: boolean;
  /** Persistent disk / block storage, GB. */
  storageGb?: number;
  /** Public load balancers (one per exposed Service of type LoadBalancer / Ingress). */
  loadBalancers?: number;
  /** Override the hours/month (default 730 = a full month). */
  hoursPerMonth?: number;
};

export type LineItem = { label: string; monthly: number };
export type EstimateResult = {
  ok: true;
  currency: "USD";
  monthly: number;
  lineItems: LineItem[];
  assumptions: string[];
  notes: string[];
};

const HOURS = 730; // average hours in a month

// Approximate on-demand hourly USD by instance type (lowercased key).
const INSTANCE_HOURLY: Record<Cloud, Record<string, number>> = {
  aws: {
    "t3.micro": 0.0104, "t3.small": 0.0208, "t3.medium": 0.0416, "t3.large": 0.0832, "t3.xlarge": 0.1664, "t3.2xlarge": 0.3328,
    "t2.micro": 0.0116, "t2.small": 0.023, "t2.medium": 0.0464,
    "m5.large": 0.096, "m5.xlarge": 0.192, "m5.2xlarge": 0.384,
    "c5.large": 0.085, "c5.xlarge": 0.17,
  },
  azure: {
    "b1s": 0.0104, "b2s": 0.0416, "b2ms": 0.0832, "b4ms": 0.166,
    "d2s_v3": 0.096, "d4s_v3": 0.192, "d8s_v3": 0.384,
    "f2s_v2": 0.085, "f4s_v2": 0.169,
  },
  gcp: {
    "e2-micro": 0.00838, "e2-small": 0.01675, "e2-medium": 0.03351, "e2-standard-2": 0.06701, "e2-standard-4": 0.13402,
    "n1-standard-1": 0.0475, "n1-standard-2": 0.095, "n1-standard-4": 0.19,
    "n2-standard-2": 0.0971, "n2-standard-4": 0.1942,
  },
  // Proxmox is self-hosted — no metered per-instance cloud cost.
  proxmox: {},
};

// Default hourly when the instance type isn't in the table (a ~2 vCPU / 4-8GB general box).
const DEFAULT_HOURLY: Record<Cloud, number> = { aws: 0.0416, azure: 0.0416, gcp: 0.03351, proxmox: 0 };

/** Selectable instance types per cloud (the priced ones), for the UI dropdown. */
export const INSTANCE_TYPES: Record<Cloud, string[]> = {
  aws: ["t3.micro", "t3.small", "t3.medium", "t3.large", "t3.xlarge", "m5.large", "m5.xlarge", "c5.large"],
  azure: ["b1s", "b2s", "b2ms", "d2s_v3", "d4s_v3", "f2s_v2", "f4s_v2"],
  gcp: ["e2-small", "e2-medium", "e2-standard-2", "e2-standard-4", "n1-standard-1", "n1-standard-2", "n2-standard-2"],
  proxmox: [],
};

/** Sensible default instance type per cloud. */
export const DEFAULT_INSTANCE_TYPE: Record<Cloud, string> = { aws: "t3.medium", azure: "b2s", gcp: "e2-medium", proxmox: "custom" };

// Managed-Kubernetes control plane, monthly USD.
const CONTROL_PLANE: Record<Cloud, number> = { aws: 73, azure: 0, gcp: 73, proxmox: 0 }; // EKS $0.10/h; AKS free tier $0; GKE $0.10/h/cluster; Proxmox self-hosted $0
const CONTROL_PLANE_LABEL: Record<Cloud, string> = { aws: "EKS control plane", azure: "AKS control plane (free tier)", gcp: "GKE control plane", proxmox: "Proxmox (self-hosted)" };

// Block storage per GB-month, USD (gp3 / managed disk / balanced PD, approx).
const STORAGE_PER_GB: Record<Cloud, number> = { aws: 0.08, azure: 0.1, gcp: 0.1, proxmox: 0 };

// One public load balancer, monthly USD (approx, excludes data-processing charges).
const LB_MONTHLY: Record<Cloud, number> = { aws: 18, azure: 18, gcp: 18, proxmox: 0 };

const round2 = (n: number) => Math.round(n * 100) / 100;

export function estimateInfraCost(spec: EstimateSpec): EstimateResult {
  const cloud = spec.cloud;
  const hours = spec.hoursPerMonth && spec.hoursPerMonth > 0 ? spec.hoursPerMonth : HOURS;
  const lineItems: LineItem[] = [];
  const assumptions: string[] = [`On-demand US list prices, ${hours} hrs/month, no reserved/savings-plan discounts.`];
  const notes: string[] = [];

  // Compute nodes
  const nodeCount = Math.max(0, Math.floor(spec.nodeCount ?? 0));
  if (nodeCount > 0) {
    const typeRaw = (spec.instanceType || "").trim();
    const key = typeRaw.toLowerCase();
    const known = INSTANCE_HOURLY[cloud][key];
    const hourly = known ?? DEFAULT_HOURLY[cloud];
    if (typeRaw && known == null) notes.push(`Instance type "${typeRaw}" not in the price table — used a general-purpose rate ($${hourly}/hr). Estimate is approximate.`);
    const label = typeRaw || "general-purpose node";
    lineItems.push({ label: `${nodeCount} × ${label} (compute)`, monthly: round2(nodeCount * hourly * hours) });
  }

  // Managed K8s control plane
  if (spec.managedK8s) {
    const cp = CONTROL_PLANE[cloud];
    lineItems.push({ label: CONTROL_PLANE_LABEL[cloud], monthly: round2(cp) });
    if (cloud === "gcp") notes.push("GKE bills one free zonal/Autopilot cluster per billing account — your first cluster may be $0.");
  }

  // Storage
  const storageGb = Math.max(0, spec.storageGb ?? 0);
  if (storageGb > 0) {
    lineItems.push({ label: `${storageGb} GB block storage`, monthly: round2(storageGb * STORAGE_PER_GB[cloud]) });
  }

  // Load balancers
  const lbs = Math.max(0, Math.floor(spec.loadBalancers ?? 0));
  if (lbs > 0) {
    lineItems.push({ label: `${lbs} × load balancer`, monthly: round2(lbs * LB_MONTHLY[cloud]) });
    notes.push("Load balancer estimate excludes per-GB data-processing charges.");
  }

  const monthly = round2(lineItems.reduce((s, i) => s + i.monthly, 0));
  return { ok: true, currency: "USD", monthly, lineItems, assumptions, notes };
}
