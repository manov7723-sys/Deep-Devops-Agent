"use client";

/**
 * Environment promotion — see each app's version across your environments and
 * promote the tested version to the next stage (dev → staging → prod) in one
 * click. A promotion re-deploys the SAME image to the target env, through the
 * approval gate (so prod promotions still need sign-off).
 */
import { useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Block, Btn, Field, PageHead, Select } from "@/components/ui";
import { api, apiErrorMessage } from "@/lib/api/client";

type EnvCol = { key: string; name: string; isProduction: boolean; connected: boolean };
type AppVersions = { app: string; versions: Record<string, { image: string; ready: string }> };
type EnvDiag = { env: string; ok: boolean; count: number; error?: string };
type ListResp = { ok: true; envs: EnvCol[]; apps: AppVersions[]; namespaces: string[]; namespace: string; diag?: EnvDiag[]; note?: string };

/** Best-effort image tag for display (segment after the last colon). */
function tagOf(image: string): string {
  const slash = image.lastIndexOf("/");
  const rest = slash >= 0 ? image.slice(slash + 1) : image;
  return rest.includes(":") ? rest.slice(rest.indexOf(":") + 1) : rest;
}

export function PromotionsClient({ slug }: { slug: string }) {
  const [ns, setNs] = useState("all");
  const q = useQuery<ListResp>({
    queryKey: ["p", slug, "promotions", ns],
    queryFn: () => api.get<ListResp>(`/projects/${slug}/promotions?namespace=${encodeURIComponent(ns)}`),
    refetchInterval: 20_000,
  });
  const envs = q.data?.envs ?? [];
  const apps = q.data?.apps ?? [];
  const nsOptions = useMemo(
    () => [{ value: "all", label: "All namespaces" }, ...(q.data?.namespaces ?? []).map((n) => ({ value: n, label: n }))],
    [q.data],
  );

  return (
    <div className="col gap-5">
      <PageHead
        title="Promotions"
        sub="Promote the exact tested version to the next environment (dev → staging → prod). Same image, no rebuild — and it goes through the approval gate."
        actions={<Btn variant="outline" icon="refresh" loading={q.isFetching} onClick={() => q.refetch()}>Refresh</Btn>}
      />

      {envs.length > 0 && (
        <div className="row gap-3 wrap" style={{ alignItems: "flex-end" }}>
          <div style={{ minWidth: 220 }}>
            <Field label="Namespace">
              <Select value={ns} onValueChange={setNs} ariaLabel="Namespace" options={nsOptions} />
            </Field>
          </div>
        </div>
      )}

      {envs.length === 0 ? (
        <Block><Block.Empty icon="globe" title="No environments" description={q.data?.note || "Create an environment on the Environments page first."} /></Block>
      ) : apps.length === 0 ? (
        <Block>
          <Block.Empty icon="rocket" title="Nothing to promote yet" description={q.data?.note || "No running app Deployments found. Details per cluster below:"} />
          {(q.data?.diag ?? []).length > 0 && (
            <div className="col gap-1" style={{ padding: "0 16px 16px" }}>
              {(q.data?.diag ?? []).map((d) => (
                <div key={d.env} className="row gap-2" style={{ fontSize: 12.5, alignItems: "center" }}>
                  <Badge tone={d.ok ? (d.count > 0 ? "ok" : "warn") : "danger"}>{d.env}</Badge>
                  <span className="muted">{d.ok ? `${d.count} deployment${d.count === 1 ? "" : "s"} found` : `unreachable — ${d.error}`}</span>
                </div>
              ))}
            </div>
          )}
        </Block>
      ) : (
        <div className="col gap-3">
          {apps.map((a) => <AppRow key={a.app} slug={slug} app={a} envs={envs} namespace={ns} />)}
        </div>
      )}
    </div>
  );
}

function AppRow({ slug, app, envs, namespace }: { slug: string; app: AppVersions; envs: EnvCol[]; namespace: string }) {
  const qc = useQueryClient();
  const fromEnvs = useMemo(() => envs.filter((e) => app.versions[e.key]), [envs, app]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [note, setNote] = useState<{ tone: "ok" | "danger"; text: string } | null>(null);

  const activeFrom = from || fromEnvs[0]?.key || "";
  const toEnvs = useMemo(() => envs.filter((e) => e.key !== activeFrom), [envs, activeFrom]);
  const activeTo = to || toEnvs[0]?.key || "";

  const promote = useMutation({
    mutationFn: () => api.post<{ ok: boolean; message: string }>(`/projects/${slug}/promotions`, { appName: app.app, fromEnvKey: activeFrom, toEnvKey: activeTo, namespace }),
    onMutate: () => setNote(null),
    onSuccess: (r) => { setNote({ tone: "ok", text: r.message }); qc.invalidateQueries({ queryKey: ["p", slug, "approvals"] }); },
    onError: (e) => setNote({ tone: "danger", text: apiErrorMessage(e) }),
  });

  return (
    <Block>
      <Block.Body>
        <div className="col gap-3">
          <div className="row between wrap" style={{ alignItems: "center", gap: 10 }}>
            <strong style={{ fontSize: 14 }}>{app.app}</strong>
            {/* version per env */}
            <div className="row gap-2 wrap">
              {envs.map((e) => {
                const v = app.versions[e.key];
                const title = v ? v.image : !e.connected ? "No cluster connected to this environment" : "Not deployed here";
                return (
                  <span key={e.key} className="row gap-1" style={{ alignItems: "center", fontSize: 12 }} title={title}>
                    <span className="muted">{e.name}{e.isProduction ? " (prod)" : ""}:</span>
                    {v
                      ? <Badge tone={e.isProduction ? "warn" : "ok"}>{tagOf(v.image)}</Badge>
                      : !e.connected
                        ? <span className="faint">no cluster</span>
                        : <span className="faint">—</span>}
                  </span>
                );
              })}
            </div>
          </div>

          {/* promote control */}
          <div className="row gap-2 wrap" style={{ alignItems: "flex-end" }}>
            <div style={{ minWidth: 150 }}>
              <Field label="From">
                <Select value={activeFrom} onValueChange={setFrom} ariaLabel="From env"
                  options={fromEnvs.map((e) => ({ value: e.key, label: `${e.name} · ${tagOf(app.versions[e.key]!.image)}` }))} />
              </Field>
            </div>
            <span style={{ paddingBottom: 8, opacity: 0.6 }}>→</span>
            <div style={{ minWidth: 150 }}>
              <Field label="To">
                <Select value={activeTo} onValueChange={setTo} ariaLabel="To env"
                  options={toEnvs.map((e) => ({ value: e.key, label: `${e.name}${e.isProduction ? " (prod)" : ""}${e.connected ? "" : " · no cluster"}` }))} />
              </Field>
            </div>
            <Btn variant="primary" icon="rocket" loading={promote.isPending}
              disabled={!activeFrom || !activeTo || toEnvs.length === 0 || promote.isPending}
              onClick={() => promote.mutate()}>
              Promote
            </Btn>
          </div>

          {note && <Badge tone={note.tone} icon={note.tone === "danger" ? "alert" : "check"}>{note.text}</Badge>}
        </div>
      </Block.Body>
    </Block>
  );
}
