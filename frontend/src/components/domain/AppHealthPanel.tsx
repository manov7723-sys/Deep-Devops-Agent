"use client";

/**
 * "Is my app up?" — the plain-language health view for non-DevOps users.
 * No PromQL, no metric names: each app shows Available / Degraded / Down,
 * based on workload readiness. Polls every 15s. Backed by
 * GET /projects/[slug]/envs/[key]/monitoring/health.
 */
import { useQuery } from "@tanstack/react-query";
import { Block, StatusDot } from "@/components/ui";
import { api } from "@/lib/api/client";

type AppHealth = { name: string; kind: string; desired: number; ready: number; status: "available" | "degraded" | "down" };

const TONE = { available: "ok", degraded: "warn", down: "danger" } as const;
const LABEL = { available: "Available", degraded: "Degraded", down: "Down" } as const;

export function AppHealthPanel({ slug, envKey, namespace }: { slug: string; envKey: string; namespace: string }) {
  const { data, isLoading } = useQuery<{ ok: boolean; apps?: AppHealth[] }>({
    queryKey: ["p", slug, "app-health", envKey, namespace],
    queryFn: () => api.get(`/projects/${slug}/envs/${envKey}/monitoring/health`, { namespace }),
    refetchInterval: 15_000,
  });

  const apps = data?.ok ? data.apps ?? [] : [];
  const allUp = apps.length > 0 && apps.every((a) => a.status === "available");

  return (
    <Block>
      <Block.Header>
        <Block.Title sub={`Are your apps running in "${namespace}"? Updated every 15s.`}>Application health</Block.Title>
        <Block.Actions>
          {apps.length > 0 && (
            <StatusDot tone={allUp ? "ok" : apps.some((a) => a.status === "down") ? "danger" : "warn"} label={allUp ? "all healthy" : "needs attention"} />
          )}
        </Block.Actions>
      </Block.Header>
      <Block.Body>
        {isLoading ? (
          <span className="muted" style={{ fontSize: 13 }}>Checking…</span>
        ) : apps.length === 0 ? (
          <span className="muted" style={{ fontSize: 13 }}>No apps found in “{namespace}”. Deploy an app to this namespace to see its health here.</span>
        ) : (
          <div className="col gap-2">
            {apps.map((a) => (
              <div key={`${a.kind}/${a.name}`} className="row between card card-pad" style={{ alignItems: "center" }}>
                <span className="row gap-2" style={{ alignItems: "center" }}>
                  <StatusDot tone={TONE[a.status]} label="" />
                  <span style={{ fontWeight: 600 }}>{a.name}</span>
                  <span className="faint" style={{ fontSize: 11 }}>{a.kind}</span>
                </span>
                <span className="row gap-2" style={{ alignItems: "center" }}>
                  <span style={{ fontSize: 12.5, fontWeight: 600, color: a.status === "available" ? "var(--ok, #30a46c)" : a.status === "down" ? "var(--danger, #e5484d)" : "var(--warn, #f5a524)" }}>
                    {LABEL[a.status]}
                  </span>
                  <span className="faint" style={{ fontSize: 12 }}>{a.ready}/{a.desired} ready</span>
                </span>
              </div>
            ))}
          </div>
        )}
      </Block.Body>
    </Block>
  );
}
