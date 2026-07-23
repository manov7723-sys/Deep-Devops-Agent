/**
 * Jenkins-on-EC2 Terraform generator — one-click Jenkins:
 *
 *   EC2 (Amazon Linux 2023, t3.small default) + SG (8080 open) + EBS root
 *   + IAM role for SSM + user-data script that:
 *     1. Installs Java 17 (Amazon Corretto)
 *     2. Adds the Jenkins yum repo + installs Jenkins RPM
 *     3. Drops an init.groovy.d script that creates an admin user on first
 *        boot (so users don't have to fish `initialAdminPassword` out of
 *        the container logs and complete the setup wizard by hand)
 *     4. Disables the setup wizard entirely (JAVA_OPTS)
 *     5. Enables + starts the systemd service
 *
 * The instance boots in ~3–4 minutes end-to-end; the UI at http://<ip>:8080
 * is reachable as soon as Jenkins finishes initializing (~2 min after the
 * EC2 status check goes green).
 *
 * IMPORTANT security caveat baked into the design: SG opens 8080 to the
 * world (0.0.0.0/0). The admin username + password protect the login page,
 * but the initial password is passed via user-data (visible in EC2 console
 * metadata to anyone with EC2:DescribeInstances). Users should rotate the
 * admin password from inside Jenkins as soon as they can log in.
 */

export type JenkinsVmSpec = {
  /** DNS-safe name prefix. */
  name: string;
  region: string;
  env?: string;

  /** Target VPC id. */
  vpcId: string;
  /** Target subnet id (a public subnet — Jenkins needs a public IP). */
  subnetId: string;

  /** Instance type. Default t3.small — 2 vCPU / 2 GB, enough for solo/team use. */
  instanceType?: string;
  /** Root volume size (GB). Default 30. */
  diskGb?: number;

  /** Admin username created on first boot. Default "admin". */
  adminUsername?: string;
  /** Admin password created on first boot. Required — no default. */
  adminPassword: string;

  /**
   * SG ingress for SSH (port 22). Default omitted — the VM has SSM enabled
   * via its instance profile, so shell access via `aws ssm start-session`
   * works without any inbound rule. Pass a CIDR here only if you want SSH
   * for tooling that can't go via SSM. Passing "0.0.0.0/0" here trips the
   * policy engine and the approval is refused.
   */
  sshCidr?: string;

  /**
   * Name of an EXISTING AWS EC2 key pair to attach to the instance. When
   * set, `ssh -i <your-local.pem> ec2-user@<public_ip>` works (the .pem
   * you already have locally is the private half of this key pair). Leave
   * blank to skip — SSM still works via the IAM instance profile.
   */
  keyName?: string;

  /**
   * When provided (and non-empty), the generator SKIPS creating a fresh
   * aws_security_group and instead attaches these existing SG IDs to the
   * instance. Use for teams that already manage SGs elsewhere (Terraform
   * modules, Cloud Formation, hand-crafted). Mutually exclusive with the
   * jenkinsCidr / sshCidr options (which only apply to the auto-created SG).
   */
  existingSecurityGroupIds?: string[];

  /**
   * SG ingress for the Jenkins UI (port 8080). Default "0.0.0.0/0" — the
   * whole point of this stack is a UI you can hit from anywhere.
   */
  jenkinsCidr?: string;

  tags?: Record<string, string>;
};

export const JENKINS_VM_DEFAULTS = {
  instanceType: "t3.small",
  diskGb: 30,
  adminUsername: "admin",
  // sshCidr intentionally omitted — SSM is the default shell path.
  jenkinsCidr: "0.0.0.0/0",
} as const;

export function buildJenkinsVmTerraform(spec: JenkinsVmSpec): Record<string, string> {
  const name = sanitise(spec.name);
  const instanceType = spec.instanceType ?? JENKINS_VM_DEFAULTS.instanceType;
  const diskGb = spec.diskGb ?? JENKINS_VM_DEFAULTS.diskGb;
  const adminUsername = spec.adminUsername ?? JENKINS_VM_DEFAULTS.adminUsername;
  // Empty / whitespace-only sshCidr means "no SSH rule at all". The policy
  // engine refuses 0.0.0.0/0 on port 22, and SSM covers the shell-access
  // case anyway (via the aws_iam_role_policy_attachment.ssm we always add).
  const sshCidr = spec.sshCidr?.trim() || null;
  const keyName = spec.keyName?.trim() || null;
  const jenkinsCidr = spec.jenkinsCidr ?? JENKINS_VM_DEFAULTS.jenkinsCidr;
  // Filter to non-blank ids. When present, we skip creating our own SG and
  // attach these instead. The generator's SSH/UI CIDR knobs become no-ops
  // in that branch (caller owns the SG's rules).
  const existingSgIds = (spec.existingSecurityGroupIds ?? [])
    .map((s) => s.trim())
    .filter(Boolean);
  const useExistingSgs = existingSgIds.length > 0;
  const tags = {
    ManagedBy: "DeepAgent",
    Stack: name,
    Component: "jenkins",
    ...(spec.env ? { Environment: spec.env } : {}),
    ...(spec.tags ?? {}),
  };

  if (!spec.adminPassword?.trim()) {
    throw new Error("adminPassword is required — pass a strong password to bootstrap the Jenkins admin user.");
  }

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

  // The Groovy init script is heredoc'd inside user-data — Terraform escapes
  // ${...} the same way HCL does, so we escape the two Groovy interpolations
  // we DON'T want Terraform to eat with $${...}. Groovy sees ${ADMIN_*} at
  // runtime because we inject those via the outer bash heredoc.
  const userData = `#!/bin/bash
set -euo pipefail
exec > >(tee /var/log/user-data.log|logger -t user-data) 2>&1

echo "[+] Updating dnf + installing prerequisites"
dnf update -y
dnf install -y java-17-amazon-corretto-devel wget

echo "[+] Adding Jenkins yum repo + installing"
wget -qO /etc/yum.repos.d/jenkins.repo https://pkg.jenkins.io/redhat-stable/jenkins.repo
rpm --import https://pkg.jenkins.io/redhat-stable/jenkins.io-2023.key
dnf install -y jenkins

echo "[+] Preparing Jenkins home + init.groovy.d admin bootstrap"
mkdir -p /var/lib/jenkins/init.groovy.d
cat > /var/lib/jenkins/init.groovy.d/00-create-admin.groovy <<'GROOVY'
import jenkins.model.*
import hudson.security.*

def instance = Jenkins.getInstance()

def hudsonRealm = new HudsonPrivateSecurityRealm(false)
hudsonRealm.createAccount("${escapeGroovy(adminUsername)}", "${escapeGroovy(spec.adminPassword)}")
instance.setSecurityRealm(hudsonRealm)

def strategy = new FullControlOnceLoggedInAuthorizationStrategy()
strategy.setAllowAnonymousRead(false)
instance.setAuthorizationStrategy(strategy)

// Skip the setup wizard state files (belt-and-braces vs the JAVA_OPTS flag).
def state = new File("/var/lib/jenkins/jenkins.install.UpgradeWizard.state")
state.parentFile.mkdirs()
state.text = Jenkins.instance.version.toString()
new File("/var/lib/jenkins/jenkins.install.InstallUtil.lastExecVersion").text = Jenkins.instance.version.toString()

instance.save()
println("[deepagent] Admin user '${escapeGroovy(adminUsername)}' created + setup wizard skipped.")
GROOVY

chown -R jenkins:jenkins /var/lib/jenkins/init.groovy.d

echo "[+] Configuring systemd override to skip the setup wizard"
mkdir -p /etc/systemd/system/jenkins.service.d
cat > /etc/systemd/system/jenkins.service.d/override.conf <<'OVERRIDE'
[Service]
Environment="JAVA_OPTS=-Djenkins.install.runSetupWizard=false -Djava.awt.headless=true"
OVERRIDE

systemctl daemon-reload

echo "[+] Enabling + starting Jenkins"
systemctl enable jenkins
systemctl start jenkins

echo "[+] Waiting for Jenkins to accept HTTP on :8080 (up to 5 minutes)"
for i in $(seq 1 60); do
  if curl -fsS -o /dev/null http://localhost:8080/login; then
    echo "[+] Jenkins is up at http://localhost:8080"
    exit 0
  fi
  sleep 5
done

echo "[!] Jenkins did NOT come up within 5 min — check 'journalctl -u jenkins' and /var/log/user-data.log"
exit 1
`;

  const mainTf = `# ${name} — one-click Jenkins on EC2 (${instanceType}) in ${spec.region}
# Generated by DeepAgent. Rerunning the wizard regenerates this file.
#
# After apply completes, open the jenkins_url output in a browser, log in
# with the admin_username + the password you set, and rotate the password
# from Manage Jenkins → Users at your first login (the current password is
# visible in EC2 user-data metadata).

data "aws_ami" "amazon_linux" {
  most_recent = true
  owners      = ["amazon"]

  filter {
    name   = "name"
    values = ["al2023-ami-*-x86_64"]
  }
  filter {
    name   = "virtualization-type"
    values = ["hvm"]
  }
}

${useExistingSgs ? `# Reusing existing security group(s) — the caller opted out of the built-in
# SG and takes responsibility for the ingress rules (must at minimum allow
# TCP/8080 from wherever the Jenkins UI will be reached, and ideally TCP/22
# from the operator's IP if they plan to SSH).
locals {
  jenkins_security_group_ids = [${existingSgIds.map((id) => JSON.stringify(id)).join(", ")}]
}` : `resource "aws_security_group" "this" {
  name        = "${name}-jenkins-sg"
  description = "Jenkins UI${sshCidr ? " + SSH" : ""} ingress for ${name}"
  vpc_id      = "${spec.vpcId}"

  ingress {
    description = "Jenkins UI"
    from_port   = 8080
    to_port     = 8080
    protocol    = "tcp"
    cidr_blocks = ["${jenkinsCidr}"]
  }
${sshCidr ? `
  ingress {
    description = "SSH"
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["${sshCidr}"]
  }
` : ""}
  egress {
    description = "Allow all outbound"
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }

  tags = ${jsonToHcl(tags, "  ")}
}`}

# SSM instance profile — lets you 'aws ssm start-session' into the box even
# if the SG blocks SSH. Zero extra cost, always useful.
resource "aws_iam_role" "this" {
  name = "${name}-jenkins-role"
  assume_role_policy = jsonencode({
    Version = "2012-10-17"
    Statement = [{
      Effect = "Allow"
      Principal = { Service = "ec2.amazonaws.com" }
      Action = "sts:AssumeRole"
    }]
  })
  tags = ${jsonToHcl(tags, "  ")}
}

resource "aws_iam_role_policy_attachment" "ssm" {
  role       = aws_iam_role.this.name
  policy_arn = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore"
}

resource "aws_iam_instance_profile" "this" {
  name = "${name}-jenkins-profile"
  role = aws_iam_role.this.name
}

resource "aws_instance" "this" {
  ami                         = data.aws_ami.amazon_linux.id
  instance_type               = "${instanceType}"
  subnet_id                   = "${spec.subnetId}"
  vpc_security_group_ids      = ${useExistingSgs ? "local.jenkins_security_group_ids" : "[aws_security_group.this.id]"}
  associate_public_ip_address = true
  iam_instance_profile        = aws_iam_instance_profile.this.name${keyName ? `
  key_name                    = "${keyName}"` : ""}

  root_block_device {
    volume_size = ${diskGb}
    volume_type = "gp3"
    encrypted   = true
  }

  user_data                   = <<-USERDATA
${userData.replace(/\$/g, "$$$$").split("\n").map((l) => "    " + l).join("\n")}
  USERDATA
  user_data_replace_on_change = true

  tags = merge(${jsonToHcl(tags, "  ")}, { Name = "${name}-jenkins" })
}
`;

  const outputsTf = `output "jenkins_url" {
  value       = "http://\${aws_instance.this.public_ip}:8080"
  description = "Open this in a browser once the instance status checks pass — Jenkins takes ~2 min after boot to accept connections."
}

output "jenkins_public_ip" {
  value       = aws_instance.this.public_ip
  description = "Public IP of the Jenkins VM"
}

output "jenkins_admin_username" {
  value       = "${adminUsername}"
  description = "Log in with this username + the password you set at wizard time"
}

output "jenkins_admin_password" {
  value       = ${JSON.stringify(spec.adminPassword)}
  description = "Initial admin password — rotate it from Manage Jenkins → Users at first login (currently visible in EC2 user-data metadata)."
  sensitive   = true
}

output "shell_command" {
  value       = ${sshCidr && keyName
    ? `"ssh -i ~/.ssh/${keyName}.pem ec2-user@\${aws_instance.this.public_ip}"`
    : sshCidr
      ? `"ssh ec2-user@\${aws_instance.this.public_ip}   # add -i <path-to-your-pem> if the SG allows it"`
      : `"aws ssm start-session --target \${aws_instance.this.id} --region ${spec.region}"`}
  description = ${sshCidr && keyName
    ? `"SSH is open (per SG) using key pair '${keyName}'. Use the .pem you downloaded when creating that key pair in the EC2 console."`
    : sshCidr
      ? `"SSH is open (per SG). No AWS key pair attached — either attach one via the wizard or use SSM."`
      : `"SSH is disabled. Uses AWS SSM Session Manager — no inbound rules needed, works over the SSM endpoint."`}
}

output "instance_id" {
  value       = aws_instance.this.id
  description = "EC2 instance id — pass to 'aws ssm start-session --target <id>' for shell access without SSH."
}

output "region" {
  value       = "${spec.region}"
  description = "Region the VM lives in"
}
`;

  return { "main.tf": mainTf, "outputs.tf": outputsTf, "versions.tf": versionsTf };
}

// ── helpers ─────────────────────────────────────────────────────────────

function sanitise(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 40);
}

function jsonToHcl(obj: Record<string, string>, indent: string): string {
  const rows = Object.entries(obj).map(([k, v]) => `${indent}  ${JSON.stringify(k)} = ${JSON.stringify(v)}`);
  return "{\n" + rows.join("\n") + `\n${indent}}`;
}

// Escapes a string so it can safely appear inside a Groovy DOUBLE-quoted
// literal (which is what we build via `"…${VAR}…"` interpolation). Backslash
// first (so we don't re-escape the escapes we're about to write), then quote.
function escapeGroovy(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\$/g, "\\$");
}
