"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Badge, Block, Btn, Field, Input, Select, Textarea, Toggle } from "@/components/ui";
import { Icon } from "@/components/ui/Icon";
import { api } from "@/lib/api/client";
import {
  useClusterApiResources,
  useClusterApiVersions,
  useCommitManifest,
} from "@/hooks/queries/connectivity";
import {
  baseFields,
  generateManifest,
  getManifestKind,
  type ManifestField,
} from "@/lib/devops/manifest-templates";

type EnvRow = { id: string; key: string; name: string };
type RepoRow = { id: string; fullName: string; name: string; defaultBranch: string };

/**
 * Deterministic Kubernetes manifest builder. Pick an env → the cluster's live
 * apiVersions → a kind → fill production fields → preview the YAML → open a PR.
 * No LLM calls; the YAML is templated client-side for an instant preview.
 */
export function KubernetesManifestBuilder({ slug }: { slug: string }) {
  const { data: envs } = useQuery<EnvRow[]>({
    queryKey: ["p", slug, "envs"],
    queryFn: () => api.get<EnvRow[]>(`/projects/${slug}/envs`),
    staleTime: 60_000,
  });
  const { data: repos } = useQuery<RepoRow[]>({
    queryKey: ["p", slug, "repos"],
    queryFn: () => api.get<RepoRow[]>(`/projects/${slug}/repos`),
    staleTime: 60_000,
  });

  const [envKey, setEnvKey] = useState("");
  const [apiVersion, setApiVersion] = useState("");
  const [kind, setKind] = useState("");
  const [values, setValues] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!envKey && envs && envs.length > 0) setEnvKey(envs[0].key);
  }, [envs, envKey]);

  const versionsQ = useClusterApiVersions(slug, envKey, !!envKey);
  const resourcesQ = useClusterApiResources(slug, envKey, !!envKey);
  const commit = useCommitManifest(slug);

  const apiVersions = versionsQ.data?.apiVersions ?? [];
  const resources = resourcesQ.data?.resources ?? [];

  // Kinds available for the chosen apiVersion.
  const kindsForVersion = useMemo(
    () => resources.filter((r) => !apiVersion || r.apiVersion === apiVersion),
    [resources, apiVersion],
  );

  const namespaced = useMemo(() => {
    const r = resources.find((x) => x.kind === kind && (!apiVersion || x.apiVersion === apiVersion));
    if (r) return r.namespaced;
    return getManifestKind(kind)?.namespaced ?? true;
  }, [resources, kind, apiVersion]);

  const fields: ManifestField[] = useMemo(() => {
    if (!kind) return [];
    const tpl = getManifestKind(kind);
    return [...baseFields(namespaced), ...(tpl?.fields ?? [])];
  }, [kind, namespaced]);

  // Seed defaults whenever the field set changes (kind switch).
  useEffect(() => {
    if (!kind) return;
    setValues((prev) => {
      const next = { ...prev };
      for (const f of fields) if (next[f.name] === undefined && f.default !== undefined) next[f.name] = f.default;
      return next;
    });
  }, [kind, fields]);

  // The deterministic template output. The editable draft starts from this and
  // tracks field changes UNTIL the user hand-edits the YAML, after which their
  // edits are preserved (they can reset back to the template).
  const generated = useMemo(() => {
    if (!kind || !apiVersion) return "";
    return generateManifest(values, { apiVersion, kind, namespaced });
  }, [values, apiVersion, kind, namespaced]);

  const [yamlDraft, setYamlDraft] = useState("");
  const [yamlEdited, setYamlEdited] = useState(false);

  // Keep the draft in sync with the template while the user hasn't hand-edited.
  useEffect(() => {
    if (!yamlEdited) setYamlDraft(generated);
  }, [generated, yamlEdited]);

  const yaml = yamlDraft;

  // ── commit target (auto-suggested, editable) ────────────────────────
  const [repoFullName, setRepoFullName] = useState("");
  const [path, setPath] = useState("");
  const [branch, setBranch] = useState("");
  const [message, setMessage] = useState("");
  const [touched, setTouched] = useState<{ path?: boolean; branch?: boolean; message?: boolean }>({});
  const [result, setResult] = useState<{ ok: boolean; message: string; url?: string } | null>(null);

  useEffect(() => {
    if (!repoFullName && repos && repos.length > 0) setRepoFullName(repos[0].fullName);
  }, [repos, repoFullName]);

  const name = (values.name ?? "").trim();
  useEffect(() => {
    if (!kind || !name) return;
    const ns = (values.namespace ?? "default").trim();
    const k = kind.toLowerCase();
    if (!touched.path) setPath(`k8s/${namespaced ? ns + "/" : ""}${k}-${name}.yaml`);
    if (!touched.branch) setBranch(`manifest/${k}-${name}`);
    if (!touched.message) setMessage(`Add ${kind} ${name} manifest`);
  }, [kind, name, values.namespace, namespaced, touched]);

  // Required-field validation for the chosen kind.
  // When the YAML is hand-edited, trust it over the form's required-field check.
  const missing = yamlEdited ? [] : fields.filter((f) => f.required && !(values[f.name] ?? "").trim()).map((f) => f.label);
  const canCommit =
    !!repoFullName && !!path.trim() && !!branch.trim() && !!message.trim() && !!yaml.trim() && missing.length === 0 && !commit.isPending;

  async function runCommit() {
    setResult(null);
    try {
      const res = await commit.mutateAsync({
        repoFullName,
        path: path.trim(),
        content: yaml,
        branch: branch.trim(),
        message: message.trim(),
        pullRequestBody: `Generated ${kind} manifest (${apiVersion}) via the DeepAgent manifest builder.`,
      });
      setResult({
        ok: true,
        message: res.pullRequest ? `PR #${res.pullRequest.number} opened.` : "Committed.",
        url: res.pullRequest?.url,
      });
    } catch (e) {
      setResult({ ok: false, message: e instanceof Error ? e.message : "Commit failed." });
    }
  }

  function setVal(k: string, v: string) {
    setValues((p) => ({ ...p, [k]: v }));
  }

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Build a production-style manifest from your cluster's live apiVersions and kinds, then open a PR. No LLM — templated instantly.">
          <span className="row gap-2" style={{ alignItems: "center" }}>
            <Icon name="layers" size={16} /> Kubernetes manifest builder
          </span>
        </Block.Title>
      </Block.Header>

      <Block.Body>
      {!envs || envs.length === 0 ? (
        <span className="muted" style={{ fontSize: 13 }}>Create an environment first to target a cluster.</span>
      ) : (
        <div className="col gap-4">
          {/* Row: env + apiVersion + kind */}
          <div className="row gap-3 wrap">
            <div style={{ minWidth: 180 }}>
              <Field label="Environment" required hint="Cluster to read kinds from.">
                <Select value={envKey} onValueChange={(v) => { setEnvKey(v); }} ariaLabel="Environment"
                  options={envs.map((e) => ({ value: e.key, label: e.name || e.key }))} />
              </Field>
            </div>
            <div style={{ minWidth: 200 }}>
              <Field
                label="API version"
                required
                hint={versionsQ.data?.source === "builtin" ? "Built-in list (cluster not reachable)." : "Live from cluster."}
              >
                <Select
                  value={apiVersion}
                  onValueChange={(v) => { setApiVersion(v); setKind(""); setYamlEdited(false); }}
                  ariaLabel="API version"
                  options={[
                    { value: "", label: versionsQ.isLoading ? "Loading…" : "Select…" },
                    ...apiVersions.map((a) => ({ value: a, label: a })),
                  ]}
                />
              </Field>
            </div>
            <div style={{ minWidth: 200 }}>
              <Field
                label="Kind"
                required
                hint={resourcesQ.data?.source === "builtin" ? "Built-in list (cluster not reachable)." : "Live from cluster."}
              >
                <Select
                  value={kind}
                  onValueChange={(v) => { setKind(v); setResult(null); setYamlEdited(false); }}
                  ariaLabel="Kind"
                  options={[
                    { value: "", label: !apiVersion ? "Pick API version first" : resourcesQ.isLoading ? "Loading…" : "Select…" },
                    ...kindsForVersion.map((r) => ({ value: r.kind, label: r.kind })),
                  ]}
                />
              </Field>
            </div>
          </div>

          {/* Per-kind fields */}
          {kind && (
            <div className="col gap-3">
              <div className="row gap-2" style={{ alignItems: "center" }}>
                <Badge tone="info">{apiVersion}/{kind}</Badge>
                <Badge tone={namespaced ? "default" : "warn"}>{namespaced ? "namespaced" : "cluster-scoped"}</Badge>
                {!getManifestKind(kind) && (
                  <span className="faint" style={{ fontSize: 12 }}>No curated template — generating a minimal skeleton.</span>
                )}
              </div>
              <div className="row gap-3 wrap">
                {fields.map((f) => (
                  <div key={f.name} style={{ minWidth: f.type === "keyvalue" ? 360 : 220, flex: f.type === "keyvalue" ? "1 1 360px" : "0 1 240px" }}>
                    <ManifestFieldInput field={f} value={values[f.name] ?? ""} onChange={(v) => setVal(f.name, v)} />
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Editable YAML — starts from the template, fully editable before commit */}
          {(generated || yaml) && (
            <Field
              label="Manifest (editable)"
              hint={
                yamlEdited
                  ? "You've edited the YAML — field changes above won't overwrite it. Reset to re-sync."
                  : "Production-style YAML. Edit it freely; it commits exactly as shown."
              }
            >
              <div className="col gap-2">
                <Textarea
                  className="mono"
                  rows={18}
                  value={yaml}
                  spellCheck={false}
                  onChange={(e) => { setYamlDraft(e.target.value); setYamlEdited(true); }}
                  style={{ fontSize: 12, lineHeight: 1.5, whiteSpace: "pre", overflowWrap: "normal", overflowX: "auto" }}
                />
                {yamlEdited && (
                  <div className="row gap-2" style={{ alignItems: "center" }}>
                    <Btn
                      variant="ghost"
                      size="sm"
                      icon="refresh"
                      onClick={() => { setYamlEdited(false); setYamlDraft(generated); }}
                    >
                      Reset to template
                    </Btn>
                    <span className="faint" style={{ fontSize: 11.5 }}>Discards your manual edits.</span>
                  </div>
                )}
              </div>
            </Field>
          )}

          {/* Commit target */}
          {yaml && (
            <div className="col gap-3" style={{ borderTop: "1px solid var(--border)", paddingTop: 16 }}>
              <span className="text-sm" style={{ fontWeight: 600 }}>Commit &amp; open PR</span>
              {!repos || repos.length === 0 ? (
                <span className="muted" style={{ fontSize: 13 }}>Attach a repo to this project first (CI/CD &amp; Repos tab).</span>
              ) : (
                <>
                  <div className="row gap-3 wrap">
                    <div style={{ minWidth: 240 }}>
                      <Field label="Repository" required>
                        <Select value={repoFullName} onValueChange={setRepoFullName} ariaLabel="Repository"
                          options={repos.map((r) => ({ value: r.fullName, label: r.fullName }))} />
                      </Field>
                    </div>
                    <div style={{ minWidth: 240, flex: "1 1 280px" }}>
                      <Field label="File path" required>
                        <Input className="mono" value={path}
                          onChange={(e) => { setPath(e.target.value); setTouched((t) => ({ ...t, path: true })); }} />
                      </Field>
                    </div>
                  </div>
                  <div className="row gap-3 wrap">
                    <div style={{ minWidth: 240 }}>
                      <Field label="Branch" required hint="Created from the default branch.">
                        <Input className="mono" value={branch}
                          onChange={(e) => { setBranch(e.target.value); setTouched((t) => ({ ...t, branch: true })); }} />
                      </Field>
                    </div>
                    <div style={{ minWidth: 240, flex: "1 1 280px" }}>
                      <Field label="Commit message" required>
                        <Input value={message}
                          onChange={(e) => { setMessage(e.target.value); setTouched((t) => ({ ...t, message: true })); }} />
                      </Field>
                    </div>
                  </div>
                  {missing.length > 0 && (
                    <span style={{ fontSize: 12.5, color: "var(--warn, #b8860b)" }}>
                      Fill required field{missing.length > 1 ? "s" : ""}: {missing.join(", ")}.
                    </span>
                  )}
                  <div className="row gap-2" style={{ alignItems: "center" }}>
                    <Btn variant="primary" icon="github" loading={commit.isPending} disabled={!canCommit} onClick={runCommit}>
                      {commit.isPending ? "Opening PR…" : "Commit & open PR"}
                    </Btn>
                    {result && (
                      <span style={{ fontSize: 13, color: result.ok ? "var(--ok)" : "var(--danger)" }}>
                        {result.ok ? "✓ " : "✗ "}{result.message}{" "}
                        {result.url && (
                          <a href={result.url} target="_blank" rel="noreferrer" style={{ color: "var(--accent)" }}>View PR</a>
                        )}
                      </span>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      )}
      </Block.Body>
    </Block>
  );
}

function ManifestFieldInput({
  field,
  value,
  onChange,
}: {
  field: ManifestField;
  value: string;
  onChange: (v: string) => void;
}) {
  if (field.type === "select") {
    return (
      <Field label={field.label} required={field.required} hint={field.hint}>
        <Select
          value={value || field.default || ""}
          onValueChange={onChange}
          ariaLabel={field.label}
          options={(field.options ?? []).map((o) => ({ value: o, label: o }))}
        />
      </Field>
    );
  }
  if (field.type === "toggle") {
    return (
      <Field label={field.label} hint={field.hint}>
        <Toggle checked={(value || field.default) !== "false"} onCheckedChange={(c) => onChange(c ? "true" : "false")} ariaLabel={field.label} />
      </Field>
    );
  }
  if (field.type === "keyvalue") {
    return (
      <Field label={field.label} hint={field.hint ?? "One KEY=VALUE per line"}>
        <Textarea rows={3} className="mono" value={value} onChange={(e) => onChange(e.target.value)} placeholder={"KEY=value\nANOTHER=value"} />
      </Field>
    );
  }
  return (
    <Field label={field.label} required={field.required} hint={field.hint}>
      <Input
        type={field.type === "number" ? "number" : "text"}
        className={field.name === "image" ? "mono" : undefined}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={field.placeholder ?? field.default}
      />
    </Field>
  );
}
