"use client";

/**
 * Wizard for issuing a NEW per-user VPN certificate against an EXISTING
 * Client VPN endpoint. Embedded in chat via the ```issue-vpn-user-cert```
 * fence.
 *
 * Flow: pick VPN → type user name → click Issue → zip auto-downloads and
 * the cert is persisted to the DB so it appears in the sidebar Client VPN
 * page's "Issued user certs" list for later re-download / revoke.
 *
 * Wraps the same /aws/client-vpn/[approvalId]/issue-user endpoint the
 * sidebar's per-row "Issue user cert" button uses — no duplicate backend.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Block, Btn, Field, Input, Select, type SelectOption } from "@/components/ui";
import { useClientVpnList } from "@/hooks/queries/network";

type Answers = {
  approvalId: string;
  userName: string;
};

const PAGE_TITLES = ["Pick VPN", "User name", "Review"];

export function IssueVpnUserCertBox({ slug }: { slug: string }) {
  const { data, isLoading, error } = useClientVpnList(slug);
  const vpns = useMemo(
    // Only allow issuing against VPNs that are actually applied — otherwise
    // the CA doesn't exist in state yet + the endpoint would refuse.
    () => (data?.items ?? []).filter((v) => v.status === "approved" && !!v.appliedAt),
    [data?.items],
  );

  const [answers, setAnswers] = useState<Answers>({ approvalId: "", userName: "" });
  const [pageIdx, setPageIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [done, setDone] = useState<{
    userName: string;
    vpnName: string;
    filename: string;
  } | null>(null);

  // Auto-select the newest VPN when the list loads — saves a click.
  useEffect(() => {
    if (answers.approvalId || vpns.length === 0) return;
    setAnswers((a) => ({ ...a, approvalId: vpns[0]!.approvalId }));
  }, [vpns, answers.approvalId]);

  const vpnOptions: SelectOption[] = vpns.map((v) => ({
    value: v.approvalId,
    label: `${v.name}  ·  ${v.envName || v.envKey}  ·  applied ${new Date(v.appliedAt!).toLocaleString()}`,
  }));
  const pickedVpn = vpns.find((v) => v.approvalId === answers.approvalId) ?? null;

  const errors: Partial<Record<keyof Answers, string>> = {};
  if (pageIdx === 0 && !answers.approvalId) errors.approvalId = "Pick a VPN.";
  if (pageIdx === 1) {
    const n = answers.userName.trim();
    if (!n) errors.userName = "Required.";
    else if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(n)) {
      errors.userName = "Letters/digits/. _ - only; must start alphanumeric.";
    } else if (n.length > 60) {
      errors.userName = "60 chars max.";
    }
  }
  const pageHasError = Object.keys(errors).length > 0;
  const onReview = pageIdx === PAGE_TITLES.length - 1;

  async function handleIssue() {
    if (!pickedVpn) return;
    setBusy(true);
    setServerError(null);
    try {
      const res = await fetch(
        `/api/v1/projects/${slug}/aws/client-vpn/${pickedVpn.approvalId}/issue-user`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userName: answers.userName.trim() }),
        },
      );
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(
          (body as { message?: string }).message ?? `Issue failed (${res.status}).`,
        );
      }
      const blob = await res.blob();
      const objUrl = URL.createObjectURL(blob);
      const disp = res.headers.get("Content-Disposition") ?? "";
      const match = disp.match(/filename="([^"]+)"/);
      const filename = match?.[1] ?? `${answers.userName.trim()}-${pickedVpn.name}.zip`;
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
      setDone({
        userName: answers.userName.trim(),
        vpnName: pickedVpn.name,
        filename,
      });
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "Issue failed.");
    } finally {
      setBusy(false);
    }
  }

  // ── Empty / loading / error states for the VPN list ────────────────────

  if (isLoading) {
    return (
      <Block>
        <Block.Body>
          <span className="muted" style={{ fontSize: 13 }}>Loading your Client VPNs…</span>
        </Block.Body>
      </Block>
    );
  }
  if (error) {
    return (
      <Block>
        <Block.Body>
          <p style={{ fontSize: 13, color: "var(--danger)" }}>
            Failed to load Client VPN list. {error instanceof Error ? error.message : "Unknown error."}
          </p>
        </Block.Body>
      </Block>
    );
  }
  if (vpns.length === 0) {
    return (
      <Block>
        <Block.Header>
          <Block.Title sub="No Client VPN endpoints found in this project.">
            Issue user cert
          </Block.Title>
        </Block.Header>
        <Block.Body>
          <div className="col gap-2">
            <p style={{ fontSize: 13 }}>
              You need an applied Client VPN before you can issue user certs against it.
              Say <span className="mono">create client vpn</span> to launch one, then come back.
            </p>
            <div>
              <Link href={`/p/${slug}/client-vpn`}>
                <Btn variant="ghost">Open Client VPN page</Btn>
              </Link>
            </div>
          </div>
        </Block.Body>
      </Block>
    );
  }

  // ── Success state — cert downloaded, offer to issue another ────────────

  if (done) {
    return (
      <Block>
        <Block.Header>
          <Block.Title sub={`Downloaded ${done.filename}`}>
            Cert issued for {done.userName}
          </Block.Title>
        </Block.Header>
        <Block.Body>
          <div className="col gap-3">
            <p style={{ fontSize: 13 }}>
              A zip with <span className="mono">{done.userName}.ovpn</span> + cert + key + ca was downloaded to your browser.
              Give the .ovpn file to <span className="mono">{done.userName}</span> — they import it into AWS VPN Client / Tunnelblick and connect.
            </p>
            <p className="muted" style={{ fontSize: 12.5 }}>
              The cert is also saved in the app — see the <b>Issued user certs</b> section on the{" "}
              <Link href={`/p/${slug}/client-vpn`} style={{ color: "var(--accent, #5b8cff)" }}>Client VPN page</Link>{" "}
              to re-download or revoke later. AWS Connection Log will show <span className="mono">{done.userName}</span>{" "}
              as the Common Name for their sessions.
            </p>
            <div className="row gap-2" style={{ justifyContent: "flex-end" }}>
              <Btn
                variant="ghost"
                onClick={() => {
                  setDone(null);
                  setAnswers((a) => ({ ...a, userName: "" }));
                  setPageIdx(1);
                }}
              >
                Issue another for this VPN
              </Btn>
              <Btn
                variant="primary"
                onClick={() => {
                  setDone(null);
                  setAnswers({ approvalId: vpns[0]?.approvalId ?? "", userName: "" });
                  setPageIdx(0);
                }}
              >
                Issue for a different VPN
              </Btn>
            </div>
          </div>
        </Block.Body>
      </Block>
    );
  }

  // ── Wizard body ────────────────────────────────────────────────────────

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Mint a new per-user cert against an existing Client VPN endpoint. Each cert has a distinct CN so AWS Connection Log attributes sessions correctly.">
          Issue VPN user cert
        </Block.Title>
      </Block.Header>
      <Block.Body>
        <div className="col gap-4" style={{ maxWidth: 620 }}>
          <div className="row gap-2" style={{ alignItems: "center" }}>
            {PAGE_TITLES.map((_, i) => (
              <span
                key={i}
                style={{
                  flex: 1,
                  height: 4,
                  borderRadius: 2,
                  background: i <= pageIdx ? "var(--accent, #5b8cff)" : "var(--surface-3, #00000018)",
                }}
              />
            ))}
          </div>
          <span className="muted" style={{ fontSize: 12.5, fontWeight: 600 }}>
            Step {pageIdx + 1} of {PAGE_TITLES.length} · {PAGE_TITLES[pageIdx]}
          </span>

          {pageIdx === 0 && (
            <Field
              label="Which Client VPN?"
              required
              error={errors.approvalId}
              hint={`${vpns.length} applied endpoint${vpns.length === 1 ? "" : "s"} in this project. Cert will be signed by this VPN's CA.`}
            >
              <Select
                options={vpnOptions}
                value={answers.approvalId}
                onValueChange={(v) => setAnswers((a) => ({ ...a, approvalId: v }))}
                ariaLabel="Client VPN"
                placeholder="Pick a VPN…"
              />
            </Field>
          )}

          {pageIdx === 1 && (
            <div className="col gap-3">
              <Field
                label="User name (becomes the cert Common Name)"
                required
                error={errors.userName}
                hint="Letters/digits/. _ - only. Example: alice, bob, vashant. Shows in AWS Connection Log per session."
              >
                <Input
                  value={answers.userName}
                  onChange={(e) => setAnswers((a) => ({ ...a, userName: e.target.value }))}
                  className="mono"
                  placeholder="alice"
                  autoFocus
                />
              </Field>
            </div>
          )}

          {onReview && pickedVpn && (
            <div className="col gap-3">
              <div
                className="col gap-1"
                style={{ border: "1px solid var(--border)", borderRadius: 8, padding: 12 }}
              >
                <ReviewRow label="Client VPN" value={pickedVpn.name} />
                <ReviewRow label="Environment" value={pickedVpn.envName || pickedVpn.envKey} />
                <ReviewRow label="User name (CN)" value={answers.userName.trim()} />
                <ReviewRow label="After download" value="Cert also saved in app for re-download / revoke" />
              </div>
              {serverError && (
                <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">
                  {serverError}
                </p>
              )}
            </div>
          )}

          <div className="row gap-2" style={{ justifyContent: "space-between", alignItems: "center" }}>
            <Btn
              variant="ghost"
              onClick={() => setPageIdx((i) => Math.max(0, i - 1))}
              disabled={pageIdx === 0 || busy}
            >
              Back
            </Btn>
            {onReview ? (
              <Btn variant="primary" icon="download" loading={busy} onClick={handleIssue}>
                Issue + download
              </Btn>
            ) : (
              <Btn
                variant="primary"
                onClick={() =>
                  !pageHasError && setPageIdx((i) => Math.min(PAGE_TITLES.length - 1, i + 1))
                }
                disabled={pageHasError}
              >
                Next
              </Btn>
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
