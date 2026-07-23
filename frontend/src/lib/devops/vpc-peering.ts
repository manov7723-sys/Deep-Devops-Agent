/**
 * AWS cross-region VPC peering Terraform generator.
 *
 * Wires two VPCs in DIFFERENT regions (same AWS account) together with a
 * single, apply-once stack:
 *
 *   - Two aws providers with aliases (`aws.left` / `aws.right`) — one per
 *     region. Cross-region peering fundamentally needs both.
 *   - aws_vpc_peering_connection            (created in the LEFT region)
 *   - aws_vpc_peering_connection_accepter   (in the RIGHT region — auto-accepts)
 *   - data "aws_route_tables" on each side (finds every route table in each VPC)
 *   - aws_route x2                          (adds the peer's CIDR route to every
 *                                            route table in both VPCs)
 *
 * Cross-ACCOUNT peering is out of scope for this generator — assumes both VPCs
 * live in the same AWS account (the one connected on the project). Adding
 * cross-account support is a peer_owner_id + IAM-side accept dance we can add
 * later if there's demand.
 */

export type VpcSide = {
  /** AWS region the VPC lives in (e.g. "us-east-1"). */
  region: string;
  /** VPC id (e.g. "vpc-0abc123..."). */
  vpcId: string;
  /** IPv4 CIDR of THIS VPC — used as the destination_cidr_block for the OTHER side's route. */
  cidr: string;
};

export type VpcPeeringSpec = {
  /** Short name for the peering (used as Terraform stack name + tag Name). */
  name: string;
  left: VpcSide;
  right: VpcSide;
  /** Environment key — used for tagging only. */
  env?: string;
  /** Extra tags. */
  tags?: Record<string, string>;
};

/** Simple sanity check — proper CIDR validation is Terraform's job at plan time. */
export function validateVpcId(id: string): { ok: true } | { ok: false; error: string } {
  if (!/^vpc-[0-9a-f]{8,17}$/.test(id)) {
    return { ok: false, error: `"${id}" doesn't look like a VPC id (expected vpc-<hex>).` };
  }
  return { ok: true };
}

export function validateCidr(cidr: string): { ok: true } | { ok: false; error: string } {
  const m = cidr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!m) return { ok: false, error: `"${cidr}" is not a valid IPv4 CIDR (e.g. 10.0.0.0/16).` };
  const parts = [m[1], m[2], m[3], m[4]].map(Number);
  if (parts.some((n) => n < 0 || n > 255)) return { ok: false, error: `Octet out of range in "${cidr}".` };
  const prefix = Number(m[5]);
  if (prefix < 8 || prefix > 32) return { ok: false, error: `Prefix /${prefix} out of range in "${cidr}".` };
  return { ok: true };
}

/**
 * Reject the two obvious mistakes AWS would reject at apply time (or, worse,
 * accept and then hand the user a peering that can't route because the CIDRs
 * overlap). Doesn't try to be a full subnet-overlap checker — just catches
 * "the two sides are identical" and "the regions are the same" (which is
 * intra-region peering, a different resource shape entirely).
 */
export function validatePeeringSpec(spec: VpcPeeringSpec): { ok: true } | { ok: false; error: string } {
  if (spec.left.region === spec.right.region) {
    return {
      ok: false,
      error: `Both sides are in "${spec.left.region}". Cross-region peering needs two DIFFERENT regions; for same-region peering the resource shape is different (no accepter, no provider alias).`,
    };
  }
  if (spec.left.vpcId === spec.right.vpcId) {
    return { ok: false, error: "Cannot peer a VPC with itself." };
  }
  if (spec.left.cidr === spec.right.cidr) {
    return {
      ok: false,
      error: `Both VPCs use the same CIDR (${spec.left.cidr}). Peered VPCs MUST have non-overlapping CIDRs — pick different ones (this is why the vpc-ec2 form's default is 10.0.0.0/16 — the other side should be e.g. 10.1.0.0/16).`,
    };
  }
  for (const [label, side] of [["left", spec.left], ["right", spec.right]] as const) {
    const v = validateVpcId(side.vpcId);
    if (!v.ok) return { ok: false, error: `${label}.vpcId: ${v.error}` };
    const c = validateCidr(side.cidr);
    if (!c.ok) return { ok: false, error: `${label}.cidr: ${c.error}` };
  }
  return { ok: true };
}

export function buildVpcPeeringTerraform(spec: VpcPeeringSpec): Record<string, string> {
  const tags = {
    ManagedBy: "DeepAgent",
    Peering: spec.name,
    ...(spec.env ? { Environment: spec.env } : {}),
    ...(spec.tags ?? {}),
  };

  const versionsTf = `terraform {
  required_version = ">= 1.4"
  required_providers {
    aws = { source = "hashicorp/aws", version = "~> 5.60" }
  }
}

# Two aliased AWS providers — one per region. The peering RESOURCE lives in
# the left region (the requester); the ACCEPTER lives in the right region.
provider "aws" {
  alias  = "left"
  region = "${spec.left.region}"
}

provider "aws" {
  alias  = "right"
  region = "${spec.right.region}"
}
`;

  const mainTf = `# ${spec.name} — cross-region VPC peering
# LEFT:  ${spec.left.vpcId} (${spec.left.region}, ${spec.left.cidr})
# RIGHT: ${spec.right.vpcId} (${spec.right.region}, ${spec.right.cidr})
# Same-account peering. Cross-account is out of scope for this generator.

# Peer_owner_id is the current account (we're same-account). Read it once
# so we don't have to hardcode.
data "aws_caller_identity" "left" {
  provider = aws.left
}

resource "aws_vpc_peering_connection" "this" {
  provider      = aws.left
  vpc_id        = "${spec.left.vpcId}"
  peer_vpc_id   = "${spec.right.vpcId}"
  peer_region   = "${spec.right.region}"
  peer_owner_id = data.aws_caller_identity.left.account_id

  # Cross-region peering CANNOT auto-accept in one call — the requester
  # creates the request; the accepter (below) accepts it in the peer region.
  auto_accept = false

  tags = merge(${jsonToHcl(tags)}, { Name = "${spec.name}", Side = "requester" })
}

resource "aws_vpc_peering_connection_accepter" "this" {
  provider                  = aws.right
  vpc_peering_connection_id = aws_vpc_peering_connection.this.id
  auto_accept               = true

  tags = merge(${jsonToHcl(tags)}, { Name = "${spec.name}", Side = "accepter" })
}

# ── Route wiring — every route table in each VPC gets a route to the peer's CIDR ──
# for_each reads the data source at plan time; the VPCs must already exist.

data "aws_route_tables" "left" {
  provider = aws.left
  vpc_id   = "${spec.left.vpcId}"
}

data "aws_route_tables" "right" {
  provider = aws.right
  vpc_id   = "${spec.right.vpcId}"
}

resource "aws_route" "left_to_right" {
  provider                  = aws.left
  for_each                  = toset(data.aws_route_tables.left.ids)
  route_table_id            = each.value
  destination_cidr_block    = "${spec.right.cidr}"
  vpc_peering_connection_id = aws_vpc_peering_connection.this.id

  # Route must exist AFTER the accepter has accepted, or AWS returns "invalid
  # peering connection state" mid-apply.
  depends_on = [aws_vpc_peering_connection_accepter.this]
}

resource "aws_route" "right_to_left" {
  provider                  = aws.right
  for_each                  = toset(data.aws_route_tables.right.ids)
  route_table_id            = each.value
  destination_cidr_block    = "${spec.left.cidr}"
  vpc_peering_connection_id = aws_vpc_peering_connection.this.id

  depends_on = [aws_vpc_peering_connection_accepter.this]
}
`;

  const outputsTf = `output "peering_connection_id" {
  value       = aws_vpc_peering_connection.this.id
  description = "The VPC peering connection id"
}

output "peering_status" {
  value       = aws_vpc_peering_connection_accepter.this.accept_status
  description = "Should read 'active' once the apply finishes"
}

output "left_summary" {
  value       = "${spec.left.vpcId} in ${spec.left.region} (${spec.left.cidr})"
  description = "Requester VPC"
}

output "right_summary" {
  value       = "${spec.right.vpcId} in ${spec.right.region} (${spec.right.cidr})"
  description = "Accepter VPC"
}

output "verify_command" {
  value       = "aws ec2 describe-vpc-peering-connections --vpc-peering-connection-ids ${"${aws_vpc_peering_connection.this.id}"} --region ${spec.left.region}"
  description = "One-line CLI to confirm status outside of Terraform"
}
`;

  return {
    "main.tf": mainTf,
    "outputs.tf": outputsTf,
    "versions.tf": versionsTf,
  };
}

// ── helpers ─────────────────────────────────────────────────────────────

/** Emit a small object as HCL — used only for the tags block. */
function jsonToHcl(obj: Record<string, string>): string {
  const rows = Object.entries(obj).map(([k, v]) => `    ${JSON.stringify(k)} = ${JSON.stringify(v)}`);
  return "{\n" + rows.join("\n") + "\n  }";
}
