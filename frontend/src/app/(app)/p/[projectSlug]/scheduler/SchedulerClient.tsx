"use client";

/**
 * Scheduler — create, view, and cancel scheduled deployments WITHOUT the chat
 * agent. The background scheduler runs each one at its time via the same deploy
 * path (auto-rollback + email/ChatOps notify included).
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Block, Btn, Field, Input, PageHead, Select, Toggle, type BadgeTone } from "@/components/ui";
import { api, apiErrorMessage } from "@/lib/api/client";
import { useActiveEnv } from "@/hooks/useActiveEnv";

type Target = { envId: string; envKey: string; name: string; namespace: string; isProduction: boolean };
type Scheduled = {
  id: string; envKey: string; appName: string; image: string; containerPort: number; replicas: number;
  expose: boolean; host: string | null; namespace: string | null; runAt: string; status: string; result: string | null; ranAt: string | null; createdAt: string;
  approved: boolean;
};
type ListResp = { ok: true; scheduled: Scheduled[]; targets: Target[] };

const STATUS_TONE: Record<string, BadgeTone> = {
  pending: "accent", running: "warn", done: "ok", failed: "danger", cancelled: "default",
};

/** Format a Date as the value a datetime-local input expects (local time, no seconds/zone). */
function toLocalInput(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`;
}

export function SchedulerClient({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const projectActiveEnv = useActiveEnv(slug);
  const [envKey, setEnvKey] = useState("");
  const [appName, setAppName] = useState("");
  const [image, setImage] = useState("");
  const [port, setPort] = useState("8080");
  const [replicas, setReplicas] = useState("1");
  const [expose, setExpose] = useState(false);
  const [host, setHost] = useState("");
  const [runAt, setRunAt] = useState("");
  const [err, setErr] = useState<string | null>(null);

  const q = useQuery<ListResp>({
    queryKey: ["p", slug, "scheduler"],
    queryFn: () => api.get<ListResp>(`/projects/${slug}/scheduler`),
    refetchInterval: 15_000,
  });
  const targets = q.data?.targets ?? [];
  const scheduled = q.data?.scheduled ?? [];
  const invalidate = () => qc.invalidateQueries({ queryKey: ["p", slug, "scheduler"] });

  // Default to the project's active env, then the first target.
  const envValue = envKey || (projectActiveEnv && targets.some((t) => t.envKey === projectActiveEnv) ? projectActiveEnv : "") || targets[0]?.envKey || "";
  const envOptions = useMemo(
    () => targets.map((t) => ({ value: t.envKey, label: `${t.name || t.envKey}${t.isProduction ? " (prod)" : ""}` })),
    [targets],
  );

  function quickSet(kind: "1h" | "tonight" | "tomorrow") {
    const d = new Date();
    if (kind === "1h") d.setHours(d.getHours() + 1);
    else if (kind === "tonight") { d.setHours(21, 0, 0, 0); if (d.getTime() < Date.now()) d.setDate(d.getDate() + 1); }
    else { d.setDate(d.getDate() + 1); d.setHours(9, 0, 0, 0); }
    setRunAt(toLocalInput(d));
  }

  const create = useMutation({
    mutationFn: () => api.post(`/projects/${slug}/scheduler`, {
      envKey: envValue,
      appName: appName.trim(),
      image: image.trim(),
      runAt: new Date(runAt).toISOString(),
      containerPort: Number(port) || 8080,
      replicas: Number(replicas) || 1,
      expose,
      host: host.trim() || undefined,
    }),
    onMutate: () => setErr(null),
    onSuccess: () => { setAppName(""); setImage(""); setHost(""); setExpose(false); setRunAt(""); invalidate(); },
    onError: (e) => setErr(apiErrorMessage(e)),
  });

  const cancel = useMutation({
    mutationFn: (id: string) => api.del(`/projects/${slug}/scheduler/${id}`),
    onMutate: () => setErr(null),
    onSuccess: invalidate,
    onError: (e) => setErr(apiErrorMessage(e)),
  });

  const canSubmit = !!envValue && !!appName.trim() && !!image.trim() && !!runAt && (!expose || !!host.trim()) && !create.isPending;

  return (
    <div className="col gap-5">
      <PageHead
        title="Scheduler"
        sub="Schedule a deployment to run later. It first needs an approval on the Approvals page; once approved, the background scheduler runs it at the set time (with auto-rollback + notifications, no browser needed)."
        actions={<Btn variant="outline" icon="refresh" loading={q.isFetching} onClick={() => invalidate()}>Refresh</Btn>}
      />

      {err && <Badge tone="danger" icon="alert">{err}</Badge>}

      {targets.length === 0 ? (
        <Block><Block.Empty icon="globe" title="No deployable clusters" description="Connect a cluster on the Clusters page first — then you can schedule deployments to it." /></Block>
      ) : (
        <Block>
          <Block.Header><Block.Title sub="Fill in what to deploy and when. It runs automatically at that time.">Schedule a deployment</Block.Title></Block.Header>
          <Block.Body>
            <div className="col gap-3">
              <div className="row gap-3 wrap" style={{ alignItems: "flex-end" }}>
                <div style={{ minWidth: 180 }}>
                  <Field label="Environment / cluster">
                    <Select value={envValue} onValueChange={setEnvKey} ariaLabel="Environment" options={envOptions} />
                  </Field>
                </div>
                <div style={{ minWidth: 160 }}>
                  <Field label="App name"><Input value={appName} placeholder="my-app" onChange={(e) => setAppName(e.target.value)} /></Field>
                </div>
                <div style={{ minWidth: 300, flex: 1 }}>
                  <Field label="Image"><Input value={image} placeholder="registry/my-app:tag" onChange={(e) => setImage(e.target.value)} /></Field>
                </div>
              </div>

              <div className="row gap-3 wrap" style={{ alignItems: "flex-end" }}>
                <div style={{ minWidth: 110 }}>
                  <Field label="Container port"><Input type="number" value={port} onChange={(e) => setPort(e.target.value)} /></Field>
                </div>
                <div style={{ minWidth: 100 }}>
                  <Field label="Replicas"><Input type="number" value={replicas} onChange={(e) => setReplicas(e.target.value)} /></Field>
                </div>
                <div className="row gap-2" style={{ alignItems: "center", paddingBottom: 8 }}>
                  <Toggle checked={expose} onCheckedChange={setExpose} ariaLabel="Expose publicly" />
                  <span style={{ fontSize: 13 }}>Expose publicly</span>
                </div>
                {expose && (
                  <div style={{ minWidth: 220, flex: 1 }}>
                    <Field label="Public host"><Input value={host} placeholder="app.example.com" onChange={(e) => setHost(e.target.value)} /></Field>
                  </div>
                )}
              </div>

              <div className="row gap-3 wrap" style={{ alignItems: "flex-end" }}>
                <div style={{ minWidth: 240 }}>
                  <Field label="Run at">
                    <Input type="datetime-local" value={runAt} min={toLocalInput(new Date(Date.now() + 60_000))} onChange={(e) => setRunAt(e.target.value)} />
                  </Field>
                </div>
                <div className="row gap-2" style={{ paddingBottom: 8 }}>
                  <Btn variant="outline" size="sm" onClick={() => quickSet("1h")}>In 1 hour</Btn>
                  <Btn variant="outline" size="sm" onClick={() => quickSet("tonight")}>Tonight 9 PM</Btn>
                  <Btn variant="outline" size="sm" onClick={() => quickSet("tomorrow")}>Tomorrow 9 AM</Btn>
                </div>
                <Btn variant="primary" icon="clock" loading={create.isPending} disabled={!canSubmit} onClick={() => create.mutate()}>Schedule</Btn>
              </div>
            </div>
          </Block.Body>
        </Block>
      )}

      {scheduled.length === 0 ? (
        <Block><Block.Empty icon="clock" title="Nothing scheduled" description="Scheduled deployments will appear here." /></Block>
      ) : (
        <div className="col gap-3">
          {scheduled.map((s) => <ScheduledRow key={s.id} s={s} onCancel={() => cancel.mutate(s.id)} cancelling={cancel.isPending} />)}
        </div>
      )}
    </div>
  );
}

function ScheduledRow({ s, onCancel, cancelling }: { s: Scheduled; onCancel: () => void; cancelling: boolean }) {
  const when = new Date(s.runAt);
  const overdue = s.status === "pending" && when.getTime() < Date.now();
  return (
    <Block>
      <Block.Body>
        <div className="row between wrap" style={{ alignItems: "center", gap: 10 }}>
          <div className="col" style={{ gap: 2, minWidth: 0 }}>
            <span className="row gap-2" style={{ alignItems: "center" }}>
              <strong style={{ fontSize: 14 }}>{s.appName}</strong>
              <Badge tone="default">{s.envKey}</Badge>
              <Badge tone={STATUS_TONE[s.status] ?? "default"} withDot>{s.status}</Badge>
              {s.status === "pending" && (s.approved
                ? <Badge tone="ok">approved</Badge>
                : <Badge tone="warn">awaiting approval</Badge>)}
              {overdue && s.approved && <Badge tone="warn">running soon…</Badge>}
            </span>
            <span className="mono faint" style={{ fontSize: 12 }}>{s.image}</span>
            {s.result && <span className="faint" style={{ fontSize: 11.5 }}>{s.result}</span>}
          </div>
          <div className="row gap-3 wrap" style={{ alignItems: "center" }}>
            <span className="muted" style={{ fontSize: 12 }}>
              {when.toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
              {` · ${s.replicas} replica${s.replicas === 1 ? "" : "s"}`}
            </span>
            {s.status === "pending" && (
              <Btn variant="ghost" size="sm" icon="trash" loading={cancelling} onClick={onCancel}>Cancel</Btn>
            )}
          </div>
        </div>
      </Block.Body>
    </Block>
  );
}
