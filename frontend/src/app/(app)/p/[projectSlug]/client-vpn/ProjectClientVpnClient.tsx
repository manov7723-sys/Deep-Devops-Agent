"use client";

import { useState } from "react";
import Link from "next/link";
import { Badge, Block, Btn, Field, Input, PageHead } from "@/components/ui";
import {
  useClientVpnList,
  useVpnCertificatesList,
  useVpnUserCerts,
  useRevokeVpnUserCert,
  useAzureVpnList,
  type ClientVpnItem,
  type VpnCertificateSetItem,
  type VpnUserCertItem,
  type AzureVpnItem,
} from "@/hooks/queries/network";
import { useQueryClient } from "@tanstack/react-query";

/**
 * Client VPN — sidebar-native list of every AWS Client VPN this project has
 * created, with a Download button per row. The download triggers the server
 * to run `terraform output -json` against the stack's remote state, pull the
 * client + server + CA PEMs, and stream back a zip with client.ovpn ready to
 * import into AWS VPN Client / Tunnelblick / OpenVPN.
 *
 * We deliberately don't render creds inline anywhere — the private key never
 * appears in the UI, only in the zip the user downloads once.
 */
export function ProjectClientVpnClient({ slug }: { slug: string }) {
  const { data, isLoading, error } = useClientVpnList(slug);
  const items = data?.items ?? [];
  const certsQuery = useVpnCertificatesList(slug);
  const certSets = certsQuery.data?.items ?? [];
  const azureVpnQuery = useAzureVpnList(slug);
  const azureVpns = azureVpnQuery.data?.items ?? [];

  return (
    <div className="col gap-5">
      <PageHead
        title="Client VPN"
        sub="Laptop-to-VPC OpenVPN endpoints + standalone certificate sets. Download the .ovpn or per-user cert bundle from here."
      />

      {/* ── VPN Certificate Sets panel (standalone PKI, reusable across endpoints) ── */}
      <div className="col gap-2">
        <div className="row between" style={{ alignItems: "center" }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>VPN certificate sets</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            Standalone PKI — create once, reference from Client VPN Manual cert mode.
          </span>
        </div>
        {certsQuery.isLoading && (
          <Block><Block.Body><span className="muted" style={{ fontSize: 13 }}>Loading cert sets…</span></Block.Body></Block>
        )}
        {certsQuery.error && (
          <Block>
            <Block.Body>
              <p style={{ fontSize: 13, color: "var(--danger)" }}>
                Failed to load VPN certificate sets. {certsQuery.error instanceof Error ? certsQuery.error.message : "Unknown error."}
              </p>
            </Block.Body>
          </Block>
        )}
        {!certsQuery.isLoading && !certsQuery.error && certSets.length === 0 && (
          <Block>
            <Block.Body>
              <div className="col gap-2">
                <p style={{ fontSize: 13 }}>
                  No VPN certificate sets yet. In chat, say{" "}
                  <span className="mono">create vpn certificates</span> to provision a CA + server + per-user client certs.
                </p>
              </div>
            </Block.Body>
          </Block>
        )}
        {certSets.map((cs) => (
          <VpnCertSetRow key={cs.approvalId} slug={slug} item={cs} />
        ))}
      </div>

      {/* ── Azure OpenVPN endpoints panel (self-hosted on Compute) ── */}
      <div className="col gap-2">
        <div className="row between" style={{ alignItems: "center" }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Azure OpenVPN endpoints</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            Self-hosted on a small Azure VM. Download the .ovpn (cert + key + CA embedded) to connect.
          </span>
        </div>
        {azureVpnQuery.isLoading && (
          <Block><Block.Body><span className="muted" style={{ fontSize: 13 }}>Loading Azure VPN endpoints…</span></Block.Body></Block>
        )}
        {azureVpnQuery.error && (
          <Block>
            <Block.Body>
              <p style={{ fontSize: 13, color: "var(--danger)" }}>
                Failed to load Azure VPN list. {azureVpnQuery.error instanceof Error ? azureVpnQuery.error.message : "Unknown error."}
              </p>
            </Block.Body>
          </Block>
        )}
        {!azureVpnQuery.isLoading && !azureVpnQuery.error && azureVpns.length === 0 && (
          <Block>
            <Block.Body>
              <p className="muted" style={{ fontSize: 12.5 }}>
                No Azure VPN endpoints yet. In chat, say <span className="mono">create azure vpn</span> to launch one (~$13/mo).
              </p>
            </Block.Body>
          </Block>
        )}
        {azureVpns.map((item) => (
          <AzureVpnRow key={item.approvalId} slug={slug} item={item} />
        ))}
      </div>

      {/* ── Client VPN endpoints panel ── */}
      <div className="col gap-2">
        <div className="row between" style={{ alignItems: "center" }}>
          <h3 style={{ fontSize: 14, fontWeight: 700, margin: 0 }}>Client VPN endpoints</h3>
          <span className="muted" style={{ fontSize: 12 }}>
            Download the .ovpn to connect from your laptop.
          </span>
        </div>
        {isLoading && <Block><Block.Body><span className="muted" style={{ fontSize: 13 }}>Loading Client VPN endpoints…</span></Block.Body></Block>}

        {error && (
          <Block>
            <Block.Body>
              <p style={{ fontSize: 13, color: "var(--danger)" }}>
                Failed to load Client VPN list. {error instanceof Error ? error.message : "Unknown error."}
              </p>
            </Block.Body>
          </Block>
        )}

        {!isLoading && !error && items.length === 0 && (
          <Block>
            <Block.Body>
              <div className="col gap-2">
                <p style={{ fontSize: 13, fontWeight: 600 }}>No Client VPNs yet.</p>
                <p className="muted" style={{ fontSize: 12.5 }}>
                  Head to the chat and say <span className="mono">create client vpn</span> to launch one.
                </p>
                <div>
                  <Link href={`/p/${slug}/chat`}>
                    <Btn variant="primary" icon="chat">Open chat</Btn>
                  </Link>
                </div>
              </div>
            </Block.Body>
          </Block>
        )}

        {items.map((item) => (
          <ClientVpnRow key={item.approvalId} slug={slug} item={item} />
        ))}
      </div>
    </div>
  );
}

// One row per VPN certificate set — Download button pulls a zip with ca.crt,
// server-arn.txt, client-ca-arn.txt, and per-user cert+key pairs.
function VpnCertSetRow({ slug, item }: { slug: string; item: VpnCertificateSetItem }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const applied = item.status === "approved" && !!item.appliedAt;

  async function download() {
    setBusy(true);
    setErr(null);
    try {
      const url = `/api/v1/projects/${slug}/aws/vpn-certificates/${item.approvalId}/download`;
      const res = await fetch(url, { credentials: "include" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message ?? `Download failed (${res.status}).`);
      }
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objUrl;
      const disp = res.headers.get("Content-Disposition") ?? "";
      const match = disp.match(/filename="([^"]+)"/);
      a.download = match?.[1] ?? `vpn-certs-${item.name}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Download failed.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Block>
      <Block.Header>
        <Block.Title sub={item.title}>{item.name}</Block.Title>
      </Block.Header>
      <Block.Body>
        <div className="col gap-3">
          <div className="row gap-2 wrap" style={{ fontSize: 12.5 }}>
            <Badge tone={applied ? "ok" : item.status === "rejected" ? "danger" : "warn"}>
              {applied ? "applied" : item.status}
            </Badge>
            {item.envName && <Badge tone="info">{item.envName}</Badge>}
            <span className="muted">
              Created {new Date(item.requestedAt).toLocaleString()}
              {item.appliedAt ? ` · Applied ${new Date(item.appliedAt).toLocaleString()}` : ""}
            </span>
          </div>
          {err && (
            <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">
              {err}
            </p>
          )}
          <div className="row gap-2" style={{ justifyContent: "flex-end" }}>
            {!applied && (
              <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>
                Approve + apply this cert set before you can download.
              </span>
            )}
            <Btn
              variant="primary"
              icon="download"
              loading={busy}
              disabled={!applied || busy}
              onClick={download}
            >
              Download cert bundle
            </Btn>
          </div>
        </div>
      </Block.Body>
    </Block>
  );
}

function ClientVpnRow({ slug, item }: { slug: string; item: ClientVpnItem }) {
  const [busy, setBusy] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [showIssue, setShowIssue] = useState(false);
  const [userName, setUserName] = useState("");
  const applied = item.status === "approved" && !!item.appliedAt;
  const qc = useQueryClient();
  const userCertsQuery = useVpnUserCerts(slug, applied ? item.approvalId : null);
  const userCerts = userCertsQuery.data?.items ?? [];
  const revoke = useRevokeVpnUserCert(slug, item.approvalId);

  async function downloadZip(url: string, defaultFilename: string) {
    const res = await fetch(url, { credentials: "include", method: "GET" });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      throw new Error((body as { message?: string }).message ?? `Download failed (${res.status}).`);
    }
    const blob = await res.blob();
    const objUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objUrl;
    const disp = res.headers.get("Content-Disposition") ?? "";
    const match = disp.match(/filename="([^"]+)"/);
    a.download = match?.[1] ?? defaultFilename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objUrl);
  }

  async function download() {
    setBusy(true);
    setErr(null);
    try {
      await downloadZip(
        `/api/v1/projects/${slug}/aws/client-vpn/${item.approvalId}/download`,
        `client-vpn-${item.name}.zip`,
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Download failed.");
    } finally {
      setBusy(false);
    }
  }

  async function issueUserCert() {
    const cn = userName.trim();
    if (!cn) {
      setErr("Enter a user name first.");
      return;
    }
    setIssuing(true);
    setErr(null);
    try {
      // POST to the issue-user endpoint. Server streams a zip; we save it
      // with the same flow as the main download.
      const res = await fetch(
        `/api/v1/projects/${slug}/aws/client-vpn/${item.approvalId}/issue-user`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userName: cn }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error((body as { message?: string }).message ?? `Issue failed (${res.status}).`);
      }
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objUrl;
      const disp = res.headers.get("Content-Disposition") ?? "";
      const match = disp.match(/filename="([^"]+)"/);
      a.download = match?.[1] ?? `${cn}-${item.name}.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
      setUserName("");
      setShowIssue(false);
      // Refresh the issued-certs list so the newly-minted cert shows up.
      qc.invalidateQueries({ queryKey: ["p", slug, "vpn-user-certs", item.approvalId] });
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Issue failed.");
    } finally {
      setIssuing(false);
    }
  }

  async function redownloadUserCert(certId: string, userName: string) {
    try {
      await downloadZip(
        `/api/v1/projects/${slug}/aws/client-vpn/${item.approvalId}/user-certs/${certId}`,
        `${userName}.zip`,
      );
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Download failed.");
    }
  }

  async function revokeCert(certId: string, userName: string) {
    if (!window.confirm(
      `Revoke ${userName}'s cert?\n\n` +
      `This marks it revoked in the app so it won't show as 'active'. ` +
      `To ACTUALLY block VPN access, you'll need to add the cert's serial to ` +
      `the endpoint's Client Certificate Revocation List in AWS Console.`,
    )) return;
    try {
      await revoke.mutateAsync(certId);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Revoke failed.");
    }
  }

  return (
    <Block>
      <Block.Header>
        <Block.Title sub={item.title}>{item.name}</Block.Title>
      </Block.Header>
      <Block.Body>
        <div className="col gap-3">
          <div className="row gap-2 wrap" style={{ fontSize: 12.5 }}>
            <Badge tone={applied ? "ok" : item.status === "rejected" ? "danger" : "warn"}>
              {applied ? "applied" : item.status}
            </Badge>
            {item.envName && <Badge tone="info">{item.envName}</Badge>}
            <span className="muted">
              Created {new Date(item.requestedAt).toLocaleString()}
              {item.appliedAt ? ` · Applied ${new Date(item.appliedAt).toLocaleString()}` : ""}
            </span>
          </div>

          {err && (
            <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">
              {err}
            </p>
          )}

          {applied && userCerts.length > 0 && (
            <div className="col gap-1" style={{ padding: 10, borderRadius: 8, background: "var(--surface-2)" }}>
              <div className="row between" style={{ alignItems: "center" }}>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>
                  Issued user certs ({userCerts.filter((c) => !c.revokedAt).length} active)
                </span>
                <span className="muted" style={{ fontSize: 11.5 }}>
                  Re-download or revoke any time.
                </span>
              </div>
              <div className="col" style={{ marginTop: 4 }}>
                {userCerts.map((c) => (
                  <UserCertRow
                    key={c.id}
                    cert={c}
                    onDownload={() => redownloadUserCert(c.id, c.userName)}
                    onRevoke={() => revokeCert(c.id, c.userName)}
                    revoking={revoke.isPending}
                  />
                ))}
              </div>
            </div>
          )}

          {applied && userCertsQuery.isLoading && (
            <span className="muted" style={{ fontSize: 12 }}>Loading issued certs…</span>
          )}

          {showIssue && applied && (
            <div
              className="col gap-2"
              style={{ padding: 12, borderRadius: 8, background: "var(--surface-2)" }}
            >
              <span style={{ fontSize: 12.5, fontWeight: 600 }}>Issue a new per-user cert</span>
              <span className="muted" style={{ fontSize: 12 }}>
                Enter the user&apos;s name — becomes the cert&apos;s Common Name, shows in
                AWS Connection Log per session. Returns a self-contained{" "}
                <span className="mono">.ovpn</span> ready to import.
              </span>
              <Field
                label="User name (CN)"
                hint="Letters/digits/. _ - only. Example: alice, bob, vashant"
              >
                <Input
                  value={userName}
                  onChange={(e) => setUserName(e.target.value)}
                  className="mono"
                  placeholder="alice"
                  autoFocus
                />
              </Field>
              <div className="row gap-2" style={{ justifyContent: "flex-end" }}>
                <Btn
                  variant="ghost"
                  onClick={() => {
                    setShowIssue(false);
                    setUserName("");
                    setErr(null);
                  }}
                  disabled={issuing}
                >
                  Cancel
                </Btn>
                <Btn
                  variant="primary"
                  icon="download"
                  loading={issuing}
                  disabled={issuing || !userName.trim()}
                  onClick={issueUserCert}
                >
                  Issue + download
                </Btn>
              </div>
            </div>
          )}

          <div className="row gap-2" style={{ justifyContent: "flex-end" }}>
            {!applied && (
              <span className="muted" style={{ fontSize: 12, alignSelf: "center" }}>
                Approve + apply this stack before you can download or issue user certs.
              </span>
            )}
            {applied && !showIssue && (
              <Btn variant="ghost" icon="user" onClick={() => setShowIssue(true)}>
                Issue user cert
              </Btn>
            )}
            <Btn
              variant="primary"
              icon="download"
              loading={busy}
              disabled={!applied || busy}
              onClick={download}
            >
              Download bootstrap .ovpn
            </Btn>
          </div>
        </div>
      </Block.Body>
    </Block>
  );
}

function UserCertRow({
  cert,
  onDownload,
  onRevoke,
  revoking,
}: {
  cert: VpnUserCertItem;
  onDownload: () => void;
  onRevoke: () => void;
  revoking: boolean;
}) {
  const revoked = !!cert.revokedAt;
  return (
    <div
      className="row gap-2"
      style={{
        alignItems: "center",
        padding: "6px 4px",
        borderTop: "1px solid var(--border)",
        fontSize: 12.5,
      }}
    >
      <span className="mono" style={{ fontWeight: 600 }}>{cert.userName}</span>
      <Badge tone={revoked ? "danger" : "ok"}>
        {revoked ? "revoked" : "active"}
      </Badge>
      <span className="muted" style={{ fontSize: 11.5 }}>
        Issued {new Date(cert.issuedAt).toLocaleString()}
        {revoked && cert.revokedAt ? ` · Revoked ${new Date(cert.revokedAt).toLocaleString()}` : ""}
        {" · serial "}
        <span className="mono" title="Cert serial (paste into AWS CRL to revoke for real)">
          {cert.serial.slice(0, 12)}…
        </span>
      </span>
      <div className="row gap-1" style={{ marginLeft: "auto" }}>
        <Btn variant="ghost" icon="download" onClick={onDownload}>
          Re-download
        </Btn>
        {!revoked && (
          <Btn
            variant="ghost"
            icon="x"
            onClick={onRevoke}
            disabled={revoking}
            loading={revoking}
          >
            Revoke
          </Btn>
        )}
      </div>
    </div>
  );
}

// Azure OpenVPN row — Download button hits /azure/vpn/[approvalId]/initial-cert
// which pulls the auto-generated client cert + CA from Terraform state,
// assembles a self-contained .ovpn (endpoint IP + port + PEMs embedded),
// persists to VpnUserCert for re-download, and streams a zip.
function AzureVpnRow({ slug, item }: { slug: string; item: AzureVpnItem }) {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sshBusy, setSshBusy] = useState(false);
  const [sshErr, setSshErr] = useState<string | null>(null);
  const applied = item.status === "approved" && !!item.appliedAt;

  async function downloadFile(url: string, filename: string) {
    const res = await fetch(url, { method: "POST", credentials: "include", cache: "no-store" });
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(body.message ?? `Download failed (${res.status}).`);
    }
    const blob = await res.blob();
    const objectUrl = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = objectUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(objectUrl);
  }

  async function downloadOvpn() {
    setBusy(true);
    setErr(null);
    try {
      await downloadFile(`/api/v1/projects/${slug}/azure/vpn/${item.approvalId}/initial-cert`, `azure-vpn-${item.name}-initial.zip`);
    } catch (e) {
      setErr(e instanceof Error ? e.message : "Download failed.");
    } finally {
      setBusy(false);
    }
  }

  // GET (not POST) — the endpoint hands back the stored encrypted key. Works
  // regardless of apply state since the key was generated at wizard submit
  // and stashed on the approval BEFORE terraform apply ran.
  async function downloadSshKey() {
    setSshBusy(true);
    setSshErr(null);
    try {
      const res = await fetch(`/api/v1/projects/${slug}/azure/vpn/${item.approvalId}/admin-ssh-key`, {
        credentials: "include",
        cache: "no-store",
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => ({}))) as { message?: string };
        throw new Error(body.message ?? `Download failed (${res.status}).`);
      }
      const blob = await res.blob();
      const objectUrl = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = objectUrl;
      a.download = `azure-vpn-${item.name}-admin-ssh.zip`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objectUrl);
    } catch (e) {
      setSshErr(e instanceof Error ? e.message : "Download failed.");
    } finally {
      setSshBusy(false);
    }
  }

  return (
    <Block>
      <Block.Body>
        <div className="row between" style={{ alignItems: "center", gap: 12 }}>
          <div className="col gap-1" style={{ minWidth: 0, flex: 1 }}>
            <div className="row gap-2" style={{ alignItems: "center" }}>
              <span className="mono" style={{ fontWeight: 600, fontSize: 14 }}>{item.name}</span>
              <Badge tone={applied ? "ok" : item.status === "approved" ? "info" : "warn"}>
                {applied ? "applied" : item.status}
              </Badge>
              <span className="muted" style={{ fontSize: 12 }}>env: {item.envName || item.envKey}</span>
            </div>
            <span className="muted" style={{ fontSize: 12 }}>{item.title}</span>
            {err && <span style={{ fontSize: 12, color: "var(--danger)" }} role="alert">{err}</span>}
            {sshErr && <span style={{ fontSize: 12, color: "var(--danger)" }} role="alert">{sshErr}</span>}
          </div>
          <div className="row gap-2" style={{ alignItems: "center" }}>
            <Btn variant="ghost" icon="key" onClick={downloadSshKey} loading={sshBusy} title="Download admin SSH key for VM access">
              SSH key
            </Btn>
            <Btn variant="primary" icon="download" onClick={downloadOvpn} loading={busy} disabled={!applied}>
              {applied ? "Download .ovpn" : "Not yet applied"}
            </Btn>
          </div>
        </div>
      </Block.Body>
    </Block>
  );
}
