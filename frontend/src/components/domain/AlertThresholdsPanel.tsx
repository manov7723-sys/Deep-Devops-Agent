"use client";

/**
 * Custom alarm thresholds editor — per environment, set the CPU/memory/disk
 * percentage at which alerts fire. Drives both the live in-cluster alerts and
 * the cloud alarms (AWS/Azure/GCP).
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Block, Btn, Field, Input, Select } from "@/components/ui";
import { api, apiErrorMessage } from "@/lib/api/client";
import { useProjectEnvs } from "@/hooks/queries/project";

type Metric = "cpu" | "memory" | "disk";
type Threshold = {
  metric: Metric;
  percent: number;
  severity: "low" | "medium" | "high";
  enabled: boolean;
  isDefault: boolean;
};
type ListResp = { ok: true; thresholds: Threshold[] };

const METRIC_LABEL: Record<Metric, string> = { cpu: "CPU", memory: "Memory", disk: "Disk" };
const SEVERITIES = ["low", "medium", "high"] as const;

export function AlertThresholdsPanel({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const { data: envs } = useProjectEnvs(slug);
  const envList = (envs ?? []) as unknown as Array<{
    key: string;
    name: string;
    namespace?: string;
  }>;
  const [envKey, setEnvKey] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [draft, setDraft] = useState<
    Record<string, { percent: string; severity: string; enabled: boolean }>
  >({});

  useEffect(() => {
    if (!envKey && envList.length) setEnvKey(envList[0].key);
  }, [envList, envKey]);

  const thresholdsQ = useQuery<ListResp>({
    queryKey: ["p", slug, "alert-thresholds", envKey],
    queryFn: () =>
      api.get<ListResp>(`/projects/${slug}/alert-thresholds?envKey=${encodeURIComponent(envKey)}`),
    enabled: !!envKey,
  });

  // Seed the editable draft from the loaded values.
  useEffect(() => {
    const t = thresholdsQ.data?.thresholds;
    if (!t) return;
    const d: Record<string, { percent: string; severity: string; enabled: boolean }> = {};
    for (const row of t)
      d[row.metric] = {
        percent: String(row.percent),
        severity: row.severity,
        enabled: row.enabled,
      };
    setDraft(d);
  }, [thresholdsQ.data]);

  const save = useMutation({
    mutationFn: (m: { metric: Metric; percent: number; severity: string; enabled: boolean }) =>
      api.put(`/projects/${slug}/alert-thresholds`, { envKey, ...m }),
    onMutate: () => setErr(null),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["p", slug, "alert-thresholds", envKey] }),
    onError: (e) => setErr(apiErrorMessage(e)),
  });

  const reset = useMutation({
    mutationFn: (metric: Metric) =>
      api.del(
        `/projects/${slug}/alert-thresholds?envKey=${encodeURIComponent(envKey)}&metric=${metric}`,
      ),
    onMutate: () => setErr(null),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["p", slug, "alert-thresholds", envKey] }),
    onError: (e) => setErr(apiErrorMessage(e)),
  });

  const rows = thresholdsQ.data?.thresholds ?? [];

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Set the CPU / memory / disk % at which alerts fire, per environment. Applies to the live in-cluster alerts and the cloud alarms (AWS/Azure/GCP).">
          Alarm thresholds
        </Block.Title>
      </Block.Header>
      <Block.Body>
        <div className="col gap-3">
          <div style={{ maxWidth: 320 }}>
            <Field label="Environment">
              <Select
                value={envKey}
                onValueChange={setEnvKey}
                ariaLabel="Environment"
                options={envList.map((e) => ({ value: e.key, label: e.name || e.key }))}
              />
            </Field>
          </div>

          {err && <span style={{ color: "var(--danger, #e5484d)", fontSize: 12.5 }}>❌ {err}</span>}

          {envKey && (
            <div style={{ border: "1px solid var(--border)", borderRadius: 8, overflow: "hidden" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ textAlign: "left", background: "var(--surface-2, #0000000a)" }}>
                    <th style={{ padding: "8px 10px" }}>Metric</th>
                    <th style={{ padding: "8px 10px" }}>Alert above (%)</th>
                    <th style={{ padding: "8px 10px" }}>Severity</th>
                    <th style={{ padding: "8px 10px" }}>Enabled</th>
                    <th style={{ padding: "8px 10px" }}></th>
                  </tr>
                </thead>
                <tbody>
                  {rows.map((row) => {
                    const d = draft[row.metric] ?? {
                      percent: String(row.percent),
                      severity: row.severity,
                      enabled: row.enabled,
                    };
                    const set = (patch: Partial<typeof d>) =>
                      setDraft((prev) => ({ ...prev, [row.metric]: { ...d, ...patch } }));
                    return (
                      <tr key={row.metric} style={{ borderTop: "1px solid var(--border)" }}>
                        <td style={{ padding: "8px 10px", fontWeight: 600 }}>
                          {METRIC_LABEL[row.metric]}{" "}
                          {row.isDefault && <Badge tone="default">default</Badge>}
                        </td>
                        <td style={{ padding: "8px 10px", maxWidth: 120 }}>
                          <Input
                            type="number"
                            min={1}
                            max={100}
                            value={d.percent}
                            onChange={(e) => set({ percent: e.target.value })}
                          />
                        </td>
                        <td style={{ padding: "8px 10px", maxWidth: 140 }}>
                          <Select
                            value={d.severity}
                            onValueChange={(v) => set({ severity: v })}
                            ariaLabel="Severity"
                            options={SEVERITIES.map((s) => ({ value: s, label: s }))}
                          />
                        </td>
                        <td style={{ padding: "8px 10px" }}>
                          <input
                            type="checkbox"
                            checked={d.enabled}
                            onChange={(e) => set({ enabled: e.target.checked })}
                            aria-label="Enabled"
                          />
                        </td>
                        <td style={{ padding: "8px 10px" }}>
                          <span className="row gap-2">
                            <Btn
                              variant="primary"
                              size="sm"
                              loading={save.isPending}
                              onClick={() =>
                                save.mutate({
                                  metric: row.metric,
                                  percent: Math.max(
                                    1,
                                    Math.min(100, Number(d.percent) || row.percent),
                                  ),
                                  severity: d.severity,
                                  enabled: d.enabled,
                                })
                              }
                            >
                              Save
                            </Btn>
                            {!row.isDefault && (
                              <Btn
                                variant="ghost"
                                size="sm"
                                loading={reset.isPending}
                                onClick={() => reset.mutate(row.metric)}
                              >
                                Reset
                              </Btn>
                            )}
                          </span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          <span className="muted" style={{ fontSize: 11.5 }}>
            Changes to live alerts apply on the next poll (~1 min). Cloud alarms pick up new
            thresholds the next time you set them up (chat: “set up CloudWatch/Azure/GCP alarms”).
          </span>
        </div>
      </Block.Body>
    </Block>
  );
}
