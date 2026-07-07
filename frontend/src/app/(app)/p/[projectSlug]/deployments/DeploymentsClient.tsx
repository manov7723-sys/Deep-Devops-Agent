"use client";

/**
 * Deployments — the history of every deploy (manual, scheduled, or agent) with
 * one-click Rollback (revert to previous version) and Redeploy (re-apply the
 * same image). Works without the AI; rollback/redeploy run server-side.
 */
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Block, Btn, PageHead, type BadgeTone } from "@/components/ui";
import { api, apiErrorMessage } from "@/lib/api/client";

type Deployment = {
  id: string; envKey: string; appName: string; image: string; namespace: string;
  replicas: number; status: string; detail: string | null; source: string; createdAt: string;
};
type ListResp = { ok: true; deployments: Deployment[] };

const STATUS_TONE: Record<string, BadgeTone> = {
  succeeded: "ok", failed: "danger", rolled_back: "warn",
};
const STATUS_LABEL: Record<string, string> = {
  succeeded: "deployed", failed: "failed", rolled_back: "rolled back",
};

export function DeploymentsClient({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const [note, setNote] = useState<{ tone: BadgeTone; text: string } | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  const q = useQuery<ListResp>({
    queryKey: ["p", slug, "deployments"],
    queryFn: () => api.get<ListResp>(`/projects/${slug}/deployments`),
    refetchInterval: 15_000,
  });
  const deployments = q.data?.deployments ?? [];
  const invalidate = () => qc.invalidateQueries({ queryKey: ["p", slug, "deployments"] });

  const act = useMutation({
    mutationFn: (v: { id: string; action: "rollback" | "redeploy" }) =>
      api.post<{ ok: boolean; message: string }>(`/projects/${slug}/deployments/${v.id}`, { action: v.action }),
    onMutate: (v) => { setNote(null); setBusyId(v.id); },
    onSuccess: (r) => { setNote({ tone: "ok", text: r.message }); invalidate(); },
    onError: (e) => setNote({ tone: "danger", text: apiErrorMessage(e) }),
    onSettled: () => setBusyId(null),
  });

  return (
    <div className="col gap-5">
      <PageHead
        title="Deployments"
        sub="Every deploy — manual, scheduled, or agent-driven. Roll back to the previous version or redeploy the same image in one click."
        actions={<Btn variant="outline" icon="refresh" loading={q.isFetching} onClick={() => invalidate()}>Refresh</Btn>}
      />

      {note && <Badge tone={note.tone} icon={note.tone === "danger" ? "alert" : "check"}>{note.text}</Badge>}

      {deployments.length === 0 ? (
        <Block><Block.Empty icon="rocket" title="No deployments yet" description="Deploys will show up here — from the Scheduler, the deploy wizard, or the agent." /></Block>
      ) : (
        <div className="col gap-3">
          {deployments.map((d) => (
            <Block key={d.id}>
              <Block.Body>
                <div className="row between wrap" style={{ alignItems: "center", gap: 10 }}>
                  <div className="col" style={{ gap: 2, minWidth: 0 }}>
                    <span className="row gap-2" style={{ alignItems: "center" }}>
                      <strong style={{ fontSize: 14 }}>{d.appName}</strong>
                      <Badge tone="default">{d.envKey}</Badge>
                      <Badge tone={STATUS_TONE[d.status] ?? "default"} withDot>{STATUS_LABEL[d.status] ?? d.status}</Badge>
                      <Badge tone="info">{d.source}</Badge>
                    </span>
                    <span className="mono faint" style={{ fontSize: 12 }}>{d.image}</span>
                    {d.detail && <span className="faint" style={{ fontSize: 11.5 }}>{d.detail}</span>}
                  </div>
                  <div className="row gap-3 wrap" style={{ alignItems: "center" }}>
                    <span className="muted" style={{ fontSize: 12 }}>
                      {new Date(d.createdAt).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}
                      {` · ${d.replicas} replica${d.replicas === 1 ? "" : "s"}`}
                    </span>
                    <Btn variant="outline" size="sm" icon="clock" loading={busyId === d.id && act.variables?.action === "rollback"}
                      disabled={busyId != null} onClick={() => act.mutate({ id: d.id, action: "rollback" })}>Rollback</Btn>
                    <Btn variant="outline" size="sm" icon="refresh" loading={busyId === d.id && act.variables?.action === "redeploy"}
                      disabled={busyId != null} onClick={() => act.mutate({ id: d.id, action: "redeploy" })}>Redeploy</Btn>
                  </div>
                </div>
              </Block.Body>
            </Block>
          ))}
        </div>
      )}
    </div>
  );
}
