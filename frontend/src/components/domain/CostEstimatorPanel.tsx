"use client";

/**
 * Infra cost estimator — a "what will this cost per month?" calculator you run
 * BEFORE creating infrastructure. Project-aware: it uses THIS project's connected
 * cloud (AWS project → AWS pricing, etc.), so there's no manual cloud picker
 * unless the project has more than one cloud. Deterministic, no AI.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { Badge, Block, Btn, Field, Input, Select, Toggle } from "@/components/ui";
import { api, apiErrorMessage } from "@/lib/api/client";

type LineItem = { label: string; monthly: number };
type Result = {
  ok: true;
  currency: string;
  monthly: number;
  lineItems: LineItem[];
  assumptions: string[];
  notes: string[];
};
type Meta = {
  ok: true;
  clouds: string[];
  instanceTypes: Record<string, string[]>;
  defaults: Record<string, string>;
};

const CLOUD_LABEL: Record<string, string> = { aws: "AWS", azure: "Azure", gcp: "GCP" };
const K8S_LABEL: Record<string, string> = { aws: "EKS", azure: "AKS", gcp: "GKE" };
const money = (n: number) =>
  `$${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

export function CostEstimatorPanel({ slug }: { slug: string }) {
  const meta = useQuery<Meta>({
    queryKey: ["p", slug, "cost-estimate-meta"],
    queryFn: () => api.get<Meta>(`/projects/${slug}/cost/estimate`),
  });
  const clouds = meta.data?.clouds ?? [];

  const [cloud, setCloud] = useState("");
  const [instanceType, setInstanceType] = useState("");
  const [nodeCount, setNodeCount] = useState("2");
  const [managedK8s, setManagedK8s] = useState(true);
  const [storageGb, setStorageGb] = useState("40");
  const [loadBalancers, setLoadBalancers] = useState("1");

  // Default to the project's (first) connected cloud once meta loads.
  const activeCloud = cloud || clouds[0] || "";
  const typeOptions = useMemo(
    () => (meta.data?.instanceTypes?.[activeCloud] ?? []).map((t) => ({ value: t, label: t })),
    [meta.data, activeCloud],
  );
  useEffect(() => {
    if (activeCloud && meta.data)
      setInstanceType(
        meta.data.defaults?.[activeCloud] ?? meta.data.instanceTypes?.[activeCloud]?.[0] ?? "",
      );
  }, [activeCloud, meta.data]);

  const est = useMutation({
    mutationFn: () =>
      api.post<Result>(`/projects/${slug}/cost/estimate`, {
        cloud: activeCloud,
        instanceType: instanceType.trim() || undefined,
        nodeCount: Number(nodeCount) || 0,
        managedK8s,
        storageGb: Number(storageGb) || 0,
        loadBalancers: Number(loadBalancers) || 0,
      }),
  });
  const r = est.data;

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Estimate the monthly cost BEFORE you create infrastructure — priced for this project's cloud. Approximate on-demand US list prices, no AI.">
          Cost estimator
        </Block.Title>
        {activeCloud && (
          <Block.Actions>
            <Badge tone="info" icon="cloud">
              {CLOUD_LABEL[activeCloud] ?? activeCloud}
            </Badge>
          </Block.Actions>
        )}
      </Block.Header>
      <Block.Body>
        {meta.isLoading ? (
          <span className="muted" style={{ fontSize: 13 }}>
            Loading…
          </span>
        ) : clouds.length === 0 ? (
          <span className="muted" style={{ fontSize: 13 }}>
            Connect a cloud provider (AWS, Azure, or GCP) on the Cloud providers page first — the
            estimator prices infra for your project's cloud.
          </span>
        ) : (
          <div className="col gap-3">
            <div className="row gap-3 wrap" style={{ alignItems: "flex-end" }}>
              {/* Only show a cloud picker if the project has MORE than one connected. */}
              {clouds.length > 1 && (
                <div style={{ minWidth: 120 }}>
                  <Field label="Cloud">
                    <Select
                      value={activeCloud}
                      onValueChange={setCloud}
                      ariaLabel="Cloud"
                      options={clouds.map((c) => ({ value: c, label: CLOUD_LABEL[c] ?? c }))}
                    />
                  </Field>
                </div>
              )}
              <div style={{ minWidth: 170 }}>
                <Field label="Instance type">
                  <Select
                    value={instanceType}
                    onValueChange={setInstanceType}
                    ariaLabel="Instance type"
                    options={typeOptions}
                  />
                </Field>
              </div>
              <div style={{ minWidth: 90 }}>
                <Field label="Nodes">
                  <Input
                    type="number"
                    value={nodeCount}
                    onChange={(e) => setNodeCount(e.target.value)}
                  />
                </Field>
              </div>
              <div style={{ minWidth: 110 }}>
                <Field label="Storage (GB)">
                  <Input
                    type="number"
                    value={storageGb}
                    onChange={(e) => setStorageGb(e.target.value)}
                  />
                </Field>
              </div>
              <div style={{ minWidth: 110 }}>
                <Field label="Load balancers">
                  <Input
                    type="number"
                    value={loadBalancers}
                    onChange={(e) => setLoadBalancers(e.target.value)}
                  />
                </Field>
              </div>
              <div className="row gap-2" style={{ alignItems: "center", paddingBottom: 8 }}>
                <Toggle
                  checked={managedK8s}
                  onCheckedChange={setManagedK8s}
                  ariaLabel="Managed Kubernetes"
                />
                <span style={{ fontSize: 13 }}>
                  Managed K8s ({K8S_LABEL[activeCloud] ?? "EKS/AKS/GKE"})
                </span>
              </div>
              <Btn
                variant="primary"
                icon="dollar"
                loading={est.isPending}
                onClick={() => est.mutate()}
              >
                Estimate
              </Btn>
            </div>

            {est.isError && (
              <Badge tone="danger" icon="alert">
                {apiErrorMessage(est.error)}
              </Badge>
            )}

            {r && (
              <div className="col gap-2" style={{ marginTop: 4 }}>
                <div className="row gap-2" style={{ alignItems: "baseline" }}>
                  <span style={{ fontSize: 26, fontWeight: 700 }}>{money(r.monthly)}</span>
                  <span className="muted" style={{ fontSize: 13 }}>
                    / month (est.) · {CLOUD_LABEL[activeCloud] ?? activeCloud}
                  </span>
                </div>
                <div
                  className="col gap-1"
                  style={{ borderTop: "1px solid var(--border-soft)", paddingTop: 8 }}
                >
                  {r.lineItems.map((li, i) => (
                    <div key={i} className="row between" style={{ fontSize: 13 }}>
                      <span className="muted">{li.label}</span>
                      <span className="mono">{money(li.monthly)}</span>
                    </div>
                  ))}
                </div>
                {(r.assumptions.length > 0 || r.notes.length > 0) && (
                  <ul
                    className="faint"
                    style={{ fontSize: 11.5, margin: "6px 0 0", paddingLeft: 16 }}
                  >
                    {r.assumptions.map((a, i) => (
                      <li key={`a${i}`}>{a}</li>
                    ))}
                    {r.notes.map((n, i) => (
                      <li key={`n${i}`}>{n}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </div>
        )}
      </Block.Body>
    </Block>
  );
}
