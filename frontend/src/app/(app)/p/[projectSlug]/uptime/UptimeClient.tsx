"use client";

/**
 * Uptime monitoring — add URLs to watch; the app checks them on a schedule and
 * raises an alert (banner + email + Slack) when one goes down. Shows current
 * status, latency, and a strip of recent checks.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Block, Btn, Field, Input, PageHead, Select, Toggle } from "@/components/ui";
import { api, apiErrorMessage } from "@/lib/api/client";

type Check = { at: string; ok: boolean; latencyMs: number | null; status: number | null };
type Monitor = {
  id: string; name: string; url: string; method: string; expectedStatus: number; intervalSec: number; enabled: boolean;
  lastOk: boolean | null; lastStatus: number | null; lastLatencyMs: number | null; lastCheckedAt: string | null; consecutiveFails: number;
  certExpiresAt: string | null;
  checks: Check[];
};
type ListResp = { ok: true; monitors: Monitor[] };

const INTERVALS = [
  { value: "60", label: "every 1 min" },
  { value: "300", label: "every 5 min" },
  { value: "900", label: "every 15 min" },
  { value: "3600", label: "every hour" },
];

export function UptimeClient({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [expected, setExpected] = useState("200");
  const [interval, setInterval] = useState("300");
  const [err, setErr] = useState<string | null>(null);

  const q = useQuery<ListResp>({
    queryKey: ["p", slug, "uptime"],
    queryFn: () => api.get<ListResp>(`/projects/${slug}/uptime`),
    refetchInterval: 15_000,
  });
  const monitors = q.data?.monitors ?? [];
  const invalidate = () => qc.invalidateQueries({ queryKey: ["p", slug, "uptime"] });

  const add = useMutation({
    mutationFn: () => api.post(`/projects/${slug}/uptime`, { name: name.trim(), url: url.trim(), expectedStatus: Number(expected) || 200, intervalSec: Number(interval) || 300 }),
    onMutate: () => setErr(null),
    onSuccess: () => { setName(""); setUrl(""); invalidate(); },
    onError: (e) => setErr(apiErrorMessage(e)),
  });
  const toggle = useMutation({
    mutationFn: (v: { id: string; enabled: boolean }) => api.patch(`/projects/${slug}/uptime/${v.id}`, { enabled: v.enabled }),
    onSuccess: invalidate,
    onError: (e) => setErr(apiErrorMessage(e)),
  });
  const del = useMutation({
    mutationFn: (id: string) => api.del(`/projects/${slug}/uptime/${id}`),
    onSuccess: invalidate,
    onError: (e) => setErr(apiErrorMessage(e)),
  });
  const run = useMutation({
    mutationFn: () => api.post<{ ok: boolean; ran: number }>(`/projects/${slug}/uptime/run`, {}),
    onMutate: () => setErr(null),
    onSuccess: invalidate,
    onError: (e) => setErr(apiErrorMessage(e)),
  });

  return (
    <div className="col gap-5">
      <PageHead
        title="Uptime"
        sub="Watch your app URLs — we check them on a schedule and alert (banner + email + Slack) if one goes down."
        actions={<Btn variant="outline" icon="refresh" loading={run.isPending} onClick={() => run.mutate()}>Check now</Btn>}
      />

      {err && <Badge tone="danger" icon="alert">{err}</Badge>}

      {/* Add monitor */}
      <Block>
        <Block.Header><Block.Title sub="Add a URL to monitor.">New monitor</Block.Title></Block.Header>
        <Block.Body>
          <div className="row gap-3 wrap" style={{ alignItems: "flex-end" }}>
            <div style={{ minWidth: 180 }}>
              <Field label="Name"><Input value={name} placeholder="Marketing site" onChange={(e) => setName(e.target.value)} /></Field>
            </div>
            <div style={{ minWidth: 260, flex: 1 }}>
              <Field label="URL"><Input value={url} placeholder="https://myapp.example.com/health" onChange={(e) => setUrl(e.target.value)} /></Field>
            </div>
            <div style={{ minWidth: 120 }}>
              <Field label="Expected status"><Input type="number" value={expected} onChange={(e) => setExpected(e.target.value)} /></Field>
            </div>
            <div style={{ minWidth: 150 }}>
              <Field label="Check interval">
                <Select value={interval} onValueChange={setInterval} ariaLabel="Interval" options={INTERVALS} />
              </Field>
            </div>
            <Btn variant="primary" icon="plus" loading={add.isPending} disabled={!name.trim() || !url.trim() || add.isPending} onClick={() => add.mutate()}>Add monitor</Btn>
          </div>
        </Block.Body>
      </Block>

      {/* Monitors */}
      {monitors.length === 0 ? (
        <Block><Block.Empty icon="gauge" title="No monitors yet" description="Add a URL above to start watching it." /></Block>
      ) : (
        <div className="col gap-3">
          {monitors.map((m) => <MonitorRow key={m.id} m={m} onToggle={(v) => toggle.mutate({ id: m.id, enabled: v })} onDelete={() => del.mutate(m.id)} deleting={del.isPending} />)}
        </div>
      )}
    </div>
  );
}

function certInfo(iso: string | null): { label: string; tone: "ok" | "warn" | "danger" } | null {
  if (!iso) return null;
  const days = Math.floor((new Date(iso).getTime() - Date.now()) / 86_400_000);
  if (days < 0) return { label: "cert expired", tone: "danger" };
  if (days <= 21) return { label: `cert: ${days}d left`, tone: days <= 3 ? "danger" : "warn" };
  return { label: `cert: ${days}d`, tone: "ok" };
}

function MonitorRow({ m, onToggle, onDelete, deleting }: { m: Monitor; onToggle: (v: boolean) => void; onDelete: () => void; deleting: boolean }) {
  const state = m.lastOk == null ? "unknown" : m.lastOk ? "up" : "down";
  const tone = state === "up" ? "solid-ok" : state === "down" ? "danger" : "default";
  const cert = certInfo(m.certExpiresAt);
  const checks = [...m.checks].reverse(); // chronological for the strip
  return (
    <Block>
      <Block.Body>
        <div className="col gap-2">
          <div className="row between wrap" style={{ alignItems: "center", gap: 10 }}>
            <div className="col" style={{ gap: 2, minWidth: 0 }}>
              <span className="row gap-2" style={{ alignItems: "center" }}>
                <strong style={{ fontSize: 14 }}>{m.name}</strong>
                <Badge tone={tone} withDot>{state === "up" ? "Up" : state === "down" ? "Down" : "—"}</Badge>
                {cert && <Badge tone={cert.tone}>{cert.label}</Badge>}
                {!m.enabled && <Badge tone="default">paused</Badge>}
              </span>
              <a href={m.url} target="_blank" rel="noreferrer" className="mono faint" style={{ fontSize: 12 }}>{m.url}</a>
            </div>
            <div className="row gap-3 wrap" style={{ alignItems: "center" }}>
              <span className="muted" style={{ fontSize: 12 }}>
                {m.lastLatencyMs != null ? `${m.lastLatencyMs} ms` : "—"}
                {m.lastStatus != null ? ` · ${m.lastStatus}` : ""}
                {m.lastCheckedAt ? ` · ${new Date(m.lastCheckedAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}` : " · not checked"}
              </span>
              <Toggle checked={m.enabled} onCheckedChange={onToggle} ariaLabel="Enabled" />
              <Btn variant="ghost" size="sm" icon="trash" loading={deleting} onClick={onDelete} aria-label="Delete" />
            </div>
          </div>
          {/* recent checks strip */}
          {checks.length > 0 && (
            <div className="row" style={{ gap: 3 }}>
              {checks.map((c, i) => (
                <span
                  key={i}
                  title={`${c.ok ? "OK" : "Fail"}${c.latencyMs != null ? ` · ${c.latencyMs}ms` : ""}${c.status != null ? ` · ${c.status}` : ""}`}
                  style={{ width: 8, height: 20, borderRadius: 2, background: c.ok ? "var(--ok, #30a46c)" : "var(--danger, #e5484d)" }}
                />
              ))}
            </div>
          )}
        </div>
      </Block.Body>
    </Block>
  );
}
