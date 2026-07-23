"use client";

/**
 * AWS Client VPN creation wizard, embedded in chat via the ```client-vpn-create```
 * fence. Same paged-wizard UX as VpcCreateBox / Ec2CreateBox — no LLM once the
 * fence is emitted; this component owns the whole flow through the approval-card.
 *
 * NOTE: unlike VPC/EC2, we can't fully hide certificate setup — AWS Client VPN
 * requires ACM-imported certs (server + client root CA) that the user must
 * generate off-cluster with easy-rsa. The cert page includes a one-paste
 * command block for that + fields to paste the resulting ACM ARNs.
 */
import { useEffect, useMemo, useState } from "react";
import { Block, Btn, Field, Input, Select, type SelectOption } from "@/components/ui";
import { ApprovalCard } from "@/components/domain/ApprovalCard";
import { useProjectEnvs } from "@/hooks/queries/project";
import { useAwsVpcsInRegion, useAwsSubnetsInVpc, useSubmitClientVpn } from "@/hooks/queries/network";

// Shared with every AWS picker in the app — see lib/aws-regions.ts.
import { AWS_REGIONS } from "@/lib/aws-regions";

type AuthMode = "certificate" | "federated";
type CertMode = "auto" | "manual";
type Answers = {
  name: string;
  region: string;
  envKey: string;
  vpcId: string;
  vpcCidr: string;
  subnetIds: string[];
  clientCidr: string;
  certOwnerName: string;
  certMode: CertMode;
  serverCertificateArn: string;
  authMode: AuthMode;
  clientRootCertificateArn: string;
  samlProviderArn: string;
  splitTunnel: boolean;
  allowInternetEgress: boolean;
};

const PAGE_TITLES = ["Name & network", "Subnets & client CIDR", "Auth & certificates", "Tunnel options", "Review"];
const CIDR_RE = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;

const AUTH_OPTIONS: SelectOption[] = [
  { value: "certificate", label: "Mutual TLS (client cert — easiest for small teams)" },
  { value: "federated", label: "Federated SAML/OIDC (uses your IdP — best for orgs)" },
];

const CERT_MODE_OPTIONS: SelectOption[] = [
  { value: "auto", label: "Auto — generate CA + server + client cert (recommended)" },
  { value: "manual", label: "Manual — I'll paste ACM ARNs I already imported" },
];

export function ClientVpnCreateBox({ slug }: { slug: string }) {
  const { data: envs } = useProjectEnvs(slug);
  const submit = useSubmitClientVpn(slug);

  const [answers, setAnswers] = useState<Answers>({
    name: "client-vpn",
    region: "us-east-1",
    envKey: "",
    vpcId: "",
    vpcCidr: "",
    subnetIds: [],
    clientCidr: "10.100.0.0/22",
    // Cert owner name → shows in Connection Log's Common Name column.
    // Blank means "use the stack name" (back-compat with earlier flows).
    certOwnerName: "",
    certMode: "auto",
    serverCertificateArn: "",
    authMode: "certificate",
    clientRootCertificateArn: "",
    samlProviderArn: "",
    splitTunnel: true,
    allowInternetEgress: false,
  });
  const [pageIdx, setPageIdx] = useState(0);
  const [serverError, setServerError] = useState<string | null>(null);
  const [result, setResult] = useState<{ approvalId: string; repoPath: string; repoFullName: string } | null>(null);

  const vpcsQuery = useAwsVpcsInRegion(slug, answers.region || null);
  const subnetsQuery = useAwsSubnetsInVpc(slug, answers.region || null, answers.vpcId || null);

  useEffect(() => {
    if (answers.envKey || !envs?.length) return;
    setAnswers((a) => ({ ...a, envKey: envs[0]!.key }));
  }, [envs, answers.envKey]);

  // When VPC selection changes, reset subnets + prefill vpcCidr from the picker.
  useEffect(() => {
    const vpcs = vpcsQuery.data && "vpcs" in vpcsQuery.data ? vpcsQuery.data.vpcs : [];
    const picked = vpcs.find((v) => v.vpcId === answers.vpcId);
    if (picked && picked.cidr !== answers.vpcCidr) {
      setAnswers((a) => ({ ...a, vpcCidr: picked.cidr, subnetIds: [] }));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [answers.vpcId, vpcsQuery.data]);

  const envOptions: SelectOption[] = (envs ?? []).map((e) => ({ value: e.key, label: e.name || e.key }));
  const regionOptions: SelectOption[] = useMemo(() => AWS_REGIONS.map((r) => ({ value: r, label: r })), []);
  const vpcs = vpcsQuery.data && "vpcs" in vpcsQuery.data ? vpcsQuery.data.vpcs : [];
  const vpcOptions: SelectOption[] = vpcs.map((v) => ({
    value: v.vpcId,
    label: `${v.vpcId} · ${v.cidr}${v.name ? ` · ${v.name}` : ""}`,
  }));
  const subnets = subnetsQuery.data?.ok ? subnetsQuery.data.subnets ?? [] : [];

  // Client CIDR overlap with VPC CIDR — a common mistake that AWS rejects at plan time.
  const cidrsOverlap =
    !!answers.vpcCidr &&
    !!answers.clientCidr &&
    CIDR_RE.test(answers.vpcCidr) &&
    CIDR_RE.test(answers.clientCidr) &&
    answers.vpcCidr.split("/")[0].split(".").slice(0, 2).join(".") ===
      answers.clientCidr.split("/")[0].split(".").slice(0, 2).join(".");

  const errors: Partial<Record<keyof Answers, string>> = {};
  if (pageIdx === 0) {
    if (!/^[a-z][a-z0-9-]{1,40}$/.test(answers.name.trim())) errors.name = "Lowercase, dashes, 2-41 chars, starts with a letter.";
    if (!answers.region) errors.region = "Pick a region.";
    if (!answers.envKey) errors.envKey = "Pick an env.";
    if (!answers.vpcId) errors.vpcId = "Pick a VPC.";
  }
  if (pageIdx === 1) {
    if (answers.subnetIds.length === 0) errors.subnetIds = "Pick at least one subnet.";
    if (!CIDR_RE.test(answers.clientCidr.trim())) errors.clientCidr = "Not a valid IPv4 CIDR.";
    else if (cidrsOverlap) errors.clientCidr = `Client CIDR must not overlap the VPC CIDR (${answers.vpcCidr}). Try 10.100.0.0/22.`;
  }
  if (pageIdx === 2) {
    const acmRe = /^arn:aws:acm:[a-z0-9-]+:\d{12}:certificate\//;
    // In auto mode we skip ARN validation entirely — Terraform generates + imports the certs.
    if (answers.certMode === "manual") {
      if (!acmRe.test(answers.serverCertificateArn.trim())) errors.serverCertificateArn = "Paste a valid ACM cert ARN (arn:aws:acm:<region>:<acct>:certificate/…).";
      if (answers.authMode === "certificate" && !acmRe.test(answers.clientRootCertificateArn.trim())) {
        errors.clientRootCertificateArn = "Paste the client root CA ARN (often the same as the server cert if generated together).";
      }
    }
    if (answers.authMode === "federated" && !/^arn:aws:iam::\d{12}:saml-provider\//.test(answers.samlProviderArn.trim())) {
      errors.samlProviderArn = "Paste the SAML provider ARN (arn:aws:iam::<acct>:saml-provider/…).";
    }
  }
  const pageHasError = Object.keys(errors).length > 0;
  const onReview = pageIdx === PAGE_TITLES.length - 1;

  function next() { if (!pageHasError) setPageIdx((i) => Math.min(PAGE_TITLES.length - 1, i + 1)); }
  function back() { setPageIdx((i) => Math.max(0, i - 1)); }

  function toggleSubnet(id: string) {
    setAnswers((a) => {
      const has = a.subnetIds.includes(id);
      const next = has ? a.subnetIds.filter((s) => s !== id) : [...a.subnetIds, id];
      return { ...a, subnetIds: next.slice(0, 3) };
    });
  }

  async function handleCreate() {
    setServerError(null);
    try {
      const res = await submit.mutateAsync({
        name: answers.name.trim(),
        envKey: answers.envKey,
        region: answers.region,
        vpcId: answers.vpcId,
        vpcCidr: answers.vpcCidr,
        subnetIds: answers.subnetIds,
        clientCidr: answers.clientCidr.trim(),
        // Only send certOwnerName in auto mode — manual mode uses the pasted ARNs.
        certOwnerName:
          answers.certMode === "auto" && answers.certOwnerName.trim()
            ? answers.certOwnerName.trim()
            : undefined,
        certMode: answers.certMode,
        serverCertificateArn: answers.certMode === "manual" ? answers.serverCertificateArn.trim() : undefined,
        authMode: answers.authMode,
        clientRootCertificateArn: answers.certMode === "manual" && answers.authMode === "certificate" ? answers.clientRootCertificateArn.trim() : undefined,
        samlProviderArn: answers.authMode === "federated" ? answers.samlProviderArn.trim() : undefined,
        splitTunnel: answers.splitTunnel,
        allowInternetEgress: answers.allowInternetEgress,
      });
      if (res.approvalId) {
        setResult({
          approvalId: res.approvalId,
          repoPath: res.repoPath ?? "",
          repoFullName: res.repoFullName ?? "",
        });
      }
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "Client VPN submit failed.");
    }
  }

  if (result) {
    return (
      <Block>
        <Block.Header>
          <Block.Title sub={`Files committed to ${result.repoFullName}/${result.repoPath}. Approve below to run terraform apply.`}>
            Client VPN submitted — pending approval
          </Block.Title>
        </Block.Header>
        <Block.Body>
          <ApprovalCard slug={slug} approvalId={result.approvalId} />
        </Block.Body>
      </Block>
    );
  }

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Console-style Client VPN creation. Requires pre-generated ACM certs (easy-rsa off-cluster).">
          Create Client VPN
        </Block.Title>
      </Block.Header>
      <Block.Body>
        <div className="col gap-4" style={{ maxWidth: 680 }}>
          <div className="row gap-2" style={{ alignItems: "center" }}>
            {PAGE_TITLES.map((_, i) => (
              <span
                key={i}
                style={{
                  flex: 1, height: 4, borderRadius: 2,
                  background: i <= pageIdx ? "var(--accent, #5b8cff)" : "var(--surface-3, #00000018)",
                }}
              />
            ))}
          </div>
          <span className="muted" style={{ fontSize: 12.5, fontWeight: 600 }}>
            Step {pageIdx + 1} of {PAGE_TITLES.length} · {PAGE_TITLES[pageIdx]}
          </span>

          {pageIdx === 0 && (
            <div className="col gap-3">
              <Field label="Name prefix" required hint="Lowercase, dashes." error={errors.name}>
                <Input value={answers.name} onChange={(e) => setAnswers((a) => ({ ...a, name: e.target.value }))} className="mono" />
              </Field>
              <Field label="Region" required error={errors.region}>
                <Select options={regionOptions} value={answers.region} onValueChange={(v) => setAnswers((a) => ({ ...a, region: v, vpcId: "", vpcCidr: "", subnetIds: [] }))} ariaLabel="Region" />
              </Field>
              <Field label="Environment" required error={errors.envKey}>
                <Select options={envOptions} value={answers.envKey} onValueChange={(v) => setAnswers((a) => ({ ...a, envKey: v }))} ariaLabel="Environment" placeholder="Pick an env…" />
              </Field>
              <Field
                label="Target VPC"
                required
                error={errors.vpcId}
                hint={!answers.region ? "Pick a region first." : vpcsQuery.isLoading ? "Loading VPCs…" : vpcs.length === 0 ? "No VPCs in this region." : `${vpcs.length} VPC${vpcs.length === 1 ? "" : "s"} in ${answers.region}. VPC CIDR is auto-filled from your pick.`}
              >
                <Select options={vpcOptions} value={answers.vpcId} onValueChange={(v) => setAnswers((a) => ({ ...a, vpcId: v }))} ariaLabel="VPC" placeholder="Pick a VPC…" disabled={!answers.region || vpcOptions.length === 0} />
              </Field>
              {answers.vpcCidr && (
                <div className="muted" style={{ fontSize: 12 }}>
                  VPC CIDR: <span className="mono">{answers.vpcCidr}</span>
                </div>
              )}
            </div>
          )}

          {pageIdx === 1 && (
            <div className="col gap-3">
              <div style={{ fontWeight: 600, fontSize: 13 }}>Subnet associations (1-3)</div>
              <div className="muted" style={{ fontSize: 12 }}>
                Each association attaches the VPN endpoint to a subnet in its AZ. Multiple subnets = HA across AZs, but each adds ~$72/mo.
              </div>
              <div className="col gap-1" style={{ maxHeight: 240, overflowY: "auto", border: "1px solid var(--border)", borderRadius: 8, padding: 8 }}>
                {subnets.length === 0 ? (
                  <div className="muted" style={{ fontSize: 12.5, padding: 8 }}>
                    {subnetsQuery.isLoading ? "Loading subnets…" : "No subnets found for this VPC."}
                  </div>
                ) : subnets.map((s) => {
                  // Truth-based labels — hasIgwRoute means "picks up full-tunnel
                  // internet if you want it", hasNatRoute means "VPC-only egress
                  // works but full-tunnel internet won't". Blank badge = isolated.
                  const kind = s.hasIgwRoute ? "public (IGW)" : s.hasNatRoute ? "private (NAT)" : "private (isolated)";
                  const kindColor = s.hasIgwRoute ? "var(--success)" : s.hasNatRoute ? "var(--info)" : "var(--muted)";
                  return (
                    <label key={s.subnetId} className="row gap-2" style={{ fontSize: 13, cursor: "pointer", padding: 4 }}>
                      <input
                        type="checkbox"
                        checked={answers.subnetIds.includes(s.subnetId)}
                        onChange={() => toggleSubnet(s.subnetId)}
                        disabled={!answers.subnetIds.includes(s.subnetId) && answers.subnetIds.length >= 3}
                      />
                      <span className="mono">{s.subnetId}</span>
                      <span className="muted">· {s.cidr} · {s.az}{s.name ? ` · ${s.name}` : ""}</span>
                      <span style={{ marginLeft: "auto", fontSize: 11, color: kindColor }}>{kind}</span>
                    </label>
                  );
                })}
              </div>
              {errors.subnetIds && <p style={{ fontSize: 12.5, color: "var(--danger)" }}>{errors.subnetIds}</p>}
              <Field label="Client CIDR" required error={errors.clientCidr} hint="IP pool handed out to connected clients. Must not overlap your VPC CIDR. /22 or larger.">
                <Input value={answers.clientCidr} onChange={(e) => setAnswers((a) => ({ ...a, clientCidr: e.target.value }))} className="mono" />
              </Field>
            </div>
          )}

          {pageIdx === 2 && (
            <div className="col gap-3">
              <Field label="Authentication mode" required>
                <Select options={AUTH_OPTIONS} value={answers.authMode} onValueChange={(v) => setAnswers((a) => ({ ...a, authMode: v as AuthMode }))} ariaLabel="Auth mode" />
              </Field>

              {answers.authMode === "certificate" && (
                <Field
                  label="Certificate mode"
                  required
                  hint="Auto generates a fresh CA + server + client cert in Terraform and imports both into ACM — no easy-rsa on your laptop, no manual ACM step. Manual is for teams that already have PKI + ACM certs to reuse."
                >
                  <Select options={CERT_MODE_OPTIONS} value={answers.certMode} onValueChange={(v) => setAnswers((a) => ({ ...a, certMode: v as CertMode }))} ariaLabel="Cert mode" />
                </Field>
              )}

              {answers.authMode === "certificate" && answers.certMode === "auto" && (
                <Field
                  label="Certificate owner name"
                  hint={`Used as the Common Name prefix on the CA / server / client certs. Shows in AWS Connection Log's Common Name column (per-session identity). Example: type "vashant" → client cert CN becomes "vashant-client". Leave blank to fall back to the stack name (${answers.name || "…"}).`}
                >
                  <Input
                    value={answers.certOwnerName}
                    onChange={(e) => setAnswers((a) => ({ ...a, certOwnerName: e.target.value }))}
                    className="mono"
                    placeholder={answers.name || "your-name-or-org"}
                  />
                </Field>
              )}

              {answers.authMode === "certificate" && answers.certMode === "auto" && (
                <div
                  className="col gap-2"
                  style={{ padding: 12, borderRadius: 8, background: "var(--info-soft, var(--surface-2))", fontSize: 12.5 }}
                >
                  <span style={{ fontWeight: 600 }}>How it works</span>
                  <span>
                    Terraform's <span className="mono">tls</span> provider generates a self-signed CA + server cert
                    + client cert during apply, then <span className="mono">aws_acm_certificate</span> imports both
                    into ACM in <span className="mono">{answers.region}</span>. After apply, run{" "}
                    <span className="mono">terraform output -raw client_private_key_pem</span> (and{" "}
                    <span className="mono">client_certificate_pem</span> + <span className="mono">ca_certificate_pem</span>)
                    on your laptop to grab the credentials for the .ovpn file. Nothing to install locally.
                  </span>
                  <span className="muted" style={{ fontSize: 11.5 }}>
                    Private keys will be stored in Terraform state — make sure your remote backend is encrypted at rest.
                    CA cert is valid 10 years, server + client certs 1 year (rotate before then).
                  </span>
                </div>
              )}

              {answers.authMode === "certificate" && answers.certMode === "manual" && (
                <>
                  <div
                    className="col gap-2"
                    style={{ padding: 10, borderRadius: 8, background: "var(--surface-2)", fontSize: 12 }}
                  >
                    <span style={{ fontFamily: "var(--font-sans)", fontWeight: 600 }}>Cert generation (run once on your laptop):</span>
                    <pre className="mono" style={{ margin: 0, whiteSpace: "pre-wrap" }}>{`git clone https://github.com/OpenVPN/easy-rsa.git
cd easy-rsa/easyrsa3
./easyrsa init-pki && ./easyrsa build-ca nopass
./easyrsa build-server-full server nopass
./easyrsa build-client-full client1.domain.tld nopass
# Import into ACM (region must match Client VPN region):
aws acm import-certificate --certificate fileb://pki/issued/server.crt \\
  --private-key fileb://pki/private/server.key --certificate-chain fileb://pki/ca.crt \\
  --region ${answers.region}`}</pre>
                  </div>
                  <Field label="Server certificate ARN" required error={errors.serverCertificateArn} hint="From `aws acm list-certificates` in the same region.">
                    <Input value={answers.serverCertificateArn} onChange={(e) => setAnswers((a) => ({ ...a, serverCertificateArn: e.target.value }))} className="mono" placeholder="arn:aws:acm:us-east-1:123456789012:certificate/…" />
                  </Field>
                  <Field label="Client root CA ARN" required error={errors.clientRootCertificateArn} hint="Often the SAME ARN as the server cert if generated from one self-signed CA.">
                    <Input value={answers.clientRootCertificateArn} onChange={(e) => setAnswers((a) => ({ ...a, clientRootCertificateArn: e.target.value }))} className="mono" placeholder="arn:aws:acm:…" />
                  </Field>
                </>
              )}

              {answers.authMode === "federated" && (
                <Field label="SAML provider ARN" required error={errors.samlProviderArn} hint="From IAM > Identity providers.">
                  <Input value={answers.samlProviderArn} onChange={(e) => setAnswers((a) => ({ ...a, samlProviderArn: e.target.value }))} className="mono" placeholder="arn:aws:iam::123456789012:saml-provider/…" />
                </Field>
              )}
            </div>
          )}

          {pageIdx === 3 && (
            <div className="col gap-3">
              {(() => {
                // Compute whether the picked subnets can carry full-tunnel
                // internet traffic — that requires at least one subnet with a
                // real IGW route (NAT alone isn't enough because the VPN
                // endpoint drops the packets without a public IP).
                const pickedWithIgw = answers.subnetIds.filter(
                  (sid) => !!subnets.find((s) => s.subnetId === sid)?.hasIgwRoute,
                );
                const fullTunnelViable = pickedWithIgw.length > 0;
                const wantsFullTunnel = !answers.splitTunnel || answers.allowInternetEgress;
                return (
                  <>
                    <label className="row gap-2" style={{ fontSize: 13, cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={answers.splitTunnel}
                        onChange={(e) => setAnswers((a) => ({ ...a, splitTunnel: e.target.checked }))}
                      />
                      <span>Split tunnel — only VPC traffic goes over the VPN (recommended, cheaper)</span>
                    </label>
                    <label className="row gap-2" style={{ fontSize: 13, cursor: "pointer" }}>
                      <input
                        type="checkbox"
                        checked={answers.allowInternetEgress}
                        onChange={(e) => setAnswers((a) => ({ ...a, allowInternetEgress: e.target.checked }))}
                      />
                      <span>Also allow internet through the VPN (full-tunnel — adds 0.0.0.0/0 auth rule + route)</span>
                    </label>

                    {!fullTunnelViable && wantsFullTunnel && (
                      <div
                        className="col gap-1"
                        style={{ padding: 10, borderRadius: 8, background: "var(--warn-soft)", color: "var(--warn)", fontSize: 12.5 }}
                        role="alert"
                      >
                        <span>
                          <b>None of your picked subnets has a route to an Internet Gateway.</b> Full-tunnel + internet
                          will fail (your laptop's internet will die when you connect — that's what happened last time).
                        </span>
                        <span>
                          Two ways forward: (1) go back to page 2 and pick a public subnet (one that has an IGW route), or
                          (2) turn OFF &quot;Also allow internet through the VPN&quot; and use split-tunnel. VPC access still works
                          in split-tunnel — that&apos;s what most Client VPN setups actually want.
                        </span>
                      </div>
                    )}

                    {fullTunnelViable && !answers.splitTunnel && answers.allowInternetEgress && (
                      <div
                        className="row gap-2"
                        style={{ padding: 10, borderRadius: 8, background: "var(--surface-2)", fontSize: 12 }}
                      >
                        <span className="muted">
                          Full-tunnel enabled. Internet will route through IGW-attached subnet(s):{" "}
                          <span className="mono">{pickedWithIgw.join(", ")}</span>.
                        </span>
                      </div>
                    )}

                    {answers.splitTunnel && answers.allowInternetEgress && (
                      <div
                        className="row gap-2"
                        style={{ padding: 10, borderRadius: 8, background: "var(--warn-soft)", color: "var(--warn)", fontSize: 12.5 }}
                        role="alert"
                      >
                        <span>
                          Split tunnel + full-tunnel internet is contradictory. Turn OFF split tunnel if you want all
                          traffic through the VPN.
                        </span>
                      </div>
                    )}
                  </>
                );
              })()}
            </div>
          )}

          {onReview && (
            <div className="col gap-3">
              <div className="col gap-1" style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}>
                <ReviewRow label="Name" value={answers.name} />
                <ReviewRow label="Region" value={answers.region} />
                <ReviewRow label="Environment" value={envs?.find((e) => e.key === answers.envKey)?.name ?? answers.envKey} />
                <ReviewRow label="Target VPC" value={`${answers.vpcId} (${answers.vpcCidr})`} />
                <ReviewRow label="Subnets" value={answers.subnetIds.join(", ") || "—"} />
                <ReviewRow label="Client CIDR" value={answers.clientCidr} />
                <ReviewRow label="Auth mode" value={answers.authMode} />
                {answers.authMode === "certificate" && <ReviewRow label="Cert mode" value={answers.certMode === "auto" ? "Auto (Terraform generates + imports)" : "Manual (bring your own ACM certs)"} />}
                {answers.authMode === "certificate" && answers.certMode === "auto" && (
                  <ReviewRow
                    label="Cert owner"
                    value={
                      answers.certOwnerName.trim()
                        ? `${answers.certOwnerName.trim()} (CA / server / client CN prefix)`
                        : `${answers.name || "…"} (defaults to stack name)`
                    }
                  />
                )}
                {answers.certMode === "manual" && answers.authMode === "certificate" && (
                  <>
                    <ReviewRow label="Server cert" value={truncateArn(answers.serverCertificateArn)} />
                    <ReviewRow label="Client root CA" value={truncateArn(answers.clientRootCertificateArn)} />
                  </>
                )}
                {answers.authMode === "federated" && <ReviewRow label="SAML provider" value={truncateArn(answers.samlProviderArn)} />}
                <ReviewRow label="Split tunnel" value={answers.splitTunnel ? "yes" : "no"} />
                <ReviewRow label="Internet via VPN" value={answers.allowInternetEgress ? "yes (full-tunnel)" : "no"} />
              </div>
              {serverError && <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">{serverError}</p>}
            </div>
          )}

          <div className="row gap-2" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <Btn variant="ghost" onClick={back} disabled={pageIdx === 0 || submit.isPending}>Back</Btn>
            {onReview ? (
              <Btn variant="primary" icon="plus" loading={submit.isPending} onClick={handleCreate}>Create Client VPN</Btn>
            ) : (
              <Btn variant="primary" onClick={next} disabled={pageHasError}>Next</Btn>
            )}
          </div>
        </div>
      </Block.Body>
    </Block>
  );
}

function ReviewRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="row between" style={{ gap: 12, fontSize: 13 }}>
      <span className="muted">{label}</span>
      <span style={{ fontWeight: 600, textAlign: "right", wordBreak: "break-all" }}>{value}</span>
    </div>
  );
}

function truncateArn(arn: string): string {
  if (arn.length <= 40) return arn;
  return `${arn.slice(0, 22)}…${arn.slice(-14)}`;
}
