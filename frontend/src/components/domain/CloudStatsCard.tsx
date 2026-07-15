"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Btn, Icon, Meter, StatusDot, type IconName } from "@/components/ui";
import { api, apiErrorMessage } from "@/lib/api/client";
import type { CloudCategory, SeedCloudResource } from "@/lib/legacy-types";

const ENV_TONE = { prod: "ok", staging: "warn", dev: "info", release: "ok", beta: "warn", alpha: "info" } as const;

const CAT_ICON: Record<CloudCategory, IconName> = {
  compute: "cpu",
  network: "globe",
  storage: "box",
  data: "db",
};

type NodeDetail = {
  ok: true;
  cpuPct?: number;
  memPct?: number;
  schedulable: boolean;
  pods: Array<{ name: string; namespace: string; status: string }>;
};

export interface CloudStatsCardProps {
  resource: SeedCloudResource;
  slug?: string;
}

export function CloudStatsCard({ resource: s, slug }: CloudStatsCardProps) {
  const metered = s.category === "compute" || s.category === "data";
  return (
    <div className="card card-pad col gap-3">
      <div className="row between">
        <div className="row gap-3" style={{ minWidth: 0 }}>
          <span className="row center dda-cloud-stat-icon">
            <Icon name={CAT_ICON[s.category]} size={18} />
          </span>
          <div className="col" style={{ lineHeight: 1.3, minWidth: 0 }}>
            <span className="mono" style={{ fontWeight: 700, fontSize: 13 }}>
              {s.name}
            </span>
            <span className="faint" style={{ fontSize: 11.5 }}>
              {s.type} · {s.region}
            </span>
          </div>
        </div>
        <StatusDot tone={s.status} />
      </div>

      <div className="row gap-2 wrap">
        <span className="badge" style={{ background: "var(--surface-2)" }}>
          {s.badges[0]}
        </span>
        <span className="badge" style={{ background: "var(--surface-2)" }}>
          {s.badges[1]}
        </span>
        <Badge tone={ENV_TONE[s.env]}>{s.env}</Badge>
      </div>

      {metered && (s.cpu !== undefined || s.mem !== undefined) && (
        <div className="col gap-2" style={{ marginTop: 2 }}>
          {s.cpu !== undefined && <Meter label="CPU" value={s.cpu} />}
          {s.mem !== undefined && <Meter label="Memory" value={s.mem} />}
        </div>
      )}

      {s.policy && (
        <div className="col gap-1 dda-cloud-policy">
          <span
            className="faint"
            style={{
              fontSize: 10.5,
              fontWeight: 700,
              textTransform: "uppercase",
              letterSpacing: "0.05em",
            }}
          >
            Bucket policy
          </span>
          <span
            className="mono"
            style={{
              fontSize: 11.5,
              color: s.policy.includes("ON") ? "var(--warn)" : "var(--text-muted)",
            }}
          >
            {s.policy}
          </span>
        </div>
      )}

      {s.type.startsWith("Kubernetes node") && slug ? (
        <NodeActions slug={slug} envKey={String(s.env)} node={s.name} />
      ) : (
        <div className="row gap-2">
          <Btn size="sm" variant="outline" icon="stats" block>
            Metrics
          </Btn>
          <Btn size="sm" variant="ghost" icon="terminal" aria-label="Terminal" />
          <Btn size="sm" variant="ghost" icon="ext" aria-label="Open" />
        </div>
      )}
    </div>
  );
}

/** Live metrics + pods + cordon/drain for a Kubernetes node card. */
function NodeActions({ slug, envKey, node }: { slug: string; envKey: string; node: string }) {
  const qc = useQueryClient();
  const [open, setOpen] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const detailQ = useQuery<NodeDetail>({
    queryKey: ["p", slug, "node-detail", envKey, node],
    queryFn: () =>
      api.get<NodeDetail>(
        `/projects/${slug}/cloud/node-detail?envKey=${encodeURIComponent(envKey)}&node=${encodeURIComponent(node)}`,
      ),
    enabled: open,
  });

  const act = useMutation({
    mutationFn: (action: "cordon" | "uncordon" | "drain") =>
      api.post<{ ok: boolean; message: string }>(`/projects/${slug}/cloud/node-action`, {
        envKey,
        node,
        action,
      }),
    onMutate: () => {
      setMsg(null);
      setErr(null);
    },
    onSuccess: (r) => {
      setMsg(r.message);
      qc.invalidateQueries({ queryKey: ["p", slug, "node-detail", envKey, node] });
    },
    onError: (e) => setErr(apiErrorMessage(e)),
  });

  const d = detailQ.data;

  return (
    <div className="col gap-2">
      <div className="row gap-2 wrap">
        <Btn size="sm" variant="outline" icon="stats" onClick={() => setOpen((o) => !o)}>
          {open ? "Hide" : "Details"}
        </Btn>
        {d?.schedulable === false ? (
          <Btn
            size="sm"
            variant="ghost"
            icon="check"
            loading={act.isPending}
            onClick={() => act.mutate("uncordon")}
          >
            Uncordon
          </Btn>
        ) : (
          <Btn
            size="sm"
            variant="ghost"
            icon="pause"
            loading={act.isPending}
            onClick={() => act.mutate("cordon")}
          >
            Cordon
          </Btn>
        )}
        <Btn
          size="sm"
          variant="ghost"
          icon="download"
          loading={act.isPending}
          onClick={() => {
            if (confirm(`Drain node "${node}"? This evicts its pods (they reschedule elsewhere).`))
              act.mutate("drain");
          }}
        >
          Drain
        </Btn>
      </div>

      {msg && <span style={{ fontSize: 11.5, color: "var(--ok, #30a46c)" }}>✅ {msg}</span>}
      {err && <span style={{ fontSize: 11.5, color: "var(--danger, #e5484d)" }}>❌ {err}</span>}

      {open && (
        <div className="col gap-2" style={{ borderTop: "1px solid var(--border)", paddingTop: 8 }}>
          {detailQ.isLoading ? (
            <span className="muted" style={{ fontSize: 12 }}>
              Loading node metrics + pods…
            </span>
          ) : !d ? (
            <span className="muted" style={{ fontSize: 12 }}>
              Couldn&apos;t load node details.
            </span>
          ) : (
            <>
              <div className="row gap-2" style={{ alignItems: "center" }}>
                {d.schedulable ? (
                  <Badge tone="ok">schedulable</Badge>
                ) : (
                  <Badge tone="warn">cordoned</Badge>
                )}
                <span className="muted" style={{ fontSize: 11.5 }}>
                  {d.pods.length} pod{d.pods.length === 1 ? "" : "s"}
                </span>
              </div>
              {d.cpuPct != null || d.memPct != null ? (
                <div className="col gap-1">
                  {d.cpuPct != null && <Meter label="CPU" value={d.cpuPct} />}
                  {d.memPct != null && <Meter label="Memory" value={d.memPct} />}
                </div>
              ) : (
                <span className="muted" style={{ fontSize: 11 }}>
                  Live CPU/memory need metrics-server on the cluster.
                </span>
              )}
              {d.pods.length > 0 && (
                <div style={{ maxHeight: 160, overflow: "auto", fontSize: 11.5 }}>
                  {d.pods.map((p) => (
                    <div
                      key={`${p.namespace}/${p.name}`}
                      className="row between"
                      style={{ padding: "2px 0" }}
                    >
                      <span
                        className="mono"
                        style={{ minWidth: 0, overflow: "hidden", textOverflow: "ellipsis" }}
                      >
                        {p.namespace}/{p.name}
                      </span>
                      <Badge
                        tone={
                          p.status === "Running" ? "ok" : p.status === "Failed" ? "danger" : "warn"
                        }
                      >
                        {p.status}
                      </Badge>
                    </div>
                  ))}
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}
