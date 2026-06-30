"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import Link from "next/link";
import type { Route } from "next";
import { Badge, Btn, Icon, type BadgeTone } from "@/components/ui";
import { AlertCard } from "./AlertCard";
import { api, apiErrorMessage } from "@/lib/api/client";
import type { SeedAlert } from "@/lib/legacy-types";

type RemediationStep = { action: string; command?: string; risk: "low" | "medium" | "high"; needsApproval: boolean };
type Diagnosis = {
  summary: string;
  rootCause: string;
  evidence: string[];
  remediation: RemediationStep[];
  confidence: "low" | "medium" | "high";
};
type TriageResp = { ok: boolean; diagnosis: Diagnosis; toolsUsed: string[]; approvalsCreated: number };

const RISK_TONE: Record<RemediationStep["risk"], BadgeTone> = { low: "info", medium: "warn", high: "danger" };
const CONF_TONE: Record<Diagnosis["confidence"], BadgeTone> = { low: "warn", medium: "info", high: "ok" };

/**
 * Wraps an AlertCard with the SRE agent's "Investigate with AI" action: it calls
 * the triage route, then renders the agent's diagnosis (root cause, evidence,
 * proposed fixes) and how many fixes it queued for approval.
 */
export function AlertInvestigation({
  slug,
  alert,
  onAck,
  onResolve,
  onAsk,
}: {
  slug: string;
  alert: SeedAlert;
  onAck?: (id: string) => void;
  onResolve?: (id: string) => void;
  onAsk?: (id: string) => void;
}) {
  const [err, setErr] = useState<string | null>(null);
  const triage = useMutation({
    mutationFn: () => api.post<TriageResp>(`/projects/${slug}/alerts/${alert.id}/triage`, {}),
    onMutate: () => setErr(null),
    onError: (e) => setErr(apiErrorMessage(e)),
  });
  // The agent may have auto-investigated this alert on arrival — show that
  // persisted diagnosis immediately. A manual re-run overrides it.
  const stored = (alert as unknown as { aiDiagnosis?: Diagnosis | null }).aiDiagnosis ?? null;
  const d = triage.data?.diagnosis ?? stored ?? undefined;
  const isAuto = !triage.data && !!stored;
  const queued = triage.data?.approvalsCreated ?? (d ? d.remediation.filter((r) => r.needsApproval).length : 0);

  return (
    <div className="col gap-2">
      <AlertCard alert={alert} onAck={onAck} onResolve={onResolve} onAsk={onAsk} />

      <div className="row gap-2 wrap" style={{ alignItems: "center", paddingLeft: 4 }}>
        <Btn size="sm" variant="outline" icon="bot" loading={triage.isPending} disabled={triage.isPending} onClick={() => triage.mutate()}>
          {triage.isPending ? "Investigating…" : d ? "Re-investigate" : "Investigate with AI"}
        </Btn>
        {triage.data && (
          <span className="muted" style={{ fontSize: 11.5 }}>
            Inspected: {triage.data.toolsUsed.length ? [...new Set(triage.data.toolsUsed)].join(", ") : "—"}
          </span>
        )}
      </div>

      {err && <span style={{ color: "var(--danger, #e5484d)", fontSize: 12.5, paddingLeft: 4 }}>❌ {err}</span>}

      {d && (
        <div
          className="col gap-3 fade-in"
          style={{ border: "1px solid var(--border)", borderRadius: 10, padding: 14, background: "var(--surface-2, #0000000a)" }}
        >
          <div className="row gap-2 wrap" style={{ alignItems: "center" }}>
            <Icon name="bot" size={15} />
            <strong style={{ fontSize: 13 }}>SRE agent diagnosis</strong>
            <Badge tone={CONF_TONE[d.confidence]}>{d.confidence} confidence</Badge>
            {isAuto && <Badge tone="info" withDot>auto-investigated on arrival</Badge>}
          </div>

          <div style={{ fontSize: 13 }}>{d.summary}</div>

          <div>
            <div className="muted" style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 2 }}>ROOT CAUSE</div>
            <div style={{ fontSize: 12.5 }}>{d.rootCause}</div>
          </div>

          {d.evidence.length > 0 && (
            <div>
              <div className="muted" style={{ fontSize: 11.5, fontWeight: 600, marginBottom: 2 }}>EVIDENCE</div>
              <ul className="muted" style={{ fontSize: 12, margin: 0, paddingLeft: 18 }}>
                {d.evidence.map((e, i) => <li key={i}>{e}</li>)}
              </ul>
            </div>
          )}

          {d.remediation.length > 0 && (
            <div className="col gap-2">
              <div className="muted" style={{ fontSize: 11.5, fontWeight: 600 }}>PROPOSED FIXES</div>
              {d.remediation.map((r, i) => (
                <div key={i} className="col gap-1" style={{ borderLeft: "2px solid var(--border)", paddingLeft: 10 }}>
                  <div className="row gap-2 wrap" style={{ alignItems: "center" }}>
                    <Badge tone={RISK_TONE[r.risk]}>{r.risk} risk</Badge>
                    {r.needsApproval ? <Badge tone="warn" withDot>needs approval</Badge> : <Badge tone="ok">advisory</Badge>}
                    <span style={{ fontSize: 12.5 }}>{r.action}</span>
                  </div>
                  {r.command && (
                    <pre style={{ fontSize: 11, margin: 0, padding: "6px 8px", background: "var(--surface, #fff)", borderRadius: 6, overflowX: "auto" }}>
                      {r.command}
                    </pre>
                  )}
                </div>
              ))}
            </div>
          )}

          {queued > 0 && (
            <div className="row gap-2" style={{ alignItems: "center", borderTop: "1px solid var(--border)", paddingTop: 10 }}>
              <Icon name="check" size={13} />
              <span style={{ fontSize: 12.5 }}>
                {queued} fix{queued > 1 ? "es" : ""} queued for approval.
              </span>
              <Link href={`/p/${slug}/approvals` as Route} className="dda-alert-link" style={{ fontSize: 12.5 }}>
                Review in Approvals →
              </Link>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
