"use client";

import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Badge, Block, Btn, Field, Input, Stat } from "@/components/ui";
import { api, apiErrorMessage } from "@/lib/api/client";

type RefreshResp = {
  ok: boolean;
  accountCents: number;
  projectCents: number;
  forecastCents: number;
  budgetCents: number | null;
  currency: string;
  breached: boolean;
};

const fmt = (cents: number, cur = "USD") =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: cur || "USD" }).format(cents / 100);

/**
 * Live cost + budget panel. Top section = full cloud-account spend; bottom =
 * this project's spend vs its budget. Setting a budget + a breach raises an
 * alert (banner + email) and the agent can analyse cost optimizations.
 */
export function CostBudgetPanel({ slug }: { slug: string }) {
  const [budgetInput, setBudgetInput] = useState("");
  const [datasetInput, setDatasetInput] = useState("billing_export");
  const [data, setData] = useState<RefreshResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [gcpMsg, setGcpMsg] = useState<string | null>(null);

  const refresh = useMutation({
    mutationFn: () => api.post<RefreshResp>(`/projects/${slug}/cost/refresh`, {}),
    onMutate: () => setErr(null),
    onSuccess: (d) => setData(d),
    onError: (e) => setErr(apiErrorMessage(e)),
  });

  const gcpSetup = useMutation({
    mutationFn: () => api.post<{ ok: boolean; nextStep: string }>(`/projects/${slug}/cost/gcp-setup`, { datasetId: datasetInput, location: "US" }),
    onMutate: () => { setErr(null); setGcpMsg(null); },
    onSuccess: (r) => setGcpMsg(r.nextStep),
    onError: (e) => setErr(apiErrorMessage(e)),
  });

  const [gcpDiag, setGcpDiag] = useState<{ stage: string; message: string } | null>(null);
  const gcpVerify = useMutation({
    mutationFn: () => api.post<{ ok: boolean; stage: string; message: string }>(`/projects/${slug}/cost/gcp-verify`, {}),
    onMutate: () => { setErr(null); setGcpDiag(null); },
    onSuccess: (r) => setGcpDiag({ stage: r.stage, message: r.message }),
    onError: (e) => setErr(apiErrorMessage(e)),
  });
  // Reveal the GCP setup/verify tools for ANY GCP-cost-related error (not just
  // "isn't set up"), e.g. the "no billing-export table" message from a refresh.
  const isGcpUnset = !!err && /GCP|BigQuery|billing.?export/i.test(err);

  const setBudget = useMutation({
    mutationFn: () => api.post<{ ok: boolean; budgetCents: number }>(`/projects/${slug}/cost/budget`, { budgetDollars: Number(budgetInput) }),
    onMutate: () => setErr(null),
    onSuccess: () => { setBudgetInput(""); refresh.mutate(); },
    onError: (e) => setErr(apiErrorMessage(e)),
  });

  const cur = data?.currency ?? "USD";
  const pct = data && data.budgetCents && data.budgetCents > 0 ? Math.round((data.projectCents / data.budgetCents) * 100) : null;

  return (
    <div className="col gap-4">
      {/* ── Part 1: full account cost ─────────────────────────────────────── */}
      <Block>
        <Block.Header>
          <Block.Title sub="Total spend on the connected cloud account, month-to-date (Azure Cost Management).">
            Cloud account cost
          </Block.Title>
        </Block.Header>
        <Block.Body>
          {data ? (
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(180px, 1fr))", gap: 14 }}>
              <Stat label="Account · month-to-date" value={fmt(data.accountCents, cur)} icon="dollar" />
            </div>
          ) : (
            <span className="muted" style={{ fontSize: 13 }}>Click “Refresh cost” to pull live spend.</span>
          )}
        </Block.Body>
      </Block>

      {/* ── Part 2: this project's cost vs budget ─────────────────────────── */}
      <Block>
        <Block.Header>
          <Block.Title sub="This project's spend vs its budget. Crossing the budget raises an alert (banner + email).">
            <span className="row gap-2" style={{ alignItems: "center" }}>
              This project’s cost
              {data?.breached && <Badge tone="danger" withDot>over budget</Badge>}
              {pct != null && !data?.breached && <Badge tone={pct >= 80 ? "warn" : "ok"}>{pct}% of budget</Badge>}
            </span>
          </Block.Title>
        </Block.Header>
        <Block.Body>
          <div className="col gap-3">
            {data && (
              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(160px, 1fr))", gap: 14 }}>
                <Stat label="Project · month-to-date" value={fmt(data.projectCents, cur)} icon="dollar" />
                <Stat label="Forecast (month-end)" value={fmt(data.forecastCents, cur)} icon="stats" />
                <Stat label="Budget" value={data.budgetCents != null ? fmt(data.budgetCents, cur) : "—"} icon="flag" sub={pct != null ? `${pct}% used` : "not set"} />
              </div>
            )}

            <div className="row gap-2" style={{ alignItems: "flex-end", flexWrap: "wrap", maxWidth: 520 }}>
              <div style={{ minWidth: 200 }}>
                <Field label="Set monthly budget (USD)">
                  <Input type="number" min={0} value={budgetInput} placeholder="e.g. 500" onChange={(e) => setBudgetInput(e.target.value)} />
                </Field>
              </div>
              <Btn variant="outline" icon="flag" loading={setBudget.isPending} disabled={!budgetInput || setBudget.isPending} onClick={() => setBudget.mutate()}>
                Save budget
              </Btn>
              <Btn variant="primary" icon="refresh" loading={refresh.isPending} onClick={() => refresh.mutate()}>
                {refresh.isPending ? "Fetching…" : "Refresh cost"}
              </Btn>
            </div>

            {err && <span style={{ color: "var(--danger, #e5484d)", fontSize: 12.5 }}>❌ {err}</span>}

            {/* GCP: one-click prepare (enable BigQuery API + create dataset). The
                billing-export toggle has no API and stays a manual console step. */}
            {(isGcpUnset || gcpMsg) && (
              <div className="col gap-2" style={{ borderTop: "1px solid var(--border)", paddingTop: 10 }}>
                <span style={{ fontSize: 12.5, fontWeight: 600 }}>Set up GCP cost</span>
                <div className="row gap-2" style={{ alignItems: "flex-end", flexWrap: "wrap", maxWidth: 520 }}>
                  <div style={{ minWidth: 200 }}>
                    <Field label="BigQuery dataset id">
                      <Input value={datasetInput} onChange={(e) => setDatasetInput(e.target.value)} placeholder="billing_export" />
                    </Field>
                  </div>
                  <Btn variant="outline" icon="bot" loading={gcpSetup.isPending} disabled={!datasetInput || gcpSetup.isPending} onClick={() => gcpSetup.mutate()}>
                    Prepare GCP for cost
                  </Btn>
                  <Btn variant="ghost" icon="refresh" loading={gcpVerify.isPending} disabled={gcpVerify.isPending} onClick={() => gcpVerify.mutate()}>
                    Verify GCP cost
                  </Btn>
                </div>

                {gcpDiag && (
                  <div className="row gap-2" style={{ alignItems: "flex-start" }}>
                    <Badge tone={gcpDiag.stage === "ok" ? "ok" : gcpDiag.stage === "auth" || gcpDiag.stage === "error" ? "danger" : "warn"} withDot>
                      {gcpDiag.stage === "ok" ? "working" : gcpDiag.stage === "no_export" ? "export not on yet" : gcpDiag.stage === "no_dataset" ? "not set up" : gcpDiag.stage}
                    </Badge>
                    <span style={{ fontSize: 12.5 }}>{gcpDiag.message}</span>
                  </div>
                )}
                <p className="muted" style={{ fontSize: 12 }}>
                  This enables the BigQuery API + creates the dataset automatically. Then you do the one step with no API:
                  in the GCP console → <b>Billing → Billing export → BigQuery export</b> → point it at this dataset → Save.
                </p>
                {gcpMsg && <span style={{ fontSize: 12.5, color: "var(--ok, #30a46c)" }}>✅ Done — {gcpMsg}</span>}
              </div>
            )}

            {data?.breached && (
              <span className="muted" style={{ fontSize: 12 }}>
                Over budget — a high-severity alert was raised. Ask the agent to “analyse cost optimization” for savings.
              </span>
            )}
          </div>
        </Block.Body>
      </Block>
    </div>
  );
}
