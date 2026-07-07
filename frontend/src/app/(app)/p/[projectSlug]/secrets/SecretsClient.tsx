"use client";

/**
 * Secrets manager — store app secrets (encrypted) and sync them to a cluster as
 * a Kubernetes Secret, so apps get them at runtime without plaintext in Git.
 * Values are never shown back (write-only); you can overwrite or delete.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Block, Btn, Field, Input, PageHead, Select } from "@/components/ui";
import { api, apiErrorMessage } from "@/lib/api/client";
import { useProjectEnvs } from "@/hooks/queries/project";

type SecretKey = { key: string; updatedAt: string };
type ListResp = { ok: true; secrets: SecretKey[] };

export function SecretsClient({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [envKey, setEnvKey] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const { data: envs } = useProjectEnvs(slug);
  const envList = (envs ?? []) as unknown as Array<{ key: string; name: string }>;
  useEffect(() => {
    if (!envKey && envList.length) setEnvKey(envList[0].key);
  }, [envList, envKey]);

  const q = useQuery<ListResp>({ queryKey: ["p", slug, "secrets"], queryFn: () => api.get<ListResp>(`/projects/${slug}/secrets`) });
  const secrets = q.data?.secrets ?? [];
  const invalidate = () => qc.invalidateQueries({ queryKey: ["p", slug, "secrets"] });

  const save = useMutation({
    mutationFn: () => api.put(`/projects/${slug}/secrets`, { key: key.trim(), value }),
    onMutate: () => { setErr(null); setMsg(null); },
    onSuccess: () => { setMsg(`Saved ${key.trim()}.`); setKey(""); setValue(""); invalidate(); },
    onError: (e) => setErr(apiErrorMessage(e)),
  });
  const del = useMutation({
    mutationFn: (k: string) => api.del(`/projects/${slug}/secrets?key=${encodeURIComponent(k)}`),
    onSuccess: invalidate,
    onError: (e) => setErr(apiErrorMessage(e)),
  });
  const sync = useMutation({
    mutationFn: () => api.post<{ ok: boolean; count: number; namespace: string }>(`/projects/${slug}/secrets/sync`, { envKey }),
    onMutate: () => { setErr(null); setMsg(null); },
    onSuccess: (r) => setMsg(`Synced ${r.count} secret${r.count === 1 ? "" : "s"} to the ${envKey} cluster (namespace ${r.namespace}, Secret "deepagent-app-secrets").`),
    onError: (e) => setErr(apiErrorMessage(e)),
  });

  return (
    <div className="col gap-5">
      <PageHead
        title="Secrets"
        sub="Store app secrets encrypted, then sync them to your cluster as a Kubernetes Secret — no plaintext in Git."
      />

      {msg && <Badge tone="ok" icon="check">{msg}</Badge>}
      {err && <Badge tone="danger" icon="alert">{err}</Badge>}

      {/* Add / update */}
      <Block>
        <Block.Header><Block.Title sub="Add or overwrite a secret. Values are encrypted and never shown again.">New secret</Block.Title></Block.Header>
        <Block.Body>
          <div className="row gap-3 wrap" style={{ alignItems: "flex-end" }}>
            <div style={{ minWidth: 200 }}>
              <Field label="Key" hint="e.g. DATABASE_URL"><Input value={key} placeholder="DATABASE_URL" onChange={(e) => setKey(e.target.value)} /></Field>
            </div>
            <div style={{ minWidth: 280, flex: 1 }}>
              <Field label="Value"><Input type="password" value={value} placeholder="••••••••" onChange={(e) => setValue(e.target.value)} /></Field>
            </div>
            <Btn variant="primary" icon="plus" loading={save.isPending} disabled={!key.trim() || !value || save.isPending} onClick={() => save.mutate()}>Save secret</Btn>
          </div>
        </Block.Body>
      </Block>

      {/* Existing keys */}
      <Block>
        <Block.Header>
          <Block.Title sub="Sync pushes ALL of these to the selected cluster as one Kubernetes Secret ('deepagent-app-secrets').">
            Stored secrets
          </Block.Title>
          <Block.Actions>
            <span className="row gap-2" style={{ alignItems: "center" }}>
              <div style={{ minWidth: 160 }}>
                <Select value={envKey} onValueChange={setEnvKey} ariaLabel="Environment" options={envList.map((e) => ({ value: e.key, label: e.name || e.key }))} />
              </div>
              <Btn variant="outline" icon="cloud" loading={sync.isPending} disabled={!envKey || secrets.length === 0 || sync.isPending} onClick={() => sync.mutate()}>
                Sync to cluster
              </Btn>
            </span>
          </Block.Actions>
        </Block.Header>
        <Block.Body>
          {secrets.length === 0 ? (
            <span className="muted" style={{ fontSize: 13 }}>No secrets yet. Add one above.</span>
          ) : (
            <div className="col gap-1">
              {secrets.map((s) => (
                <div key={s.key} className="row between" style={{ padding: "8px 0", borderTop: "1px solid var(--border)", alignItems: "center" }}>
                  <span className="row gap-3" style={{ alignItems: "center", minWidth: 0 }}>
                    <span className="mono" style={{ fontWeight: 600, fontSize: 13 }}>{s.key}</span>
                    <span className="mono faint">••••••••</span>
                  </span>
                  <span className="row gap-3" style={{ alignItems: "center" }}>
                    <span className="muted" style={{ fontSize: 11.5 }}>updated {new Date(s.updatedAt).toLocaleDateString()}</span>
                    <Btn variant="ghost" size="sm" icon="trash" loading={del.isPending} onClick={() => del.mutate(s.key)} aria-label={`Delete ${s.key}`} />
                  </span>
                </div>
              ))}
            </div>
          )}
        </Block.Body>
      </Block>

      <p className="faint" style={{ fontSize: 12 }}>
        Apps consume these by referencing the Secret in their Deployment:{" "}
        <code>envFrom: [{`{ secretRef: { name: deepagent-app-secrets } }`}]</code>.
      </p>
    </div>
  );
}
