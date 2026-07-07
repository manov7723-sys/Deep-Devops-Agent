"use client";

/**
 * Infra topology — an interactive graph of the cluster (React Flow):
 *   Ingress → Service → Deployment → Pods, plus app-to-app dependency edges
 *   (dashed) with the port each connection uses. Pan / zoom / drag.
 */
import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { ReactFlow, Background, Controls, MarkerType, Position, type Node, type Edge } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Block, Btn, Field, PageHead, Select } from "@/components/ui";
import { api, apiErrorMessage } from "@/lib/api/client";
import { useProjectEnvs } from "@/hooks/queries/project";

type GStatus = "ok" | "warn" | "danger" | "default";
type GNode = { id: string; kind: "ingress" | "service" | "deployment" | "pod"; label: string; sub?: string; status: GStatus; namespace: string };
type GEdge = { id: string; source: string; target: string; label?: string; kind: "wire" | "dependency" };
type Topo = { ok: true; namespace: string; namespaces: string[]; nodes: GNode[]; edges: GEdge[] };

const COLUMN: Record<GNode["kind"], number> = { ingress: 0, service: 1, deployment: 2, pod: 3 };
const KIND_BG: Record<GNode["kind"], string> = { ingress: "#eef4ff", service: "#f3edff", deployment: "#eafaf1", pod: "#f6f8fa" };
const STATUS_BORDER: Record<GStatus, string> = { ok: "#30a46c", warn: "#f5a623", danger: "#e5484d", default: "#8b93a7" };

function toFlow(g: Topo): { nodes: Node[]; edges: Edge[] } {
  // Layered left→right layout: one column per kind, stacked vertically.
  const perColumn: Record<number, number> = {};
  const nodes: Node[] = g.nodes.map((n) => {
    const col = COLUMN[n.kind];
    const row = (perColumn[col] = (perColumn[col] ?? 0) + 1) - 1;
    return {
      id: n.id,
      position: { x: col * 260, y: row * 96 },
      data: {
        label: (
          <div style={{ textAlign: "left", lineHeight: 1.25 }}>
            <div style={{ fontSize: 8, textTransform: "uppercase", letterSpacing: "0.06em", opacity: 0.6 }}>{n.kind}</div>
            <div style={{ fontWeight: 700, fontSize: 11, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 180 }}>{n.label}</div>
            {n.sub && <div style={{ fontSize: 9, opacity: 0.7, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", maxWidth: 180 }}>{n.sub}</div>}
          </div>
        ),
      },
      sourcePosition: Position.Right,
      targetPosition: Position.Left,
      style: {
        background: KIND_BG[n.kind],
        border: `2px solid ${STATUS_BORDER[n.status]}`,
        borderRadius: 10,
        padding: "6px 10px",
        width: 200,
        color: "#1a1d24",
      },
    };
  });

  const edges: Edge[] = g.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    label: e.label,
    animated: e.kind === "dependency",
    style: e.kind === "dependency" ? { stroke: "#8b5cf6", strokeDasharray: "5 4" } : { stroke: "#9aa3b2" },
    labelStyle: { fontSize: 10, fontWeight: 600 },
    labelBgStyle: { fill: "#fff", fillOpacity: 0.9 },
    markerEnd: { type: MarkerType.ArrowClosed, color: e.kind === "dependency" ? "#8b5cf6" : "#9aa3b2" },
  }));

  return { nodes, edges };
}

export function TopologyClient({ slug }: { slug: string }) {
  const { data: envs } = useProjectEnvs(slug);
  const envList = (envs ?? []) as unknown as Array<{ key: string; name: string }>;
  const [envKey, setEnvKey] = useState("");
  const [ns, setNs] = useState("all");
  useEffect(() => { if (!envKey && envList.length) setEnvKey(envList[0].key); }, [envList, envKey]);

  const q = useQuery<Topo>({
    queryKey: ["p", slug, "topology", envKey, ns],
    queryFn: () => api.get<Topo>(`/projects/${slug}/topology?envKey=${encodeURIComponent(envKey)}&namespace=${encodeURIComponent(ns)}`),
    enabled: !!envKey,
    refetchInterval: 20_000,
  });
  const nsOptions = [{ value: "all", label: "All namespaces" }, ...(q.data?.namespaces ?? []).map((n) => ({ value: n, label: n }))];
  const flow = useMemo(() => (q.data ? toFlow(q.data) : { nodes: [], edges: [] }), [q.data]);

  return (
    <div className="col gap-5">
      <PageHead
        title="Topology"
        sub="Interactive map of your cluster — Ingress → Service → Deployment → Pods, with the ports each connection uses. Dashed purple = app dependency."
        actions={<Btn variant="outline" icon="refresh" loading={q.isFetching} onClick={() => q.refetch()}>Refresh</Btn>}
      />

      <div className="row gap-3 wrap">
        <div style={{ minWidth: 220 }}>
          <Field label="Environment">
            <Select value={envKey} onValueChange={setEnvKey} ariaLabel="Environment" options={envList.map((e) => ({ value: e.key, label: e.name || e.key }))} />
          </Field>
        </div>
        <div style={{ minWidth: 220 }}>
          <Field label="Namespace" hint="Pick a namespace to focus its apps.">
            <Select value={ns} onValueChange={setNs} ariaLabel="Namespace" options={nsOptions} />
          </Field>
        </div>
      </div>

      {q.isError ? (
        <Block><Block.Error message={apiErrorMessage(q.error)} onRetry={() => q.refetch()} /></Block>
      ) : q.isLoading ? (
        <Block><Block.Loading /></Block>
      ) : flow.nodes.length === 0 ? (
        <Block><Block.Empty icon="server" title="Nothing to map yet" description="No apps found in this scope. Deploy an app, or pick a different namespace." /></Block>
      ) : (
        <>
          {/* Legend */}
          <div className="row gap-3 wrap" style={{ fontSize: 11.5, alignItems: "center" }}>
            <span className="row gap-1" style={{ alignItems: "center" }}><span style={{ width: 12, height: 12, borderRadius: 3, background: KIND_BG.ingress, border: "1px solid #8b93a7" }} /> Ingress</span>
            <span className="row gap-1" style={{ alignItems: "center" }}><span style={{ width: 12, height: 12, borderRadius: 3, background: KIND_BG.service, border: "1px solid #8b93a7" }} /> Service</span>
            <span className="row gap-1" style={{ alignItems: "center" }}><span style={{ width: 12, height: 12, borderRadius: 3, background: KIND_BG.deployment, border: "1px solid #30a46c" }} /> Deployment</span>
            <span className="row gap-1" style={{ alignItems: "center" }}><span style={{ width: 12, height: 12, borderRadius: 3, background: KIND_BG.pod, border: "1px solid #8b93a7" }} /> Pod</span>
            <span className="faint">— solid = wiring · dashed purple = app dependency (with port)</span>
          </div>
          <div style={{ height: 620, border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", background: "var(--surface, #fff)" }}>
            <ReactFlow nodes={flow.nodes} edges={flow.edges} fitView proOptions={{ hideAttribution: true }} nodesDraggable nodesConnectable={false}>
              <Background gap={18} />
              <Controls showInteractive={false} />
            </ReactFlow>
          </div>
        </>
      )}
    </div>
  );
}
