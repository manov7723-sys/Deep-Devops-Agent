/**
 * Azure Virtual Network Peering Terraform generator.
 *
 * Like GCP, Azure peering is bidirectional: each side needs its own
 * `azurerm_virtual_network_peering` resource. Global peering (cross-region)
 * works natively — no special resource type needed. Cross-subscription is
 * supported via full resource IDs.
 *
 * Emits:
 *   - azurerm_virtual_network_peering.left_to_right
 *   - azurerm_virtual_network_peering.right_to_left
 *
 * Both peerings default to allow_virtual_network_access = true (basic peering)
 * and allow_forwarded_traffic = false (don't relay through this VNet).
 */

export type AzureVnetPeeringSpec = {
  /** DNS-safe name prefix used to name the two peering resources. */
  name: string;
  env?: string;

  /** Left side (the one you're currently managing). */
  leftResourceGroup: string;
  leftVnetName: string;

  /** Right side (the peer). Cross-subscription is fine — use full ARM IDs. */
  rightResourceGroup: string;
  rightVnetName: string;

  /**
   * When true, VMs in this VNet can use the peered VNet as a transit hop
   * (e.g. peered VNet has a VPN Gateway that this VNet's VMs use).
   * Default false (basic peering — just direct connectivity).
   */
  allowGatewayTransit?: boolean;

  /** When true, this VNet uses the peered VNet's Virtual Network Gateway. */
  useRemoteGateways?: boolean;

  tags?: Record<string, string>;
};

export const AZURE_VNET_PEERING_DEFAULTS = {
  allowGatewayTransit: false,
  useRemoteGateways: false,
} as const;

export function buildAzureVnetPeeringTerraform(spec: AzureVnetPeeringSpec): Record<string, string> {
  const name = sanitise(spec.name);
  const allowGw = spec.allowGatewayTransit ?? AZURE_VNET_PEERING_DEFAULTS.allowGatewayTransit;
  const useRemoteGw = spec.useRemoteGateways ?? AZURE_VNET_PEERING_DEFAULTS.useRemoteGateways;
  const tags = {
    ManagedBy: "DeepAgent",
    Stack: name,
    ...(spec.env ? { Environment: spec.env } : {}),
    ...(spec.tags ?? {}),
  };
  void tags; // Azure peering resources don't accept tags directly.

  if (!spec.leftResourceGroup || !spec.leftVnetName || !spec.rightResourceGroup || !spec.rightVnetName) {
    throw new Error("Both left and right (resource group + VNet name) are required.");
  }

  const versionsTf = `terraform {
  required_version = ">= 1.4"
  required_providers {
    azurerm = { source = "hashicorp/azurerm", version = "~> 3.100" }
  }
}

provider "azurerm" {
  features {}
}
`;

  const mainTf = `# ${name} — Azure VNet Peering
# Left  : ${spec.leftResourceGroup}/${spec.leftVnetName}
# Right : ${spec.rightResourceGroup}/${spec.rightVnetName}
# Bidirectional — Azure requires one peering resource per side.
# Global peering (cross-region) works natively; no special resource type.

data "azurerm_virtual_network" "left" {
  name                = "${spec.leftVnetName}"
  resource_group_name = "${spec.leftResourceGroup}"
}

data "azurerm_virtual_network" "right" {
  name                = "${spec.rightVnetName}"
  resource_group_name = "${spec.rightResourceGroup}"
}

resource "azurerm_virtual_network_peering" "left_to_right" {
  name                         = "${name}-left-to-right"
  resource_group_name          = "${spec.leftResourceGroup}"
  virtual_network_name         = data.azurerm_virtual_network.left.name
  remote_virtual_network_id    = data.azurerm_virtual_network.right.id
  allow_virtual_network_access = true
  allow_forwarded_traffic      = false
  allow_gateway_transit        = ${allowGw}
  use_remote_gateways          = ${useRemoteGw}
}

resource "azurerm_virtual_network_peering" "right_to_left" {
  name                         = "${name}-right-to-left"
  resource_group_name          = "${spec.rightResourceGroup}"
  virtual_network_name         = data.azurerm_virtual_network.right.name
  remote_virtual_network_id    = data.azurerm_virtual_network.left.id
  allow_virtual_network_access = true
  allow_forwarded_traffic      = false
  # Flip the gateway attrs — if left transits, right uses remote (and vice
  # versa). Mutually exclusive on Azure's side.
  allow_gateway_transit        = ${useRemoteGw}
  use_remote_gateways          = ${allowGw}
}
`;

  const outputsTf = `output "left_to_right_id" {
  value       = azurerm_virtual_network_peering.left_to_right.id
  description = "ARM resource ID of the LEFT→RIGHT peering."
}

output "right_to_left_id" {
  value       = azurerm_virtual_network_peering.right_to_left.id
  description = "ARM resource ID of the RIGHT→LEFT peering."
}

output "left_vnet" {
  value       = "${spec.leftResourceGroup}/${spec.leftVnetName}"
  description = "Left VNet (resource-group/name)."
}

output "right_vnet" {
  value       = "${spec.rightResourceGroup}/${spec.rightVnetName}"
  description = "Right VNet (resource-group/name)."
}
`;

  return { "main.tf": mainTf, "outputs.tf": outputsTf, "versions.tf": versionsTf };
}

function sanitise(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}
