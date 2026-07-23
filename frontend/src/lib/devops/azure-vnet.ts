/**
 * Azure Virtual Network (VNet) Terraform generator — Azure's equivalent of
 * AWS VPC. Console-style: emits a Resource Group + VNet + N subnets across
 * the address space + an optional NAT Gateway for private-subnet outbound.
 *
 * Simpler than AWS in one nice way: no route tables, no IGW — VNets have
 * implicit routing to Azure fabric and default outbound internet unless you
 * turn it off. NAT Gateway is only needed for stable private-subnet SNAT.
 *
 * Emits:
 *   - 1 azurerm_resource_group        (<name>-rg)
 *   - 1 azurerm_virtual_network       (address_space = vnetCidr)
 *   - N azurerm_subnet "public"       (public here means "no NAT attached")
 *   - Optional: N azurerm_subnet "private" (attached to NAT if configured)
 *   - Optional: 1 azurerm_nat_gateway + public IP + associations
 *   - Optional: 1 azurerm_network_security_group per tier with sane defaults
 *   - Outputs: vnet_id, vnet_cidr, public_subnet_ids, private_subnet_ids, region
 */

export type AzureNatStrategy = "none" | "single";

export type AzureVnetSpec = {
  /** DNS-safe name prefix. */
  name: string;
  /** Azure location (region). */
  location: string;
  env?: string;
  /** IPv4 CIDR for the VNet. Default 10.10.0.0/16. */
  vnetCidr?: string;
  /** How many subnets per tier. 1-3. Default 2. */
  subnetCount?: 1 | 2 | 3;
  /** Also create private subnets. Default true. */
  includePrivateSubnets?: boolean;
  /** NAT gateway for private subnets. 'none' or 'single'. Default 'single' when privates enabled. */
  natStrategy?: AzureNatStrategy;
  /** Create a default NSG per tier with sane rules (deny inbound by default). Default true. */
  createDefaultNsgs?: boolean;
  tags?: Record<string, string>;
};

export const AZURE_VNET_DEFAULTS = {
  vnetCidr: "10.10.0.0/16",
  subnetCount: 2 as 1 | 2 | 3,
  includePrivateSubnets: true,
  natStrategy: "single" as AzureNatStrategy,
  createDefaultNsgs: true,
} as const;

export function validateVnetCidr(cidr: string): { ok: true } | { ok: false; error: string } {
  const m = cidr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!m) return { ok: false, error: `"${cidr}" is not a valid IPv4 CIDR (e.g. 10.10.0.0/16).` };
  const prefix = Number(m[5]);
  if (prefix < 8 || prefix > 29) return { ok: false, error: `Prefix /${prefix} out of range.` };
  return { ok: true };
}

export function buildAzureVnetTerraform(spec: AzureVnetSpec): Record<string, string> {
  const name = sanitise(spec.name);
  const vnetCidr = spec.vnetCidr ?? AZURE_VNET_DEFAULTS.vnetCidr;
  const subnetCount = spec.subnetCount ?? AZURE_VNET_DEFAULTS.subnetCount;
  const includePrivate = spec.includePrivateSubnets ?? AZURE_VNET_DEFAULTS.includePrivateSubnets;
  const natStrategy: AzureNatStrategy = includePrivate
    ? (spec.natStrategy ?? AZURE_VNET_DEFAULTS.natStrategy)
    : "none";
  const createNsgs = spec.createDefaultNsgs ?? AZURE_VNET_DEFAULTS.createDefaultNsgs;
  const tags = {
    ManagedBy: "DeepAgent",
    Stack: name,
    ...(spec.env ? { Environment: spec.env } : {}),
    ...(spec.tags ?? {}),
  };

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

  // Auto-carve subnets from the VNet's /16 into /20 slices, first N public,
  // next N private (offset by 8, i.e. upper half of the /16).
  const publicSubnetBlocks: string[] = [];
  const privateSubnetBlocks: string[] = [];
  for (let i = 0; i < subnetCount; i++) {
    publicSubnetBlocks.push(`resource "azurerm_subnet" "public_${i}" {
  name                 = "${name}-public-${i + 1}"
  resource_group_name  = azurerm_resource_group.this.name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [cidrsubnet("${vnetCidr}", 4, ${i})]
}`);
    if (includePrivate) {
      privateSubnetBlocks.push(`resource "azurerm_subnet" "private_${i}" {
  name                 = "${name}-private-${i + 1}"
  resource_group_name  = azurerm_resource_group.this.name
  virtual_network_name = azurerm_virtual_network.this.name
  address_prefixes     = [cidrsubnet("${vnetCidr}", 4, ${i + 8})]
}`);
    }
  }

  // NAT Gateway is a regional resource attached to a public IP + associated
  // per subnet. Single-NAT model here mirrors AWS's cheapest option.
  const natBlocks: string[] = [];
  const natAssocs: string[] = [];
  if (natStrategy === "single" && includePrivate) {
    natBlocks.push(`resource "azurerm_public_ip" "nat" {
  name                = "${name}-nat-pip"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  allocation_method   = "Static"
  sku                 = "Standard"
  tags                = ${jsonToHcl(tags, "  ")}
}

resource "azurerm_nat_gateway" "this" {
  name                    = "${name}-nat"
  location                = azurerm_resource_group.this.location
  resource_group_name     = azurerm_resource_group.this.name
  sku_name                = "Standard"
  idle_timeout_in_minutes = 10
  tags                    = ${jsonToHcl(tags, "  ")}
}

resource "azurerm_nat_gateway_public_ip_association" "this" {
  nat_gateway_id       = azurerm_nat_gateway.this.id
  public_ip_address_id = azurerm_public_ip.nat.id
}`);
    for (let i = 0; i < subnetCount; i++) {
      natAssocs.push(`resource "azurerm_subnet_nat_gateway_association" "private_${i}" {
  subnet_id      = azurerm_subnet.private_${i}.id
  nat_gateway_id = azurerm_nat_gateway.this.id
}`);
    }
  }

  // Default NSGs — one per tier. Public allows nothing inbound by default
  // (attach it, then app resources add their own rules). Azure denies inbound
  // by default anyway, so these NSGs mostly serve as attachment points.
  const nsgBlocks: string[] = [];
  const nsgAssocs: string[] = [];
  if (createNsgs) {
    nsgBlocks.push(`resource "azurerm_network_security_group" "public" {
  name                = "${name}-public-nsg"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  tags                = ${jsonToHcl(tags, "  ")}
}`);
    for (let i = 0; i < subnetCount; i++) {
      nsgAssocs.push(`resource "azurerm_subnet_network_security_group_association" "public_${i}" {
  subnet_id                 = azurerm_subnet.public_${i}.id
  network_security_group_id = azurerm_network_security_group.public.id
}`);
    }
    if (includePrivate) {
      nsgBlocks.push(`resource "azurerm_network_security_group" "private" {
  name                = "${name}-private-nsg"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  tags                = ${jsonToHcl(tags, "  ")}
}`);
      for (let i = 0; i < subnetCount; i++) {
        nsgAssocs.push(`resource "azurerm_subnet_network_security_group_association" "private_${i}" {
  subnet_id                 = azurerm_subnet.private_${i}.id
  network_security_group_id = azurerm_network_security_group.private.id
}`);
      }
    }
  }

  const mainTf = `# ${name} — Azure VNet ${vnetCidr} in ${spec.location} (${subnetCount} subnet${subnetCount === 1 ? "" : "s"} per tier${includePrivate ? " · public + private" : " · public only"}${includePrivate && natStrategy !== "none" ? ` · NAT: ${natStrategy}` : ""})
# Generated by DeepAgent.

resource "azurerm_resource_group" "this" {
  name     = "${name}-rg"
  location = "${spec.location}"
  tags     = ${jsonToHcl(tags, "  ")}
}

resource "azurerm_virtual_network" "this" {
  name                = "${name}-vnet"
  location            = azurerm_resource_group.this.location
  resource_group_name = azurerm_resource_group.this.name
  address_space       = ["${vnetCidr}"]
  tags                = ${jsonToHcl(tags, "  ")}
}

${publicSubnetBlocks.join("\n\n")}${privateSubnetBlocks.length ? "\n\n" + privateSubnetBlocks.join("\n\n") : ""}${natBlocks.length ? "\n\n" + natBlocks.join("\n\n") : ""}${natAssocs.length ? "\n\n" + natAssocs.join("\n\n") : ""}${nsgBlocks.length ? "\n\n" + nsgBlocks.join("\n\n") : ""}${nsgAssocs.length ? "\n\n" + nsgAssocs.join("\n\n") : ""}
`;

  const publicIdsList = Array.from({ length: subnetCount }, (_, i) => `azurerm_subnet.public_${i}.id`).join(", ");
  const privateIdsList = includePrivate
    ? Array.from({ length: subnetCount }, (_, i) => `azurerm_subnet.private_${i}.id`).join(", ")
    : "";

  const outputsTf = `output "resource_group_name" {
  value       = azurerm_resource_group.this.name
  description = "Name of the resource group that holds this stack"
}

output "vnet_id" {
  value       = azurerm_virtual_network.this.id
  description = "ID of the new VNet"
}

output "vnet_cidr" {
  value       = azurerm_virtual_network.this.address_space[0]
  description = "CIDR of the new VNet"
}

output "public_subnet_ids" {
  value       = [${publicIdsList}]
  description = "IDs of the public subnets"
}
${includePrivate ? `
output "private_subnet_ids" {
  value       = [${privateIdsList}]
  description = "IDs of the private subnets"
}
` : ""}${natStrategy === "single" && includePrivate ? `
output "nat_gateway_public_ip" {
  value       = azurerm_public_ip.nat.ip_address
  description = "Public IP the NAT gateway SNATs outbound traffic to"
}
` : ""}
output "location" {
  value       = azurerm_resource_group.this.location
  description = "Azure region"
}
`;

  return { "main.tf": mainTf, "outputs.tf": outputsTf, "versions.tf": versionsTf };
}

function sanitise(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function jsonToHcl(obj: Record<string, string>, indent: string): string {
  const rows = Object.entries(obj).map(([k, v]) => `${indent}  ${JSON.stringify(k)} = ${JSON.stringify(v)}`);
  return "{\n" + rows.join("\n") + `\n${indent}}`;
}
