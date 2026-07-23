/**
 * AWS EC2-in-existing-VPC Terraform generator.
 *
 * Console-style launch wizard equivalent — every field the AWS EC2 launch
 * wizard exposes as first-class is a spec field here. Assumes the caller
 * already has a VPC + subnet (from the VPC flow or an existing one they
 * picked from the Network > EC2 page's dropdown).
 *
 * Produces (all in one stack):
 *   - aws_security_group + rules   (egress-all; ingress = SSH (custom CIDR)
 *                                    + optional HTTP/HTTPS to the world)
 *   - aws_iam_role + policy attach + instance_profile  (AmazonSSMManagedInstanceCore,
 *                                                       so users shell in via SSM
 *                                                       with no SSH port open)
 *   - data "aws_ami" "target"      (latest AMI for the picked family — no drift)
 *   - aws_instance                 (single EC2 in the picked subnet, encrypted
 *                                    gp3 root by default, optional user_data)
 *   - aws_eip                      (public IP attached)
 *   - Outputs: instance_id, public_ip, ssm_command
 */

export type Ec2AmiFamily =
  | "al2023"
  | "ubuntu-22.04"
  | "ubuntu-24.04"
  | "windows-2022"
  | "rhel-9"
  | "sles-15"
  | "debian-12";

export type Ec2VolumeType = "gp3" | "gp2" | "io2";

export type Ec2Spec = {
  /** DNS-safe name prefix for tagged resources. */
  name: string;
  region: string;
  env?: string;
  /** VPC id (vpc-<hex>) the instance's SG lives in — the caller-picked VPC. */
  vpcId: string;
  /** Subnet id (subnet-<hex>) the instance launches into — MUST be within `vpcId`. */
  subnetId: string;
  ami?: Ec2AmiFamily;
  instanceType?: string;
  diskGb?: number;
  /** Root volume type. Default gp3. */
  volumeType?: Ec2VolumeType;
  /** Root volume IOPS. Only respected for gp3/io2 volumes. Optional. */
  volumeIops?: number;
  /** Encrypt the root volume. Default true (matches AWS's recommended default). */
  encryptVolume?: boolean;
  /** Empty/undefined = no SSH ingress (SSM-only). Any CIDR = open :22 from that CIDR. */
  sshCidr?: string;
  /** Existing EC2 key pair in this account+region. Optional; SSM works without it. */
  sshKeyName?: string;
  /** Open TCP/80 to the internet (for web servers). */
  allowHttp?: boolean;
  /** Open TCP/443 to the internet (for web servers). */
  allowHttps?: boolean;
  /**
   * Bash script (or cloud-init YAML on Ubuntu) that runs on first boot.
   * Passed to aws_instance.user_data raw (Terraform base64-encodes it).
   */
  userData?: string;
  /** Additional tags merged in on top of the app's defaults. */
  tags?: Record<string, string>;
};

export const EC2_DEFAULTS = {
  ami: "al2023" as Ec2AmiFamily,
  instanceType: "t3.micro",
  diskGb: 20,
  volumeType: "gp3" as Ec2VolumeType,
  encryptVolume: true,
} as const;

export const EC2_INSTANCE_TYPES = [
  "t3.micro",
  "t3.small",
  "t3.medium",
  "t3.large",
  "t3.xlarge",
  "m5.large",
  "m5.xlarge",
  "m5.2xlarge",
] as const;

export const EC2_AMI_FAMILIES: Ec2AmiFamily[] = [
  "al2023",
  "ubuntu-22.04",
  "ubuntu-24.04",
  "windows-2022",
  "rhel-9",
  "sles-15",
  "debian-12",
];

/** Validate a VPC / subnet id at least LOOKS like one. */
export function validateAwsId(kind: "vpc" | "subnet", id: string): { ok: true } | { ok: false; error: string } {
  const re = kind === "vpc" ? /^vpc-[0-9a-f]{8,17}$/ : /^subnet-[0-9a-f]{8,17}$/;
  if (!re.test(id)) return { ok: false, error: `"${id}" doesn't look like a ${kind} id (expected ${kind}-<hex>).` };
  return { ok: true };
}

/** Same CIDR sanity check as vpc.ts — repeated here so ec2 has no cross-import. */
export function validateCidr(cidr: string): { ok: true } | { ok: false; error: string } {
  const m = cidr.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/);
  if (!m) return { ok: false, error: `"${cidr}" is not a valid IPv4 CIDR (e.g. 0.0.0.0/0).` };
  const parts = [m[1], m[2], m[3], m[4]].map(Number);
  if (parts.some((n) => n < 0 || n > 255)) return { ok: false, error: `Octet out of range in "${cidr}".` };
  const prefix = Number(m[5]);
  if (prefix < 0 || prefix > 32) return { ok: false, error: `Prefix /${prefix} out of range in "${cidr}".` };
  return { ok: true };
}

export function buildEc2Terraform(spec: Ec2Spec): Record<string, string> {
  const name = sanitise(spec.name);
  const ami = spec.ami ?? EC2_DEFAULTS.ami;
  const instanceType = spec.instanceType ?? EC2_DEFAULTS.instanceType;
  const diskGb = spec.diskGb ?? EC2_DEFAULTS.diskGb;
  const volumeType = spec.volumeType ?? EC2_DEFAULTS.volumeType;
  const encrypted = spec.encryptVolume ?? EC2_DEFAULTS.encryptVolume;
  const sshCidr = spec.sshCidr?.trim() || null;
  const allowHttp = !!spec.allowHttp;
  const allowHttps = !!spec.allowHttps;
  const userData = spec.userData?.trim() || null;

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

  const amiBlock = amiDataBlock(ami);

  // Ingress rules — each one is a separate aws_security_group_rule so they
  // can be toggled independently without redeploying the whole SG.
  const ingressBlocks: string[] = [];
  if (sshCidr) {
    ingressBlocks.push(`# SSH ingress rule — user opened TCP/22 to ${sshCidr}. Prefer SSM
# Session Manager (no rule needed) when you can; keep this only if you
# genuinely need SSH from that CIDR.
resource "aws_security_group_rule" "ssh_ingress" {
  type              = "ingress"
  from_port         = 22
  to_port           = 22
  protocol          = "tcp"
  security_group_id = aws_security_group.instance.id
  cidr_blocks       = ["${sshCidr}"]
  description       = "SSH from ${sshCidr}"
}`);
  }
  if (allowHttp) {
    ingressBlocks.push(`resource "aws_security_group_rule" "http_ingress" {
  type              = "ingress"
  from_port         = 80
  to_port           = 80
  protocol          = "tcp"
  security_group_id = aws_security_group.instance.id
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "HTTP from the internet"
}`);
  }
  if (allowHttps) {
    ingressBlocks.push(`resource "aws_security_group_rule" "https_ingress" {
  type              = "ingress"
  from_port         = 443
  to_port           = 443
  protocol          = "tcp"
  security_group_id = aws_security_group.instance.id
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "HTTPS from the internet"
}`);
  }
  const ingressRuleBlock =
    ingressBlocks.length > 0
      ? ingressBlocks.join("\n\n") + "\n\n"
      : `# No ingress rules — shell in via SSM Session Manager instead.
# See the ssm_command output below for the exact command.

`;

  // Root volume block — IOPS is only settable for gp3/io2; skip otherwise.
  const iopsLine =
    spec.volumeIops && (volumeType === "gp3" || volumeType === "io2")
      ? `\n    iops                  = ${spec.volumeIops}`
      : "";

  const userDataAttr = userData
    ? `\n  # user_data runs on first boot as root. Terraform base64-encodes it.
  user_data                   = <<-USERDATA
${userData.replace(/^/gm, "    ")}
  USERDATA
  user_data_replace_on_change = false`
    : "";

  const mainTf = `# ${name} — EC2 ${instanceType} (${ami}) in ${spec.vpcId}/${spec.subnetId} (${spec.region})
# Generated by DeepAgent. Rerunning the wizard regenerates this file.

resource "aws_security_group" "instance" {
  name        = "${name}-sg"
  description = "${name} EC2 SG. Ingress: ${sgSummary(sshCidr, allowHttp, allowHttps)}. Egress: all."
  vpc_id      = "${spec.vpcId}"
  tags        = merge(${jsonToHcl(tags)}, { Name = "${name}-sg" })
}

resource "aws_security_group_rule" "egress_all" {
  type              = "egress"
  from_port         = 0
  to_port           = 0
  protocol          = "-1"
  security_group_id = aws_security_group.instance.id
  cidr_blocks       = ["0.0.0.0/0"]
  description       = "All egress"
}

${ingressRuleBlock}${iamRoleForSsmBlock(name, tags)}

${amiBlock}

resource "aws_instance" "this" {
  ami                    = data.aws_ami.target.id
  instance_type          = "${instanceType}"
  subnet_id              = "${spec.subnetId}"
  vpc_security_group_ids = [aws_security_group.instance.id]
  iam_instance_profile   = aws_iam_instance_profile.ssm.name${spec.sshKeyName ? `
  key_name               = "${spec.sshKeyName}"` : ""}${userDataAttr}

  root_block_device {
    volume_size           = ${diskGb}
    volume_type           = "${volumeType}"${iopsLine}
    encrypted             = ${encrypted}
    delete_on_termination = true
  }

  metadata_options {
    http_tokens   = "required"
    http_endpoint = "enabled"
  }

  tags = merge(${jsonToHcl(tags)}, { Name = "${name}-instance" })
}

resource "aws_eip" "this" {
  instance = aws_instance.this.id
  domain   = "vpc"
  tags     = merge(${jsonToHcl(tags)}, { Name = "${name}-eip" })
}
`;

  const outputsTf = `output "instance_id" {
  value       = aws_instance.this.id
  description = "EC2 instance id"
}

output "security_group_id" {
  value       = aws_security_group.instance.id
  description = "ID of the EC2 security group"
}

output "public_ip" {
  value       = aws_eip.this.public_ip
  description = "Public Elastic IP attached to the EC2 instance"
}

output "ssm_command" {
  value       = "aws ssm start-session --target ${"${aws_instance.this.id}"} --region ${spec.region}"
  description = "One-line shell-in over SSM (works with no SSH port open)"
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

/** ASCII-only summary of which ingress rules were opened (SG descriptions
 *  reject non-ASCII / <> / etc. — see aws_security_group description charset). */
function sgSummary(sshCidr: string | null, allowHttp: boolean, allowHttps: boolean): string {
  const parts: string[] = [];
  if (sshCidr) parts.push(`SSH from ${sshCidr}`);
  if (allowHttp) parts.push("HTTP from anywhere");
  if (allowHttps) parts.push("HTTPS from anywhere");
  return parts.length === 0 ? "none, SSM only" : parts.join(" and ");
}

function iamRoleForSsmBlock(name: string, tags: Record<string, string>): string {
  return `resource "aws_iam_role" "ssm" {
  name = "${name}-ec2-ssm"

  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action = "sts:AssumeRole"
    }]
  })

  tags = ${jsonToHcl(tags)}
}

resource "aws_iam_role_policy_attachment" "ssm_core" {
  role       = aws_iam_role.ssm.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "ssm" {
  name = "${name}-ec2-ssm"
  role = aws_iam_role.ssm.name
}`;
}

/**
 * Latest-AMI lookup for each supported OS family. Owner ids are the
 * standard AWS publisher accounts:
 *   137112412989 Amazon (AL2023)
 *   099720109477 Canonical (Ubuntu)
 *   801119661308 Amazon (Windows Server)
 *   309956199498 Red Hat
 *   013907871322 SUSE
 *   136693071363 Debian
 */
function amiDataBlock(ami: Ec2AmiFamily): string {
  const table: Record<Ec2AmiFamily, { owner: string; namePattern: string; label: string }> = {
    "al2023": {
      owner: "137112412989",
      namePattern: "al2023-ami-*-x86_64",
      label: "Amazon Linux 2023",
    },
    "ubuntu-22.04": {
      owner: "099720109477",
      namePattern: "ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*",
      label: "Ubuntu 22.04 LTS",
    },
    "ubuntu-24.04": {
      owner: "099720109477",
      namePattern: "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*",
      label: "Ubuntu 24.04 LTS",
    },
    "windows-2022": {
      owner: "801119661308",
      namePattern: "Windows_Server-2022-English-Full-Base-*",
      label: "Windows Server 2022",
    },
    "rhel-9": {
      owner: "309956199498",
      namePattern: "RHEL-9.*_HVM-*-x86_64-*-Hourly2-GP2",
      label: "Red Hat Enterprise Linux 9",
    },
    "sles-15": {
      owner: "013907871322",
      namePattern: "suse-sles-15-sp*-v*-hvm-ssd-x86_64",
      label: "SUSE Linux Enterprise Server 15",
    },
    "debian-12": {
      owner: "136693071363",
      namePattern: "debian-12-amd64-*",
      label: "Debian 12",
    },
  };
  const { owner, namePattern, label } = table[ami];
  return `# Latest ${label} AMI (owner ${owner}).
data "aws_ami" "target" {
  most_recent = true
  owners      = ["${owner}"]
  filter {
    name   = "name"
    values = ["${namePattern}"]
  }
  filter {
    name   = "state"
    values = ["available"]
  }
}`;
}
