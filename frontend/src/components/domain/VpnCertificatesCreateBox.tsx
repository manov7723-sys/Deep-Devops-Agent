"use client";

/**
 * Unified VPN certificate wizard, embedded in chat via the
 * ```vpn-certificates-create``` fence.
 *
 * Flow:
 *   1. Pick an EXISTING Client VPN endpoint (dropdown)
 *   2. Add one or more team members (dynamic list)
 *   3. Review + Issue → downloads a single zip containing per-user certs +
 *      per-user self-contained .ovpn files, plus the shared CA cert
 *
 * Each cert is minted server-side against the VPN's CA (read from Terraform
 * state), persisted to the DB (encrypted), and surfaced in the sidebar
 * page's "Issued user certs" list for later re-download / revoke.
 *
 * Wraps the batch endpoint /aws/client-vpn/[approvalId]/issue-users-batch
 * so multiple users can be issued in one shot without N separate calls.
 */
import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Block, Btn, Field, Input, Select, type SelectOption } from "@/components/ui";
import { useClientVpnList } from "@/hooks/queries/network";

type Answers = {
  approvalId: string;
  userNames: string[];
};

const PAGE_TITLES = ["Pick VPN", "Team members", "Review"];

const USER_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function VpnCertificatesCreateBox({ slug }: { slug: string }) {
  const { data, isLoading, error } = useClientVpnList(slug);
  const vpns = useMemo(
    () => (data?.items ?? []).filter((v) => v.status === "approved" && !!v.appliedAt),
    [data?.items],
  );

  const [answers, setAnswers] = useState<Answers>({ approvalId: "", userNames: [""] });
  const [pageIdx, setPageIdx] = useState(0);
  const [busy, setBusy] = useState(false);
  const [serverError, setServerError] = useState<string | null>(null);
  const [done, setDone] = useState<{
    filename: string;
    userNames: string[];
    vpnName: string;
  } | null>(null);

  useEffect(() => {
    if (answers.approvalId || vpns.length === 0) return;
    setAnswers((a) => ({ ...a, approvalId: vpns[0]!.approvalId }));
  }, [vpns, answers.approvalId]);

  const vpnOptions: SelectOption[] = vpns.map((v) => ({
    value: v.approvalId,
    label: `${v.name}  ·  ${v.envName || v.envKey}  ·  applied ${new Date(v.appliedAt!).toLocaleString()}`,
  }));
  const pickedVpn = vpns.find((v) => v.approvalId === answers.approvalId) ?? null;

  // ── Validation ──
  const trimmedUsers = answers.userNames.map((n) => n.trim()).filter(Boolean);
  const namesPerRowError: (string | undefined)[] = answers.userNames.map((n) => {
    const t = n.trim();
    if (!t) return undefined; // blank rows are ignored, not errored
    if (t.length > 60) return "Max 60 chars.";
    if (!USER_NAME_RE.test(t)) return "Letters/digits/. _ - only; starts alphanumeric.";
    return undefined;
  });
  const duplicates = new Set<string>();
  const seen = new Set<string>();
  for (const n of trimmedUsers) {
    if (seen.has(n)) duplicates.add(n);
    seen.add(n);
  }

  const errors: Record<string, string> = {};
  if (pageIdx === 0 && !answers.approvalId) errors.approvalId = "Pick a VPN.";
  if (pageIdx === 1) {
    if (trimmedUsers.length === 0) errors.userNames = "Add at least one user name.";
    if (duplicates.size > 0) errors.userNames = `Duplicate name(s): ${[...duplicates].join(", ")}.`;
    if (namesPerRowError.some((e) => !!e)) errors.userNames = "Fix invalid user names above.";
  }
  const pageHasError = Object.keys(errors).length > 0;
  const onReview = pageIdx === PAGE_TITLES.length - 1;

  function updateName(idx: number, value: string) {
    setAnswers((a) => {
      const next = [...a.userNames];
      next[idx] = value;
      return { ...a, userNames: next };
    });
  }
  function addRow() {
    setAnswers((a) => ({ ...a, userNames: [...a.userNames, ""] }));
  }
  function removeRow(idx: number) {
    setAnswers((a) => {
      const next = a.userNames.filter((_, i) => i !== idx);
      return { ...a, userNames: next.length ? next : [""] };
    });
  }

  async function handleIssue() {
    if (!pickedVpn) return;
    setBusy(true);
    setServerError(null);
    try {
      const res = await fetch(
        `/api/v1/projects/${slug}/aws/client-vpn/${pickedVpn.approvalId}/issue-users-batch`,
        {
          method: "POST",
          credentials: "include",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ userNames: trimmedUsers }),
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
      const filename = match?.[1] ?? `vpn-users-${pickedVpn.name}.zip`;
      const a = document.createElement("a");
      a.href = objUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(objUrl);
      setDone({ filename, userNames: trimmedUsers, vpnName: pickedVpn.name });
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "Issue failed.");
    } finally {
      setBusy(false);
    }
  }

  // ── Empty / loading / error states ──

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
          <Block.Title sub="No applied Client VPN endpoints in this project.">
            Create VPN user certificates
          </Block.Title>
        </Block.Header>
        <Block.Body>
          <div className="col gap-2">
            <p style={{ fontSize: 13 }}>
              You need an applied Client VPN before you can create user certs against it. In chat, say{" "}
              <span className="mono">create client vpn</span> to launch one, then come back here.
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

  // ── Success ──

  if (done) {
    return (
      <Block>
        <Block.Header>
          <Block.Title sub={`Downloaded ${done.filename}`}>
            {done.userNames.length} cert{done.userNames.length === 1 ? "" : "s"} issued for {done.vpnName}
          </Block.Title>
        </Block.Header>
        <Block.Body>
          <div className="col gap-3">
            <p style={{ fontSize: 13 }}>
              The zip contains one folder per user, each with their own{" "}
              <span className="mono">.ovpn</span> file (self-contained — cert, key, and CA already
              embedded). Distribute per-user:
            </p>
            <ul style={{ fontSize: 12.5, paddingLeft: 20, margin: 0 }}>
              {done.userNames.map((u) => (
                <li key={u}>
                  <span className="mono">users/{u}/{u}.ovpn</span> → hand this to <b>{u}</b>
                </li>
              ))}
            </ul>
            <p className="muted" style={{ fontSize: 12.5 }}>
              Every cert is also saved in the app — see the <b>Issued user certs</b> section on the{" "}
              <Link href={`/p/${slug}/client-vpn`} style={{ color: "var(--accent, #5b8cff)" }}>
                Client VPN page
              </Link>{" "}
              for re-download or per-user revocation.
            </p>
            <div className="row gap-2" style={{ justifyContent: "flex-end" }}>
              <Btn
                variant="ghost"
                onClick={() => {
                  setDone(null);
                  setAnswers((a) => ({ ...a, userNames: [""] }));
                  setPageIdx(1);
                }}
              >
                Issue more for this VPN
              </Btn>
              <Btn
                variant="primary"
                onClick={() => {
                  setDone(null);
                  setAnswers({ approvalId: vpns[0]?.approvalId ?? "", userNames: [""] });
                  setPageIdx(0);
                }}
              >
                Different VPN
              </Btn>
            </div>
          </div>
        </Block.Body>
      </Block>
    );
  }

  // ── Wizard body ──

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Mint per-user client certs against an existing Client VPN. Each cert has a distinct CN so AWS Connection Log attributes sessions correctly.">
          Create VPN user certificates
        </Block.Title>
      </Block.Header>
      <Block.Body>
        <div className="col gap-4" style={{ maxWidth: 640 }}>
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
              hint={`${vpns.length} applied endpoint${vpns.length === 1 ? "" : "s"} in this project. Certs will be signed by this VPN's CA and paired with its .ovpn config.`}
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
              <div style={{ fontWeight: 600, fontSize: 13 }}>Team members (1–50)</div>
              <div className="muted" style={{ fontSize: 12 }}>
                One row per user. Each name becomes the cert&apos;s Common Name and shows in AWS
                Connection Log for their sessions. Letters/digits/. _ - only.
              </div>
              <div className="col gap-2">
                {answers.userNames.map((name, i) => (
                  <div key={i} className="row gap-2" style={{ alignItems: "flex-start" }}>
                    <div style={{ flex: 1 }}>
                      <Field
                        label={`User ${i + 1}`}
                        error={namesPerRowError[i]}
                      >
                        <Input
                          value={name}
                          onChange={(e) => updateName(i, e.target.value)}
                          className="mono"
                          placeholder="alice"
                        />
                      </Field>
                    </div>
                    <Btn
                      variant="ghost"
                      icon="x"
                      onClick={() => removeRow(i)}
                      disabled={answers.userNames.length === 1}
                      style={{ marginTop: 22 }}
                    >
                      Remove
                    </Btn>
                  </div>
                ))}
              </div>
              <div className="row gap-2">
                <Btn variant="ghost" icon="plus" onClick={addRow} disabled={answers.userNames.length >= 50}>
                  Add another user
                </Btn>
              </div>
              {errors.userNames && (
                <p style={{ fontSize: 12.5, color: "var(--danger)" }}>{errors.userNames}</p>
              )}
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
                <ReviewRow label="Users to issue" value={String(trimmedUsers.length)} />
                <ReviewRow label="Common Names" value={trimmedUsers.join(", ")} />
                <ReviewRow label="After download" value="All certs also saved in app for re-download / revoke" />
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
                Issue {trimmedUsers.length} cert{trimmedUsers.length === 1 ? "" : "s"} + download
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
