/**
 * Infra policy guardrails — deterministic (no OPA/Rego needed) checks that run at
 * the approval gate, BEFORE any apply. Blocks the common foot-guns:
 *   • public object storage (public-read S3 / open bucket policy)
 *   • oversized / GPU instances (runaway cost)
 *   • regions outside the allow-list (data-residency / cost control)
 *   • security groups open to the world on admin ports (22/3389)
 *
 * Takes a structured spec AND/OR raw Terraform HCL to scan. Returns violations;
 * an approval with any HIGH violation must not be created/applied.
 *
 * These defaults are sensible starting rules — later they can be made per-project
 * settings, and OPA/conftest can be added as an optional advanced source.
 */
export type Cloud = "aws" | "azure" | "gcp" | "proxmox";

export type PolicySpec = {
  cloud: Cloud;
  region?: string;
  instanceType?: string;
  /** Structured hint that a bucket/blob is public. */
  publicBucket?: boolean;
  /** Raw Terraform to pattern-scan (all files concatenated). */
  hcl?: string;
};

export type Violation = { rule: string; message: string; severity: "high" | "medium" };
export type PolicyResult = { ok: boolean; violations: Violation[]; checked: string[] };

// Allowed regions per cloud. A region outside these is blocked.
const ALLOWED_REGIONS: Record<Cloud, string[]> = {
  aws: ["us-east-1", "us-east-2", "us-west-2", "eu-west-1", "eu-central-1", "ap-south-1"],
  azure: [
    "eastus",
    "eastus2",
    "westus2",
    "westus3",
    "westeurope",
    "northeurope",
    "centralus",
    "southcentralus",
    "southeastasia",
  ],
  gcp: ["us-central1", "us-east1", "us-west1", "europe-west1", "asia-south1"],
  // Proxmox is self-hosted — "region" is a node name, not a cloud region. The
  // region rule only runs when a spec.region is set, so an empty list is a
  // no-op for Proxmox VMs (which carry a node, not a region).
  proxmox: [],
};

/**
 * Return true iff a single Terraform `ingress { … }` block in the HCL both:
 *   (a) opens TCP/22 (SSH) or TCP/3389 (RDP), AND
 *   (b) allows 0.0.0.0/0.
 *
 * Walks each ingress block individually so a stack that has a narrow-CIDR
 * SSH rule PLUS a wide rule on some other port (Jenkins UI on 8080, RDS on
 * 5432, an egress-all outbound) doesn't get a false positive. Only the
 * genuinely-dangerous "22/3389 open to the world" combination fires.
 */
function hasWorldOpenAdminPort(hcl: string): boolean {
  // Terraform ingress blocks don't nest, so `[^}]*` is safe — matches the
  // block body up to the closing brace on its own line.
  const ingressRe = /\bingress\s*\{([^}]*)\}/g;
  let m: RegExpExecArray | null;
  while ((m = ingressRe.exec(hcl))) {
    const body = m[1] ?? "";
    // Port could be a single number (from_port = 22) OR a range that COVERS
    // 22/3389. Cover the common cases (exact + covering ranges).
    const fromPort = Number(body.match(/from_port\s*=\s*(\d+)/)?.[1] ?? -1);
    const toPort = Number(body.match(/to_port\s*=\s*(\d+)/)?.[1] ?? -1);
    const coversSshOrRdp =
      fromPort === 22 || fromPort === 3389 ||
      (fromPort >= 0 && toPort >= 0 &&
        ((fromPort <= 22 && toPort >= 22) || (fromPort <= 3389 && toPort >= 3389)));
    if (!coversSshOrRdp) continue;
    // Any 0.0.0.0/0 in this block's cidr_blocks list = world-open.
    if (/cidr_blocks\s*=\s*\[[^\]]*"0\.0\.0\.0\/0"[^\]]*\]/.test(body)) {
      return true;
    }
  }
  return false;
}

/** Instance is "oversized"/GPU → block by default (opt-in for big spend). */
function isOversized(instanceType: string): boolean {
  const t = instanceType.toLowerCase();
  if (/\bmetal\b/.test(t) || t.endsWith(".metal")) return true;
  // AWS GPU families
  if (/^(p2|p3|p4|p5|g4|g5|g6|dl1|trn1|inf2)\b/.test(t) || /\b(p3|p4|g5)\./.test(t)) return true;
  // Azure GPU (N-series)
  if (/^(nc|nd|nv)\w*/.test(t)) return true;
  // GCP GPU / accelerator machine types
  if (/^(a2|a3|g2)-/.test(t)) return true;
  // Anything >= 8xlarge (AWS) or huge core counts.
  const m = t.match(/(\d+)xlarge/);
  if (m && Number(m[1]) >= 8) return true;
  if (/standard_[a-z]*(48|64|80|96)/.test(t)) return true; // very large Azure SKUs
  return false;
}

export function checkInfraPolicy(spec: PolicySpec): PolicyResult {
  const violations: Violation[] = [];
  const checked: string[] = [];

  // Region allow-list
  checked.push("region-allow-list");
  if (spec.region) {
    const allowed = ALLOWED_REGIONS[spec.cloud] ?? [];
    if (!allowed.includes(spec.region.trim().toLowerCase())) {
      violations.push({
        rule: "region-allow-list",
        severity: "high",
        message: `Region "${spec.region}" is not in the allowed list for ${spec.cloud.toUpperCase()} (${allowed.join(", ")}).`,
      });
    }
  }

  // Instance size
  checked.push("instance-size");
  if (spec.instanceType && isOversized(spec.instanceType)) {
    violations.push({
      rule: "instance-size",
      severity: "high",
      message: `Instance type "${spec.instanceType}" is oversized/GPU and blocked by default — it can cost thousands/month. Pick a smaller type or get an exception.`,
    });
  }

  // Public storage (structured)
  checked.push("no-public-storage");
  if (spec.publicBucket) {
    violations.push({
      rule: "no-public-storage",
      severity: "high",
      message:
        "Object storage is set to public — public buckets are blocked. Use private + signed URLs / CloudFront.",
    });
  }

  // HCL pattern scan
  if (spec.hcl && spec.hcl.trim()) {
    const hcl = spec.hcl;
    checked.push("hcl-scan");

    if (
      /acl\s*=\s*"public-read(-write)?"/i.test(hcl) ||
      /"?Principal"?\s*[:=]\s*"?\*"?/.test(hcl)
    ) {
      violations.push({
        rule: "no-public-storage",
        severity: "high",
        message:
          'Terraform grants public access (public-read ACL or Principal "*"). Public storage/policies are blocked.',
      });
    }
    if (
      /block_public_acls\s*=\s*false/i.test(hcl) ||
      /restrict_public_buckets\s*=\s*false/i.test(hcl)
    ) {
      violations.push({
        rule: "no-public-storage",
        severity: "high",
        message:
          "S3 public-access block is disabled (block_public_acls/restrict_public_buckets = false). Keep public access blocked.",
      });
    }
    // Admin ports open to the world.
    // OLD behavior treated the whole HCL as one soup — any '0.0.0.0/0'
    // anywhere + any port 22/3389 anywhere fired the rule. That was a false
    // positive whenever a stack had (a) an SSH rule to a narrow CIDR AND
    // (b) a separate rule (e.g. Jenkins UI on 8080, or the egress "all
    // outbound") using 0.0.0.0/0. Now we walk each ingress { … } block
    // individually and only flag when the SAME block has port 22/3389 AND
    // 0.0.0.0/0.
    const adminPortOpen = hasWorldOpenAdminPort(hcl);
    if (adminPortOpen) {
      violations.push({
        rule: "no-world-open-admin",
        severity: "high",
        message:
          "A security group opens SSH/RDP (22/3389) to 0.0.0.0/0. Restrict admin access to known IPs / a bastion.",
      });
    }
    // Oversized instance declared in HCL
    const it =
      hcl.match(/instance_type\s*=\s*"([^"]+)"/i)?.[1] ||
      hcl.match(/machine_type\s*=\s*"([^"]+)"/i)?.[1];
    if (it && isOversized(it)) {
      violations.push({
        rule: "instance-size",
        severity: "high",
        message: `Terraform declares an oversized/GPU instance ("${it}"). Blocked by default.`,
      });
    }
  }

  // De-dup by rule+message.
  const seen = new Set<string>();
  const deduped = violations.filter((v) => {
    const k = `${v.rule}:${v.message}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { ok: deduped.every((v) => v.severity !== "high"), violations: deduped, checked };
}
