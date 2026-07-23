/**
 * AWS VPC Terraform generator — console-style.
 *
 * Matches (a useful subset of) AWS's own "VPC and more" launch wizard:
 *
 *   - 1 aws_vpc                       (CIDR, DNS toggles)
 *   - 1 aws_internet_gateway
 *   - N aws_subnet "public"           (one per AZ, /20 slice each)
 *   - Optional: N aws_subnet "private" (one per AZ, /20 slice each,
 *                                       offset into the upper half of the VPC)
 *   - Optional: NAT gateways           (none | single shared | one per AZ)
 *   - aws_route_table "public"        (→ IGW)
 *   - Optional: aws_route_table "private" per-AZ (→ NAT)
 *   - Route table associations for every subnet
 *   - Outputs: vpc_id, vpc_cidr, public_subnet_ids, private_subnet_ids,
 *              nat_gateway_ips, region
 *
 * Subnet CIDRs are auto-computed with Terraform's `cidrsubnet()` so users
 * don't hand-carve them: the /16 VPC is split into 16 /20 slices, first
 * `azCount` go to public, next `azCount` go to private (128+ into the /16
 * range, matches the AWS Landing Zone convention).
 */

export type VpcNatStrategy = "none" | "single" | "per_az";

export type VpcSpec = {
  /** DNS-safe name prefix for tagged resources. */
  name: string;
  region: string;
  env?: string;
  /** IPv4 CIDR for the VPC. Default 10.0.0.0/16. */
  vpcCidr?: string;
  /** How many AZs to spread subnets across. 1–3 (region-safe on any AWS region). Default 2. */
  azCount?: 1 | 2 | 3;
  /** Also create one private subnet per AZ. Default true. */
  includePrivateSubnets?: boolean;
  /** NAT gateway strategy. Only used when private subnets exist. Default "single". */
  natStrategy?: VpcNatStrategy;
  /** enable_dns_hostnames on the VPC. Default true. */
  dnsHostnames?: boolean;
  /** enable_dns_support on the VPC. Default true. */
  dnsSupport?: boolean;
  /** Additional tags merged in on top of the app's defaults. */
  tags?: Record<string, string>;
};

export const VPC_DEFAULTS = {
  vpcCidr: "10.0.0.0/16",
  azCount: 2 as 1 | 2 | 3,
  includePrivateSubnets: true,
  natStrategy: "single" as VpcNatStrategy,
  dnsHostnames: true,
  dnsSupport: true,
} as const;

/** Cheap sanity check — proper CIDR validation is Terraform's job at plan time. */
export function validateCidr(cidr: string): { ok: true } | { ok: false; error: string } {
  const m = cidr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!m) return { ok: false, error: `"${cidr}" is not a valid IPv4 CIDR (e.g. 10.0.0.0/16).` };
  const parts = [m[1], m[2], m[3], m[4]].map(Number);
  if (parts.some((n) => n < 0 || n > 255)) return { ok: false, error: `Octet out of range in "${cidr}".` };
  const prefix = Number(m[5]);
  if (prefix < 8 || prefix > 32) return { ok: false, error: `Prefix /${prefix} out of range in "${cidr}".` };
  return { ok: true };
}

export function buildVpcTerraform(spec: VpcSpec): Record<string, string> {
  const name = sanitise(spec.name);
  const vpcCidr = spec.vpcCidr ?? VPC_DEFAULTS.vpcCidr;
  const azCount = spec.azCount ?? VPC_DEFAULTS.azCount;
  const includePrivate = spec.includePrivateSubnets ?? VPC_DEFAULTS.includePrivateSubnets;
  const natStrategy: VpcNatStrategy = includePrivate ? (spec.natStrategy ?? VPC_DEFAULTS.natStrategy) : "none";
  const dnsHostnames = spec.dnsHostnames ?? VPC_DEFAULTS.dnsHostnames;
  const dnsSupport = spec.dnsSupport ?? VPC_DEFAULTS.dnsSupport;
  const tags = {
    ManagedBy: "DeepAgent",
    Stack: name,
    ...(spec.env ? { Environment: spec.env } : {}),
    ...(spec.tags ?? {}),
  };

  const versionsTf = `terraform {
  required_version = ">= 1.4"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.60" }
  }
}

provider "aws" {
  region = "${spec.region}"
}
`;

  // Auto-carve CIDRs from the VPC's /16 into /20 slices. First `azCount` go
  // to public, next `azCount` go to private (offset by 128 to land in the
  // upper half of the /16 — matches AWS Landing Zone convention).
  const publicSubnetBlocks: string[] = [];
  const privateSubnetBlocks: string[] = [];
  for (let i = 0; i < azCount; i++) {
    publicSubnetBlocks.push(`resource "aws_subnet" "public_${i}" {
  vpc_id                  = aws_vpc.this.id
  cidr_block              = cidrsubnet("${vpcCidr}", 4, ${i})
  availability_zone       = data.aws_availability_zones.available.names[${i}]
  map_public_ip_on_launch = true
  tags                    = merge(${jsonToHcl(tags)}, { Name = "${name}-public-${i + 1}", Tier = "public" })
}`);
    if (includePrivate) {
      privateSubnetBlocks.push(`resource "aws_subnet" "private_${i}" {
  vpc_id            = aws_vpc.this.id
  cidr_block        = cidrsubnet("${vpcCidr}", 4, ${i + 8})
  availability_zone = data.aws_availability_zones.available.names[${i}]
  tags              = merge(${jsonToHcl(tags)}, { Name = "${name}-private-${i + 1}", Tier = "private" })
}`);
    }
  }

  // Public routing — one route table shared across all public subnets.
  const publicRouteBlocks = [
    `resource "aws_route_table" "public" {
  vpc_id = aws_vpc.this.id
  route {
    cidr_block = "0.0.0.0/0"
    gateway_id = aws_internet_gateway.this.id
  }
  tags = merge(${jsonToHcl(tags)}, { Name = "${name}-public-rt", Tier = "public" })
}`,
  ];
  for (let i = 0; i < azCount; i++) {
    publicRouteBlocks.push(`resource "aws_route_table_association" "public_${i}" {
  subnet_id      = aws_subnet.public_${i}.id
  route_table_id = aws_route_table.public.id
}`);
  }

  // NAT + private routing.
  const natBlocks: string[] = [];
  if (natStrategy !== "none" && includePrivate) {
    const natCount = natStrategy === "per_az" ? azCount : 1;
    for (let i = 0; i < natCount; i++) {
      natBlocks.push(`resource "aws_eip" "nat_${i}" {
  domain = "vpc"
  tags   = merge(${jsonToHcl(tags)}, { Name = "${name}-nat-eip-${i + 1}" })

  depends_on = [aws_internet_gateway.this]
}

resource "aws_nat_gateway" "gw_${i}" {
  allocation_id = aws_eip.nat_${i}.id
  subnet_id     = aws_subnet.public_${i}.id
  tags          = merge(${jsonToHcl(tags)}, { Name = "${name}-nat-${i + 1}" })

  depends_on = [aws_internet_gateway.this]
}`);
    }
  }

  const privateRouteBlocks: string[] = [];
  if (includePrivate) {
    for (let i = 0; i < azCount; i++) {
      // With natStrategy "single", every private subnet routes through NAT #0.
      // With "per_az", each private subnet uses its matching NAT.
      // With "none", the private RT has no default route (subnets isolated).
      const natIdx = natStrategy === "per_az" ? i : 0;
      const routeStanza =
        natStrategy === "none"
          ? ""
          : `\n  route {
    cidr_block     = "0.0.0.0/0"
    nat_gateway_id = aws_nat_gateway.gw_${natIdx}.id
  }`;
      privateRouteBlocks.push(`resource "aws_route_table" "private_${i}" {
  vpc_id = aws_vpc.this.id${routeStanza}
  tags = merge(${jsonToHcl(tags)}, { Name = "${name}-private-rt-${i + 1}", Tier = "private" })
}

resource "aws_route_table_association" "private_${i}" {
  subnet_id      = aws_subnet.private_${i}.id
  route_table_id = aws_route_table.private_${i}.id
}`);
    }
  }

  const mainTf = `# ${name} — VPC ${vpcCidr} in ${spec.region} (${azCount} AZ${azCount === 1 ? "" : "s"}${includePrivate ? " · public + private" : " · public only"}${includePrivate && natStrategy !== "none" ? ` · NAT: ${natStrategy}` : ""})
# Generated by DeepAgent. Rerunning the wizard regenerates this file.

data "aws_availability_zones" "available" {
  state = "available"
}

resource "aws_vpc" "this" {
  cidr_block           = "${vpcCidr}"
  enable_dns_hostnames = ${dnsHostnames}
  enable_dns_support   = ${dnsSupport}
  tags                 = merge(${jsonToHcl(tags)}, { Name = "${name}-vpc" })
}

resource "aws_internet_gateway" "this" {
  vpc_id = aws_vpc.this.id
  tags   = merge(${jsonToHcl(tags)}, { Name = "${name}-igw" })
}

${publicSubnetBlocks.join("\n\n")}${privateSubnetBlocks.length ? "\n\n" + privateSubnetBlocks.join("\n\n") : ""}

${publicRouteBlocks.join("\n\n")}${natBlocks.length ? "\n\n" + natBlocks.join("\n\n") : ""}${privateRouteBlocks.length ? "\n\n" + privateRouteBlocks.join("\n\n") : ""}
`;

  const publicIdsList = Array.from({ length: azCount }, (_, i) => `aws_subnet.public_${i}.id`).join(", ");
  const privateIdsList = includePrivate
    ? Array.from({ length: azCount }, (_, i) => `aws_subnet.private_${i}.id`).join(", ")
    : "";
  const natCount = natStrategy === "per_az" ? azCount : natStrategy === "single" && includePrivate ? 1 : 0;
  const natIpsList = Array.from({ length: natCount }, (_, i) => `aws_eip.nat_${i}.public_ip`).join(", ");

  const outputsTf = `output "vpc_id" {
  value       = aws_vpc.this.id
  description = "ID of the new VPC"
}

output "vpc_cidr" {
  value       = aws_vpc.this.cidr_block
  description = "CIDR of the new VPC (needed for peering later)"
}

output "public_subnet_ids" {
  value       = [${publicIdsList}]
  description = "IDs of the public subnets (one per AZ)"
}
${includePrivate ? `
output "private_subnet_ids" {
  value       = [${privateIdsList}]
  description = "IDs of the private subnets (one per AZ)"
}
` : ""}${natCount > 0 ? `
output "nat_gateway_ips" {
  value       = [${natIpsList}]
  description = "Public IPs of the NAT gateway${natCount === 1 ? "" : "s"}"
}
` : ""}
output "region" {
  value       = "${spec.region}"
  description = "Region the VPC lives in"
}
`;

  return { "main.tf": mainTf, "outputs.tf": outputsTf, "versions.tf": versionsTf };
}

// ── helpers ─────────────────────────────────────────────────────────────

function sanitise(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 40);
}

function jsonToHcl(obj: Record<string, string>): string {
  const rows = Object.entries(obj).map(([k, v]) => `    ${JSON.stringify(k)} = ${JSON.stringify(v)}`);
  return "{\n" + rows.join("\n") + "\n  }";
}
