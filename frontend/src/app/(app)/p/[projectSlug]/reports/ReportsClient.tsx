"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Block, Btn, Field, Input, PageHead } from "@/components/ui";
import { api } from "@/lib/api/client";

/**
 * Reports — every application the agent has deployed, across AWS, Azure and
 * GCP, grouped by NAMESPACE.
 *
 * Namespace is the organising unit deliberately: it's what the deploy wizard
 * asks the user to pick, so it's the name they recognise, and it's the natural
 * audience boundary — the payments team and the marketing site rarely want
 * each other's pod restarts. Each namespace therefore owns its own recipient
 * list.
 *
 * A daily report goes out at 10:00 local time; "Send now" runs the exact same
 * code path so testing it proves the scheduled one works.
 */
type Recipient = {
  id: string;
  namespace: string;
  email: string;
  enabled: boolean;
  createdAt: string;
};

type AppRow = {
  name: string;
  replicas: number;
  readyReplicas: number;
  images: string[];
  restarts: number;
  lastRolloutAt?: string;
  health: "healthy" | "degraded";
};

type Section = {
  namespace: string;
  envKey: string;
  cloud: string;
  clusterReachable: boolean;
  note?: string;
  orphaned: boolean;
  apps: AppRow[];
  recipients: Recipient[];
  lastRun: { reportDate: string; status: string; detail: string; createdAt: string } | null;
};

type ReportsResponse = {
  ok: boolean;
  reportHour: number;
  today: string;
  smtp: { configured: boolean; error?: string; missing?: string[] };
  sections: Section[];
};

export function ReportsClient({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const { data, isLoading, error, refetch, isFetching } = useQuery<ReportsResponse>({
    queryKey: ["p", slug, "reports"],
    queryFn: () => api.get<ReportsResponse>(`/projects/${slug}/reports`),
    staleTime: 30_000,
    // One retry only: a failing cluster sweep takes ~45s per env, and the
    // default 3 retries turned a broken kubeconfig into a two-minute spinner
    // that then rendered as "no applications" with no explanation.
    retry: 1,
  });

  const act = useMutation({
    mutationFn: (body: Record<string, unknown>) =>
      api.post<{ ok: boolean; message?: string; added?: string[]; rejected?: string[] }>(
        `/projects/${slug}/reports`,
        body,
      ),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["p", slug, "reports"] }),
  });

  const sections = data?.sections ?? [];

  return (
    <div className="col gap-5">
      <PageHead
        title="Reports"
        sub={`Every application deployed by the agent, grouped by namespace. A health + metrics report is emailed to each namespace's recipients daily at ${data?.reportHour ?? 10}:00.`}
      />

      {/* SMTP is a hard prerequisite — surface it once at the top rather than
          letting every "Send now" fail with the same message. */}
      {data && !data.smtp.configured && (
        <Block>
          <Block.Body>
            <div className="col gap-1" style={{ fontSize: 12.5 }}>
              <div className="row gap-2" style={{ alignItems: "center" }}>
                <Badge tone="warn">email not configured</Badge>
                <span className="muted">Reports can be viewed here but not delivered yet.</span>
              </div>
              {data.smtp.missing?.map((m) => (
                <span key={m} className="muted">
                  · {m}
                </span>
              ))}
            </div>
          </Block.Body>
        </Block>
      )}

      {isLoading ? (
        <Block>
          <Block.Body>
            <span className="muted" style={{ fontSize: 13 }}>
              Scanning connected clusters…
            </span>
          </Block.Body>
        </Block>
      ) : error ? (
        /* A failed request previously fell through to the "no applications"
           message below, which blamed the user's deployment for what was
           actually a server error. Say what really happened. */
        <Block>
          <Block.Body>
            <div className="col gap-2" style={{ fontSize: 12.5 }}>
              <div className="row gap-2" style={{ alignItems: "center" }}>
                <Badge tone="danger">could not load</Badge>
                <span className="muted">
                  {error instanceof Error ? error.message : "The reports request failed."}
                </span>
              </div>
              <span className="muted">
                If this says 404, the dev server was started before this page existed — restart it.
              </span>
              <div>
                <Btn size="sm" variant="outline" loading={isFetching} onClick={() => refetch()}>
                  Retry
                </Btn>
              </div>
            </div>
          </Block.Body>
        </Block>
      ) : sections.length === 0 ? (
        /* No namespaces discovered. Still offer recipient entry — otherwise
           there is nowhere in the UI to add an address, and the user can't
           prepare a namespace that isn't deployed yet. */
        <ManualNamespaceBlock
          busy={act.isPending}
          onAction={(body) => act.mutate(body)}
          message={act.data?.message}
        />
      ) : (
        sections.map((s) => (
          <NamespaceSection
            key={s.namespace}
            section={s}
            busy={act.isPending}
            onAction={(body) => act.mutate(body)}
            lastMessage={act.data?.message}
          />
        ))
      )}
    </div>
  );
}

function NamespaceSection({
  section,
  busy,
  onAction,
  lastMessage,
}: {
  section: Section;
  busy: boolean;
  onAction: (body: Record<string, unknown>) => void;
  lastMessage?: string;
}) {
  const [emails, setEmails] = useState("");
  const enabled = section.recipients.filter((r) => r.enabled);

  const totals = {
    apps: section.apps.length,
    healthy: section.apps.filter((a) => a.health === "healthy").length,
    degraded: section.apps.filter((a) => a.health === "degraded").length,
    restarts: section.apps.reduce((n, a) => n + a.restarts, 0),
  };

  return (
    <Block>
      <Block.Header>
        <div
          className="row gap-2"
          style={{ alignItems: "center", justifyContent: "space-between", width: "100%" }}
        >
          {/* The namespace IS the title — that's the name the user picked at
              deploy time and the one they'll recognise in an inbox. */}
          <Block.Title
            sub={
              section.orphaned
                ? "No cluster in this project currently has this namespace."
                : `${section.cloud.toUpperCase()} · env ${section.envKey} · ${totals.apps} app${totals.apps === 1 ? "" : "s"}`
            }
          >
            <span className="row gap-2" style={{ alignItems: "center" }}>
              {section.namespace}
              {section.orphaned ? (
                <Badge tone="warn">orphaned</Badge>
              ) : totals.degraded > 0 ? (
                <Badge tone="danger" withDot>
                  {totals.degraded} degraded
                </Badge>
              ) : (
                <Badge tone="ok" withDot>
                  healthy
                </Badge>
              )}
              {totals.restarts > 0 && <Badge tone="warn">{totals.restarts} restarts</Badge>}
            </span>
          </Block.Title>
          <Btn
            size="sm"
            variant="outline"
            icon="mail"
            disabled={busy || enabled.length === 0}
            title={
              enabled.length === 0
                ? "Add at least one recipient first."
                : `Send this namespace's report to ${enabled.length} recipient(s) now.`
            }
            onClick={() => onAction({ action: "send-now", namespace: section.namespace })}
          >
            Send now
          </Btn>
        </div>
      </Block.Header>
      <Block.Body>
        <div className="col gap-3">
          {!section.clusterReachable && section.note && (
            <span style={{ fontSize: 12.5, color: "var(--warn, #f5a524)" }}>{section.note}</span>
          )}

          {section.apps.length > 0 && (
            <div className="col gap-1" style={{ fontSize: 12.5 }}>
              {section.apps.map((a) => (
                <div
                  key={a.name}
                  className="row gap-2"
                  style={{ alignItems: "center", justifyContent: "space-between" }}
                >
                  <span className="mono">{a.name}</span>
                  <span className="row gap-2" style={{ alignItems: "center" }}>
                    <span className="muted">
                      {a.readyReplicas}/{a.replicas} ready
                    </span>
                    {a.restarts > 0 && (
                      <span style={{ color: "var(--warn, #f5a524)" }}>{a.restarts} restarts</span>
                    )}
                    <Badge tone={a.health === "healthy" ? "ok" : "danger"}>{a.health}</Badge>
                  </span>
                </div>
              ))}
            </div>
          )}

          {/* ── Recipients ─────────────────────────────────────────── */}
          <div className="col gap-2">
            <span className="muted" style={{ fontSize: 12.5, fontWeight: 600 }}>
              Report recipients ({enabled.length} active)
            </span>

            {section.recipients.length > 0 && (
              <div className="col gap-1">
                {section.recipients.map((r) => (
                  <div
                    key={r.id}
                    className="row gap-2"
                    style={{ alignItems: "center", fontSize: 12.5 }}
                  >
                    <span className="mono" style={{ opacity: r.enabled ? 1 : 0.5 }}>
                      {r.email}
                    </span>
                    {!r.enabled && <Badge>paused</Badge>}
                    <Btn
                      size="sm"
                      variant="ghost"
                      disabled={busy}
                      onClick={() =>
                        onAction({ action: "toggle-recipient", id: r.id, enabled: !r.enabled })
                      }
                    >
                      {r.enabled ? "Pause" : "Resume"}
                    </Btn>
                    <Btn
                      size="sm"
                      variant="ghost"
                      icon="trash"
                      disabled={busy}
                      onClick={() => onAction({ action: "remove-recipient", id: r.id })}
                    >
                      Remove
                    </Btn>
                  </div>
                ))}
              </div>
            )}

            <div className="row gap-2" style={{ alignItems: "flex-end" }}>
              <div style={{ flex: 1, minWidth: 260 }}>
                <Field
                  label="Add recipients"
                  hint="One or many — separate with commas, semicolons or spaces."
                >
                  <Input
                    value={emails}
                    onChange={(e) => setEmails(e.target.value)}
                    className="mono"
                    placeholder="ops@acme.com, lead@acme.com"
                  />
                </Field>
              </div>
              <Btn
                disabled={busy || !emails.trim()}
                onClick={() => {
                  onAction({
                    action: "add-recipient",
                    namespace: section.namespace,
                    emails,
                  });
                  setEmails("");
                }}
              >
                Add
              </Btn>
            </div>
          </div>

          {section.lastRun && (
            <span className="muted" style={{ fontSize: 12 }}>
              Last report: {section.lastRun.reportDate} · {section.lastRun.status}
              {section.lastRun.detail ? ` — ${section.lastRun.detail}` : ""}
            </span>
          )}
          {lastMessage && (
            <span className="muted" style={{ fontSize: 12 }}>
              {lastMessage}
            </span>
          )}
        </div>
      </Block.Body>
    </Block>
  );
}

/**
 * Shown when no namespaces were discovered.
 *
 * Previously this state was a dead end: the only place to add a recipient was
 * inside a namespace section, so a project with nothing discovered had no way
 * to enter an email at all. It also gave the user no way to distinguish
 * "wrong project" from "nothing deployed".
 *
 * Recipients are keyed by (project, namespace) in the database and don't
 * require the namespace to exist yet, so accepting a typed namespace here is
 * both harmless and useful — subscribe before the first deploy, and the
 * report starts arriving the day the app lands.
 */
function ManualNamespaceBlock({
  busy,
  onAction,
  message,
}: {
  busy: boolean;
  onAction: (body: Record<string, unknown>) => void;
  message?: string;
}) {
  const [namespace, setNamespace] = useState("");
  const [emails, setEmails] = useState("");
  const ready = !!namespace.trim() && !!emails.trim();

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Nothing was found in this project's connected clusters. Either no app has been deployed here yet, or the apps live in a different project.">
          No applications discovered
        </Block.Title>
      </Block.Header>
      <Block.Body>
        <div className="col gap-3">
          <div className="col gap-1" style={{ fontSize: 12.5 }}>
            <span className="muted">Two things to check first:</span>
            <span className="muted">
              · The Reports tab is <b>per project</b> — open the project whose environment holds the
              cluster you deployed to.
            </span>
            <span className="muted">
              · Only apps deployed by the agent are listed (they carry the{" "}
              <span className="mono">app.kubernetes.io/managed-by: deepagent</span> label).
              Hand-deployed workloads are ignored on purpose.
            </span>
          </div>

          <div className="col gap-2">
            <span className="muted" style={{ fontSize: 12.5, fontWeight: 600 }}>
              Or subscribe a namespace ahead of time
            </span>
            <span className="muted" style={{ fontSize: 12.5 }}>
              Recipients can be added before anything is deployed — the report starts arriving once
              the namespace has apps.
            </span>
            <div className="row gap-2 wrap" style={{ alignItems: "flex-end" }}>
              <Field label="Namespace" required>
                <Input
                  value={namespace}
                  onChange={(e) => setNamespace(e.target.value)}
                  className="mono"
                  placeholder="ai-agentic-app"
                />
              </Field>
              <div style={{ flex: 1, minWidth: 240 }}>
                <Field label="Recipients" hint="Comma, semicolon or space separated." required>
                  <Input
                    value={emails}
                    onChange={(e) => setEmails(e.target.value)}
                    className="mono"
                    placeholder="ops@acme.com, lead@acme.com"
                  />
                </Field>
              </div>
              <Btn
                disabled={busy || !ready}
                onClick={() => {
                  onAction({
                    action: "add-recipient",
                    namespace: namespace.trim(),
                    emails,
                  });
                  setEmails("");
                }}
              >
                Add
              </Btn>
            </div>
          </div>

          {message && (
            <span className="muted" style={{ fontSize: 12 }}>
              {message}
            </span>
          )}
        </div>
      </Block.Body>
    </Block>
  );
}
