/**
 * Helpers for extracting the Client VPN endpoint's CA material from
 * Terraform state — used by the on-demand cert-issuance flows.
 *
 * Two paths:
 *   1. FAST — from `terraform output -json`: works if the stack was
 *      generated AFTER we added the ca_private_key_pem output.
 *   2. FALLBACK — from `terraform state pull` + JSON parse of the state
 *      file's resource attributes: works on OLDER stacks too, so users
 *      don't have to re-apply just to add an output that was always in
 *      state to begin with. The state file has the CA key regardless of
 *      whether we bothered to expose it as an output.
 */
import { runStage } from "@/lib/runner/exec";

export type CaMaterial = {
  caCertPem: string;
  caPrivateKeyPem: string;
  endpointId: string | null;
  endpointDns: string | null;
  region: string | null;
};

/**
 * The initial client cert + key that Terraform generates alongside the CA
 * when the VPN endpoint is first stood up. Same tls_* resource names on
 * every provider — resolved from state so no re-apply required.
 */
export type InitialClientMaterial = {
  clientCertPem: string;
  clientKeyPem: string;
};

type Outputs = Record<string, { value: unknown; sensitive?: boolean }>;

/**
 * Pull the pieces we need from `terraform output -json`'s parsed result.
 * Anything missing here triggers the state-pull fallback in `resolveCaFromState`.
 */
export function readCaFromOutputs(outputs: Outputs): Partial<CaMaterial> {
  const pick = (k: string): string | null => {
    const v = outputs[k]?.value;
    return typeof v === "string" ? v : null;
  };
  return {
    caCertPem: pick("ca_certificate_pem") ?? undefined,
    caPrivateKeyPem: pick("ca_private_key_pem") ?? undefined,
    endpointId: pick("client_vpn_endpoint_id"),
    endpointDns: pick("client_vpn_dns_name"),
    region: pick("region"),
  } as Partial<CaMaterial>;
}

/**
 * When outputs don't have what we need, pull the raw state JSON and dig
 * into the resource attributes. The CA private key + cert are attributes on
 * the `tls_private_key.ca` and `tls_self_signed_cert.ca` resources — always
 * present in state, regardless of what the stack chose to expose as outputs.
 */
export async function resolveCaFromState(args: {
  workspace: string;
  // runStage accepts a plain Record; keep types loose enough that both
  // process.env-derived envs and hand-built ones flow through.
  execEnv: Record<string, string | undefined>;
  seed: Partial<CaMaterial>;
}): Promise<{ ok: true; material: CaMaterial } | { ok: false; message: string }> {
  const { workspace, execEnv, seed } = args;
  const need = !seed.caCertPem || !seed.caPrivateKeyPem;
  if (!need) {
    // Have everything already; just narrow types.
    return {
      ok: true,
      material: {
        caCertPem: seed.caCertPem!,
        caPrivateKeyPem: seed.caPrivateKeyPem!,
        endpointId: seed.endpointId ?? null,
        endpointDns: seed.endpointDns ?? null,
        region: seed.region ?? null,
      },
    };
  }

  // runStage's env requires strings-only (no undefined); strip undefined
  // entries before passing so a caller can hand us the raw process env.
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(execEnv)) {
    if (typeof v === "string") cleanEnv[k] = v;
  }
  const pull = await runStage({
    command: "terraform",
    args: ["state", "pull"],
    cwd: workspace,
    env: cleanEnv,
    timeoutMs: 60_000,
    // Default runStage cap is 32KB and it TRUNCATES OLDER content on overflow.
    // Client VPN state files can easily hit 200KB+ (CA + server + client certs
    // stored inline as base64 in tls_* resources). Without a bigger cap we get
    // the tail of the JSON with no opening `{` and every parse fails.
    maxBufferBytes: 16 * 1024 * 1024,
  });
  if (pull.exitCode !== 0) {
    return {
      ok: false,
      message: `terraform state pull failed: ${pull.stderr.slice(-400) || pull.stdout.slice(-400)}`,
    };
  }

  type StateResource = {
    type?: string;
    name?: string;
    instances?: Array<{ attributes?: Record<string, unknown> }>;
  };
  type ParsedState = { resources?: StateResource[] };
  let parsed: ParsedState | null = null;
  // Some terraform versions prefix stdout with a warning/deprecation banner
  // before the state JSON, or trail it with a summary. Try strict parse
  // first, then a lenient substring-from-first-`{`-to-last-`}` grab.
  const raw = pull.stdout;
  try {
    parsed = JSON.parse(raw) as ParsedState;
  } catch {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        parsed = JSON.parse(raw.slice(first, last + 1)) as ParsedState;
      } catch {
        // fall through — return error with stdout preview so we can debug
      }
    }
  }
  if (!parsed) {
    const preview = raw.slice(0, 300).replace(/\s+/g, " ").trim();
    const stderrPreview = pull.stderr.slice(-300).replace(/\s+/g, " ").trim();
    return {
      ok: false,
      message: `terraform state pull returned non-JSON. stdout preview: "${preview}". stderr: "${stderrPreview}".`,
    };
  }
  const resources = parsed.resources ?? [];

  const findAttr = (type: string, name: string, attr: string): string | null => {
    const r = resources.find((r) => r.type === type && r.name === name);
    const raw = r?.instances?.[0]?.attributes?.[attr];
    return typeof raw === "string" ? raw : null;
  };

  const caCertPem = seed.caCertPem ?? findAttr("tls_self_signed_cert", "ca", "cert_pem") ?? "";
  const caPrivateKeyPem =
    seed.caPrivateKeyPem ?? findAttr("tls_private_key", "ca", "private_key_pem") ?? "";

  if (!caCertPem || !caPrivateKeyPem) {
    return {
      ok: false,
      message:
        "Could not find the CA key/cert in either outputs or state. The stack may not be using auto cert mode " +
        "(the wizard's manual mode stores certs outside our state) — re-provision with certMode='auto' if that's the case.",
    };
  }

  // Also opportunistically fill endpoint fields from state if outputs missed
  // them. Works for AWS Client VPN (aws_ec2_client_vpn_endpoint), Azure
  // OpenVPN (azurerm_public_ip.vpn.ip_address on the endpoint VM), and GCP
  // OpenVPN (google_compute_address.vpn.address). Whichever provider set up
  // the stack, one of these will fill the endpoint DNS/IP.
  const endpointId =
    seed.endpointId ??
    findAttr("aws_ec2_client_vpn_endpoint", "this", "id") ??
    findAttr("azurerm_linux_virtual_machine", "vpn", "id") ??
    findAttr("google_compute_instance", "vpn", "id");
  const endpointDns =
    seed.endpointDns ??
    findAttr("aws_ec2_client_vpn_endpoint", "this", "dns_name") ??
    findAttr("azurerm_public_ip", "vpn", "ip_address") ??
    findAttr("google_compute_address", "vpn", "address");

  return {
    ok: true,
    material: {
      caCertPem,
      caPrivateKeyPem,
      endpointId,
      endpointDns,
      region: seed.region ?? null,
    },
  };
}

/**
 * Pull the initial client cert + key that Terraform generated at apply time.
 * Same resource names on every provider (client-vpn.ts, azure-openvpn.ts,
 * gcp-openvpn.ts all use tls_locally_signed_cert.client + tls_private_key.client).
 * Used by the "download initial cert" flow so users don't have to run
 * `terraform output -raw` themselves — everything's in state.
 */
export async function resolveInitialClientCertFromState(args: {
  workspace: string;
  execEnv: Record<string, string | undefined>;
}): Promise<
  | { ok: true; material: InitialClientMaterial }
  | { ok: false; message: string }
> {
  const { workspace, execEnv } = args;
  const cleanEnv: Record<string, string> = {};
  for (const [k, v] of Object.entries(execEnv)) {
    if (typeof v === "string") cleanEnv[k] = v;
  }
  const pull = await runStage({
    command: "terraform",
    args: ["state", "pull"],
    cwd: workspace,
    env: cleanEnv,
    timeoutMs: 60_000,
    maxBufferBytes: 16 * 1024 * 1024,
  });
  if (pull.exitCode !== 0) {
    return {
      ok: false,
      message: `terraform state pull failed: ${pull.stderr.slice(-400) || pull.stdout.slice(-400)}`,
    };
  }

  type StateResource = {
    type?: string;
    name?: string;
    instances?: Array<{ attributes?: Record<string, unknown> }>;
  };
  type ParsedState = { resources?: StateResource[] };
  let parsed: ParsedState | null = null;
  const raw = pull.stdout;
  try {
    parsed = JSON.parse(raw) as ParsedState;
  } catch {
    const first = raw.indexOf("{");
    const last = raw.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        parsed = JSON.parse(raw.slice(first, last + 1)) as ParsedState;
      } catch {
        /* fall through */
      }
    }
  }
  if (!parsed) {
    return { ok: false, message: "terraform state pull returned non-JSON." };
  }
  const resources = parsed.resources ?? [];
  const findAttr = (type: string, name: string, attr: string): string | null => {
    const r = resources.find((r) => r.type === type && r.name === name);
    const v = r?.instances?.[0]?.attributes?.[attr];
    return typeof v === "string" ? v : null;
  };

  const clientCertPem = findAttr("tls_locally_signed_cert", "client", "cert_pem") ?? "";
  const clientKeyPem = findAttr("tls_private_key", "client", "private_key_pem_pkcs8")
    ?? findAttr("tls_private_key", "client", "private_key_pem")
    ?? "";

  if (!clientCertPem || !clientKeyPem) {
    return {
      ok: false,
      message:
        "Could not find the initial client cert/key in state. The stack may not use auto cert mode — try issuing a per-user cert instead via `create vpn certificates`.",
    };
  }

  return { ok: true, material: { clientCertPem, clientKeyPem } };
}
