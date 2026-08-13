"use client";

/**
 * Env-variable → service assignment, rendered in chat via the ```env-assign```
 * fence and used by the deploy wizard for multi-service repos.
 *
 * Reads the names actually stored in GitHub (environment secrets + variables,
 * with repo-level as fallback) and lets the user say who each one belongs to:
 * shared by every service, or one service alone. The assignment is saved on
 * the DeploymentPlan; the next deploy generates a CD step that materializes
 * `app-env` (shared) plus `app-env-<service>` and wires each Deployment to
 * its own — so the backend's JWT key never lands in the frontend pod.
 *
 * Secret VALUES are never fetched or shown: GitHub doesn't expose them, and
 * assignment only needs names.
 */
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Block, Btn, Icon, Select } from "@/components/ui";
import { api, apiErrorMessage } from "@/lib/api/client";

type EnvVarRow = {
  name: string;
  kind: "secret" | "variable";
  scope: "environment" | "repository";
};
type Resp = {
  ok: boolean;
  repoFullName: string;
  envKey: string;
  services: { name: string; role: string }[];
  vars: EnvVarRow[];
  assignment: Record<string, string>;
  warnings?: string[];
};
type EnvRow = { key: string; name?: string };

const SHARED = "";

export function EnvAssignBox({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const [envKey, setEnvKey] = useState<string>("");
  const [draft, setDraft] = useState<Record<string, string>>({});
  const [dirty, setDirty] = useState(false);
  const [saved, setSaved] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data: envs } = useQuery<EnvRow[]>({
    queryKey: ["p", slug, "envs"],
    queryFn: () => api.get<EnvRow[]>(`/projects/${slug}/envs`),
    staleTime: 60_000,
  });
  // Default to the project's production-ish env, else the first one.
  useEffect(() => {
    if (envKey || !envs?.length) return;
    setEnvKey(envs.find((e) => e.key === "prod")?.key ?? envs[0]!.key);
  }, [envs, envKey]);

  const q = useQuery<Resp>({
    queryKey: ["p", slug, "github-env", envKey],
    queryFn: () => api.get<Resp>(`/projects/${slug}/github-env?envKey=${encodeURIComponent(envKey)}`),
    enabled: !!envKey,
    staleTime: 30_000,
  });

  // Seed the draft from the server's saved assignment whenever it (re)loads,
  // but never clobber edits the user has already made.
  useEffect(() => {
    if (!q.data || dirty) return;
    setDraft(q.data.assignment ?? {});
  }, [q.data, dirty]);

  const services = q.data?.services ?? [];
  const vars = q.data?.vars ?? [];
  const options = useMemo(
    () => [
      { value: SHARED, label: "Shared — every service" },
      ...services.map((s) => ({ value: s.name, label: `${s.name}${s.role ? ` · ${s.role}` : ""}` })),
    ],
    [services],
  );

  const counts = useMemo(() => {
    const c: Record<string, number> = { [SHARED]: 0 };
    for (const s of services) c[s.name] = 0;
    for (const v of vars) {
      const target = draft[v.name] ?? SHARED;
      c[target] = (c[target] ?? 0) + 1;
    }
    return c;
  }, [vars, draft, services]);

  const save = useMutation({
    mutationFn: () =>
      api.post<{ ok: boolean; saved: number; message?: string }>(`/projects/${slug}/github-env`, {
        // Persist every listed name so a later "shared" choice is explicit
        // rather than an absence the prefix-fallback might reinterpret.
        assignment: Object.fromEntries(vars.map((v) => [v.name, draft[v.name] ?? SHARED])),
      }),
    onSuccess: (res) => {
      setError(null);
      setDirty(false);
      setSaved(res.message ?? `Saved ${res.saved} assignment(s).`);
      qc.invalidateQueries({ queryKey: ["p", slug, "github-env"] });
    },
    onError: (e) => setError(apiErrorMessage(e, "Could not save the assignment.")),
  });

  return (
    <Block>
      <Block.Header>
        <Block.Title
          sub={
            q.data
              ? `${q.data.repoFullName} · GitHub environment "${q.data.envKey}". Values stay in GitHub — this only records who receives them.`
              : "Reading the variables stored in GitHub…"
          }
        >
          <span className="row gap-2" style={{ alignItems: "center" }}>
            <Icon name="layers" size={16} /> Environment variables per service
          </span>
        </Block.Title>
        <Block.Actions>
          {(envs?.length ?? 0) > 1 && (
            <div style={{ minWidth: 150 }}>
              <Select
                value={envKey}
                onValueChange={(v) => {
                  setEnvKey(v);
                  setDirty(false);
                  setSaved(null);
                }}
                options={(envs ?? []).map((e) => ({ value: e.key, label: e.name || e.key }))}
                ariaLabel="Environment"
              />
            </div>
          )}
        </Block.Actions>
      </Block.Header>
      <Block.Body>
        {q.isLoading ? (
          <Block.Loading />
        ) : q.isError ? (
          <Block.Empty
            title="Couldn't read GitHub"
            description={apiErrorMessage(q.error, "The repo's GitHub token may not have Actions access.")}
          />
        ) : vars.length === 0 ? (
          <Block.Empty
            title="No variables in GitHub yet"
            description={`Add them under Settings → Environments → ${q.data?.envKey ?? "prod"} in ${q.data?.repoFullName ?? "the repo"} (Secrets for sensitive values, Variables for plain config), then reopen this.`}
          />
        ) : (
          <div className="col gap-3">
            <div className="row gap-2 wrap" style={{ alignItems: "center" }}>
              <Badge tone="default">{counts[SHARED] ?? 0} shared</Badge>
              {services.map((s) => (
                <Badge key={s.name} tone="accent">
                  {counts[s.name] ?? 0} → {s.name}
                </Badge>
              ))}
              {services.length === 0 && (
                <span className="muted" style={{ fontSize: 12 }}>
                  No services detected — run the repo analysis to split by service.
                </span>
              )}
            </div>

            <div className="col gap-2">
              {vars.map((v) => (
                <div
                  key={v.name}
                  className="row gap-3"
                  style={{
                    alignItems: "center",
                    border: "1px solid var(--border)",
                    borderRadius: 8,
                    padding: "8px 12px",
                    flexWrap: "wrap",
                  }}
                >
                  <span className="col" style={{ gap: 1, flex: 1, minWidth: 200 }}>
                    <b className="mono" style={{ fontSize: 12.5 }}>
                      {v.name}
                    </b>
                    <span className="muted" style={{ fontSize: 11 }}>
                      {v.kind === "secret" ? "🔒 secret" : "plain variable"}
                      {v.scope === "repository" ? " · repo-level" : ""}
                    </span>
                  </span>
                  <div style={{ minWidth: 210, flex: "none" }}>
                    <Select
                      value={draft[v.name] ?? SHARED}
                      onValueChange={(val) => {
                        setDirty(true);
                        setSaved(null);
                        setDraft((d) => ({ ...d, [v.name]: val }));
                      }}
                      options={options}
                      ariaLabel={`Which service receives ${v.name}`}
                    />
                  </div>
                </div>
              ))}
            </div>

            <div className="row gap-2" style={{ alignItems: "center", flexWrap: "wrap" }}>
              <Btn
                variant="primary"
                icon="check"
                loading={save.isPending}
                disabled={save.isPending || vars.length === 0}
                onClick={() => save.mutate()}
              >
                Save assignment
              </Btn>
              {saved && (
                <span style={{ fontSize: 12, color: "var(--ok, #30a46c)" }}>{saved}</span>
              )}
              {error && <span style={{ fontSize: 12, color: "var(--danger)" }}>{error}</span>}
            </div>

            <p className="faint" style={{ fontSize: 11.5, lineHeight: 1.5, margin: 0 }}>
              On the next deploy: shared values land in the <code>app-env</code> Secret that every
              pod reads; a service&apos;s own values land in <code>app-env-&lt;service&gt;</code>,
              wired only to that Deployment. A service-specific value overrides a shared one of the
              same name.
            </p>
            {(q.data?.warnings?.length ?? 0) > 0 && (
              <p className="faint" style={{ fontSize: 11 }}>
                {q.data!.warnings!.join("; ")}
              </p>
            )}
          </div>
        )}
      </Block.Body>
    </Block>
  );
}
