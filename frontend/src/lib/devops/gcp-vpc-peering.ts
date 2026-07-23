/**
 * GCP VPC Network Peering Terraform generator.
 *
 * GCP peering is simpler than AWS in two important ways:
 *   1. **Global** — no cross-region gymnastics. Traffic just flows.
 *   2. **Automatic routes** — no explicit route-table entries needed on
 *      either side. Once the pair is up, subnets on both sides can reach
 *      each other. (Unlike AWS, where you also configure route tables.)
 *
 * Each peering needs TWO resources — one per side — because AWS-style
 * "accepter/requester" doesn't exist here; each side independently declares
 * the peer to the other. Both resources must exist for traffic to flow.
 *
 * Cross-project supported: peer network names include the full self-link
 * URL, so you can pair networks from different GCP projects.
 *
 * Emits:
 *   - google_compute_network_peering.left_to_right
 *   - google_compute_network_peering.right_to_left
 *   - Outputs: peering state for each side (helpful for debugging)
 */

export type GcpVpcPeeringSpec = {
  /** DNS-safe name prefix used to name the two peering resources. */
  name: string;
  env?: string;

  /**
   * "Left" network — the one owned by the project you're running Terraform
   * against. Either just the name (e.g. "prod-vpc") when it lives in the
   * same project, or the full self-link when cross-project:
   *   https://www.googleapis.com/compute/v1/projects/<proj>/global/networks/<vpc>
   */
  leftNetwork: string;

  /** "Right" network — either same shape as left (name) or a full self-link. */
  rightNetwork: string;

  /** GCP project the LEFT network lives in — sets the provider's project attribute. */
  leftProject?: string;

  /** Optional: exchange custom subnet routes (default: false, only exchange direct subnets). */
  exportCustomRoutes?: boolean;
  importCustomRoutes?: boolean;
};

export const GCP_VPC_PEERING_DEFAULTS = {
  exportCustomRoutes: false,
  importCustomRoutes: false,
} as const;

export function buildGcpVpcPeeringTerraform(spec: GcpVpcPeeringSpec): Record<string, string> {
  const name = sanitise(spec.name);
  const exportCustom = spec.exportCustomRoutes ?? GCP_VPC_PEERING_DEFAULTS.exportCustomRoutes;
  const importCustom = spec.importCustomRoutes ?? GCP_VPC_PEERING_DEFAULTS.importCustomRoutes;

  if (!spec.leftNetwork.trim() || !spec.rightNetwork.trim()) {
    throw new Error("Both leftNetwork and rightNetwork are required.");
  }

  // Fully qualified reference — accept either a bare name (resolves within
  // the current project) or a self-link URL (cross-project).
  const leftRef = spec.leftNetwork.trim();
  const rightRef = spec.rightNetwork.trim();

  const versionsTf = `terraform {
  required_version = ">= 1.4"
  required_providers {
    google = { source = "hashicorp/google", version = "~> 5.20" }
  }
}

provider "google" {${spec.leftProject ? `
  project = "${spec.leftProject}"` : ""}
}
`;

  // For bare names we use a data source to resolve the self_link at plan
  // time. Self-links (cross-project) are passed through as-is.
  const leftIsSelfLink = /^(https?:\/\/|projects\/)/.test(leftRef);
  const rightIsSelfLink = /^(https?:\/\/|projects\/)/.test(rightRef);

  const dataBlocks: string[] = [];
  if (!leftIsSelfLink) {
    dataBlocks.push(`data "google_compute_network" "left" {
  name = "${leftRef}"
}`);
  }
  if (!rightIsSelfLink) {
    dataBlocks.push(`data "google_compute_network" "right" {
  name = "${rightRef}"
}`);
  }

  const leftArg = leftIsSelfLink ? JSON.stringify(leftRef) : "data.google_compute_network.left.self_link";
  const rightArg = rightIsSelfLink ? JSON.stringify(rightRef) : "data.google_compute_network.right.self_link";

  const mainTf = `# ${name} — GCP VPC Network Peering
# Left  : ${leftRef}
# Right : ${rightRef}
# Bidirectional — GCP requires one peering resource per side.
# No route table entries needed; routes propagate automatically.

${dataBlocks.join("\n\n")}${dataBlocks.length ? "\n\n" : ""}resource "google_compute_network_peering" "left_to_right" {
  name         = "${name}-left-to-right"
  network      = ${leftArg}
  peer_network = ${rightArg}

  export_custom_routes = ${exportCustom}
  import_custom_routes = ${importCustom}
}

resource "google_compute_network_peering" "right_to_left" {
  name         = "${name}-right-to-left"
  network      = ${rightArg}
  peer_network = ${leftArg}

  export_custom_routes = ${importCustom}
  import_custom_routes = ${exportCustom}
}
`;

  const outputsTf = `output "left_to_right_state" {
  value       = google_compute_network_peering.left_to_right.state
  description = "State of the LEFT→RIGHT peering. ACTIVE means it's ready to route."
}

output "right_to_left_state" {
  value       = google_compute_network_peering.right_to_left.state
  description = "State of the RIGHT→LEFT peering."
}

output "left_network" {
  value       = "${leftRef}"
  description = "Left network reference (as passed to the generator)."
}

output "right_network" {
  value       = "${rightRef}"
  description = "Right network reference (as passed to the generator)."
}
`;

  return { "main.tf": mainTf, "outputs.tf": outputsTf, "versions.tf": versionsTf };
}

// ── helpers ─────────────────────────────────────────────────────────────

function sanitise(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

