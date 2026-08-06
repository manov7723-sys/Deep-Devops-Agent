"use client";

/**
 * Env viewer — shows a namespace's application config the way a developer
 * already knows how to read it: as `.env` files in a VS Code-style explorer +
 * editor pane. One file per ConfigMap, per Secret, and per workload container
 * (with envFrom imports resolved inline).
 *
 * Shares its backend with the `show_namespace_env` agent tool, so the tab and
 * the chat agent always agree on masking and on what "the env" means.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { useQuery } from "@tanstack/react-query";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import { oneDark } from "react-syntax-highlighter/dist/esm/styles/prism";
import { Block, Btn, Field, Icon, Input, Modal, PageHead, Select } from "@/components/ui";
import { api, apiErrorMessage } from "@/lib/api/client";
import { useActiveEnv } from "@/hooks/useActiveEnv";

type EnvRow = { key: string; namespace?: string | null };
type NamespacesResp = { ok: true; namespaces: string[] } | { ok: false; message: string };
type EnvFile = {
  id: string;
  name: string;
  origin: string;
  kind: "ConfigMap" | "Secret" | "Container";
  keyCount: number;
  content: string;
};
type ViewerResp =
  | { ok: true; namespace: string; envKey: string; files: EnvFile[]; message: string }
  | { ok: false; message: string };

/** Explorer groups, in the order a user cares about them. */
const GROUPS: Array<{ kind: EnvFile["kind"]; label: string; icon: "box" | "layers" | "shield" }> = [
  { kind: "Container", label: "Containers", icon: "box" },
  { kind: "ConfigMap", label: "ConfigMaps", icon: "layers" },
  { kind: "Secret", label: "Secrets", icon: "shield" },
];

export function EnvViewerClient({ slug }: { slug: string }) {
  const router = useRouter();
  const projectActiveEnv = useActiveEnv(slug);
  const [envKey, setEnvKey] = useState("");
  const [namespace, setNamespace] = useState("");
  const [nameFilter, setNameFilter] = useState("");
  const [applied, setApplied] = useState<{
    env: string;
    ns: string;
    filter: string;
    reveal: boolean;
  } | null>(null);
  const [reveal, setReveal] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // Step-up ("sudo") prompt — opened when the reveal request comes back with
  // code: "step_up_required".
  const [stepUpOpen, setStepUpOpen] = useState(false);
  const [stepUpValue, setStepUpValue] = useState("");
  const [stepUpErr, setStepUpErr] = useState<string | null>(null);
  const [stepUpBusy, setStepUpBusy] = useState(false);
  // In-memory only — never localStorage/sessionStorage/cookie. Lost on reload,
  // which is intended: a reload means re-authenticating, and nothing on disk
  // can be lifted later to replay an elevation.
  const revealTokenRef = useRef<string | null>(null);

  const envs = useQuery<EnvRow[]>({
    queryKey: ["p", slug, "envs"],
    queryFn: () => api.get<EnvRow[]>(`/projects/${slug}/envs`),
    staleTime: 60_000,
  });

  const effEnv = envKey || projectActiveEnv || "";

  const nsQuery = useQuery<NamespacesResp>({
    queryKey: ["p", slug, "envs", effEnv, "namespaces"],
    queryFn: () =>
      api.get<NamespacesResp>(
        `/projects/${slug}/envs/${encodeURIComponent(effEnv)}/logs/namespaces`,
      ),
    enabled: !!effEnv,
    staleTime: 60_000,
  });
  const namespaces = useMemo(
    () => (nsQuery.data?.ok ? nsQuery.data.namespaces : []),
    [nsQuery.data],
  );

  // Seed the namespace once the list arrives — prefer the env's own default.
  useEffect(() => {
    if (namespace || namespaces.length === 0) return;
    const envRow = envs.data?.find((e) => e.key === effEnv);
    setNamespace(
      envRow?.namespace && namespaces.includes(envRow.namespace)
        ? envRow.namespace
        : namespaces.includes("default")
          ? "default"
          : namespaces[0],
    );
  }, [namespace, namespaces, envs.data, effEnv]);

  const viewer = useQuery<ViewerResp>({
    queryKey: [
      "p",
      slug,
      "namespace-env",
      applied?.env,
      applied?.ns,
      applied?.filter,
      applied?.reveal,
    ],
    queryFn: () => {
      const qs = new URLSearchParams({ namespace: applied!.ns });
      if (applied!.filter) qs.set("nameFilter", applied!.filter);
      if (applied!.reveal) qs.set("reveal", "true");
      return api.get<ViewerResp>(
        `/projects/${slug}/envs/${encodeURIComponent(applied!.env)}/namespace-env?${qs}`,
        undefined,
        // Memory-only proof that this request came from the page that actually
        // passed the step-up. Deliberately NOT a cookie: a URL copied out of
        // devtools carries cookies automatically but never this header.
        applied!.reveal && revealTokenRef.current
          ? { "X-Reveal-Token": revealTokenRef.current }
          : undefined,
      );
    },
    enabled: !!applied,
    // Cluster state changes out from under us (a deploy, a `kubectl set env`,
    // a Secret edit). The app-wide 30s staleTime would serve a cached answer
    // and make a just-added variable look missing — always re-read the cluster.
    staleTime: 0,
  });

  const files = useMemo(
    () => (viewer.data?.ok ? viewer.data.files : []),
    [viewer.data],
  );

  // Open the first container file (the one users actually want) on each load.
  useEffect(() => {
    if (files.length === 0) {
      setOpenId(null);
      return;
    }
    if (openId && files.some((f) => f.id === openId)) return;
    setOpenId((files.find((f) => f.kind === "Container") ?? files[0]).id);
  }, [files, openId]);

  const open = files.find((f) => f.id === openId) ?? null;

  const canView = !!effEnv && !!namespace;
  const run = (revealOverride?: boolean) => {
    if (!canView) return;
    const nextReveal = revealOverride ?? reveal;
    const next = { env: effEnv, ns: namespace, filter: nameFilter.trim(), reveal: nextReveal };
    const unchanged =
      applied?.env === next.env &&
      applied?.ns === next.ns &&
      applied?.filter === next.filter &&
      applied?.reveal === next.reveal;
    setApplied(next);
    // Same params → same query key → React Query won't refire on its own.
    // Clicking View is an explicit "re-read the cluster", so force it.
    if (unchanged) void viewer.refetch();
  };

  // Which factor to prompt for. Fetched lazily — the app has users both with
  // and without 2FA, and the modal must not guess.
  const challenge = useQuery<{ ok: boolean; elevated: boolean; factor: "totp" | "setup_required" }>({
    queryKey: ["auth", "step-up"],
    queryFn: () => api.get("/auth/step-up"),
    enabled: stepUpOpen,
    staleTime: 0,
  });
  const factor = challenge.data?.factor ?? "totp";
  const needsEnrolment = factor === "setup_required";

  // The client throws ApiRequestError with the raw body in `details`; the
  // server's machine-readable `code` lives in there.
  const errCode = (() => {
    const d = (viewer.error as { details?: unknown } | null)?.details;
    if (typeof d !== "string") return null;
    try {
      return (JSON.parse(d) as { code?: string }).code ?? null;
    } catch {
      return null;
    }
  })();
  const needsStepUp = errCode === "step_up_required";

  // Reveal was refused for lack of elevation → prompt instead of showing a
  // raw error, and roll the toggle back so the button doesn't lie.
  useEffect(() => {
    if (needsStepUp && !stepUpOpen) {
      setStepUpOpen(true);
      setReveal(false);
    }
  }, [needsStepUp, stepUpOpen]);

  async function submitStepUp() {
    setStepUpBusy(true);
    setStepUpErr(null);
    try {
      const res = await api.post<{ ok: boolean; revealToken?: string }>("/auth/step-up", {
        code: stepUpValue.trim(),
      });
      revealTokenRef.current = res.revealToken ?? null;
      setStepUpOpen(false);
      setStepUpValue("");
      setReveal(true);
      run(true); // retry the reveal now that the session is elevated
    } catch (e) {
      setStepUpErr(apiErrorMessage(e, "Could not confirm your identity."));
    } finally {
      setStepUpBusy(false);
    }
  }

  const errorMsg = needsStepUp
    ? null
    : viewer.error
      ? apiErrorMessage(viewer.error)
      : viewer.data && !viewer.data.ok
        ? viewer.data.message
        : null;

  const copy = () => {
    if (!open) return;
    void navigator.clipboard.writeText(open.content).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <>
      <Modal
        open={stepUpOpen}
        onOpenChange={(o) => {
          setStepUpOpen(o);
          if (!o) {
            setStepUpValue("");
            setStepUpErr(null);
          }
        }}
        title={needsEnrolment ? "Two-factor authentication required" : "Confirm your identity"}
        description={
          needsEnrolment
            ? "Secret values are protected by your authenticator app. Set up two-factor authentication to unlock them."
            : "Enter the 6-digit code from your authenticator app — the same one you use to sign in. Values stay unlocked for 5 minutes."
        }
        width={420}
        footer={
          <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
            <Btn variant="ghost" onClick={() => setStepUpOpen(false)}>
              Cancel
            </Btn>
            {needsEnrolment ? (
              <Btn variant="primary" onClick={() => router.push("/account/2fa-manage")}>
                Set up 2FA
              </Btn>
            ) : (
              <Btn
                variant="primary"
                loading={stepUpBusy}
                disabled={stepUpValue.trim().length === 0}
                onClick={() => void submitStepUp()}
              >
                Confirm
              </Btn>
            )}
          </div>
        }
      >
        {needsEnrolment ? (
          <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>
            Your account password is deliberately <strong>not</strong> accepted here — it&rsquo;s the
            credential most likely to be saved in a browser or reused elsewhere. Revealing
            credentials requires proving you hold the authenticator.
          </p>
        ) : (
          <Field
            label="Authenticator code"
            hint="Lost your authenticator? A backup code (XXXX-XXXX) works too."
            error={stepUpErr ?? undefined}
          >
            <Input
              autoFocus
              type="text"
              inputMode="numeric"
              autoComplete="one-time-code"
              placeholder="123456"
              value={stepUpValue}
              onChange={(e) => setStepUpValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && stepUpValue.trim()) void submitStepUp();
              }}
            />
          </Field>
        )}
      </Modal>

      <PageHead
        title="Env viewer"
        sub="Your namespace's config as .env files — one per container (envFrom resolved), ConfigMap, and Secret. Secret values are always masked."
      />

      <Block>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr auto",
            gap: 12,
            alignItems: "end",
          }}
        >
          <Field label="Environment">
            <Select
              value={envKey}
              placeholder={envs.isLoading ? "loading…" : "Select an env"}
              options={(envs.data ?? []).map((e) => ({ value: e.key, label: e.key }))}
              onValueChange={(v) => {
                setEnvKey(v);
                setNamespace("");
                setApplied(null);
              }}
            />
          </Field>
          <Field label="Namespace">
            <Select
              value={namespace}
              disabled={!effEnv || nsQuery.isLoading}
              placeholder={nsQuery.isLoading ? "loading…" : "Select a namespace"}
              options={namespaces.map((n) => ({ value: n, label: n }))}
              onValueChange={setNamespace}
            />
          </Field>
          <Field label="Name filter (optional)">
            <Input
              type="text"
              placeholder="e.g. redis, backend"
              value={nameFilter}
              onChange={(e) => setNameFilter(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") run();
              }}
            />
          </Field>
          <Btn
            variant="primary"
            disabled={!canView}
            loading={viewer.isFetching}
            onClick={() => run()}
          >
            View
          </Btn>
        </div>
        {nsQuery.data && !nsQuery.data.ok && (
          <p style={{ marginTop: 10, marginBottom: 0, color: "var(--danger)", fontSize: 13 }}>
            Could not load namespaces: {nsQuery.data.message}
          </p>
        )}
      </Block>

      {!applied && (
        <Block>
          <p style={{ opacity: 0.75, margin: 0 }}>
            Pick an environment and namespace, then hit <strong>View</strong>. You&rsquo;ll get one{" "}
            <code>.env</code> file per container &mdash; with every <code>envFrom</code> Secret and
            ConfigMap expanded into real <code>KEY=value</code> lines.
          </p>
        </Block>
      )}

      {applied && errorMsg && (
        <Block>
          <p style={{ margin: 0, color: "var(--danger)" }}>
            <strong>
              Failed to load env for <code>{applied.ns}</code>
            </strong>
            : {errorMsg}
          </p>
        </Block>
      )}

      {applied && viewer.data?.ok && files.length === 0 && (
        <Block>
          <p style={{ margin: 0, opacity: 0.75 }}>{viewer.data.message}</p>
        </Block>
      )}

      {applied && viewer.data?.ok && files.length > 0 && (
        <Block>
          <p style={{ marginTop: 0, opacity: 0.7, fontSize: 13 }}>{viewer.data.message}</p>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "minmax(200px, 260px) 1fr",
              border: "1px solid var(--border)",
              borderRadius: 10,
              overflow: "hidden",
              minHeight: 420,
            }}
          >
            {/* ── Explorer ─────────────────────────────────────────── */}
            <aside
              style={{
                background: "var(--surface-2)",
                borderRight: "1px solid var(--border)",
                padding: "10px 0",
                overflowY: "auto",
                maxHeight: 640,
              }}
            >
              {GROUPS.map((g) => {
                const groupFiles = files.filter((f) => f.kind === g.kind);
                if (groupFiles.length === 0) return null;
                return (
                  <div key={g.kind} style={{ marginBottom: 10 }}>
                    <div
                      style={{
                        padding: "4px 12px",
                        fontSize: 11,
                        fontWeight: 700,
                        letterSpacing: 0.6,
                        textTransform: "uppercase",
                        opacity: 0.55,
                      }}
                    >
                      {g.label} ({groupFiles.length})
                    </div>
                    {groupFiles.map((f) => {
                      const active = f.id === openId;
                      return (
                        <button
                          key={f.id}
                          onClick={() => setOpenId(f.id)}
                          title={`${f.origin} · ${f.keyCount} key(s)`}
                          style={{
                            display: "flex",
                            alignItems: "center",
                            gap: 8,
                            width: "100%",
                            border: "none",
                            textAlign: "left",
                            padding: "7px 12px",
                            cursor: "pointer",
                            background: active ? "var(--accent-soft, rgba(120,120,255,.14))" : "transparent",
                            borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
                            color: "inherit",
                            font: "inherit",
                          }}
                        >
                          <Icon name={g.icon} size={13} />
                          <span
                            className="mono"
                            style={{
                              fontSize: 12.5,
                              fontWeight: active ? 700 : 500,
                              overflow: "hidden",
                              textOverflow: "ellipsis",
                              whiteSpace: "nowrap",
                            }}
                          >
                            {f.name}
                          </span>
                          <span style={{ marginLeft: "auto", fontSize: 11, opacity: 0.5 }}>
                            {f.keyCount}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                );
              })}
            </aside>

            {/* ── Editor pane ──────────────────────────────────────── */}
            <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              {open && (
                <>
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: 10,
                      padding: "8px 12px",
                      borderBottom: "1px solid var(--border)",
                      background: "var(--surface-2)",
                    }}
                  >
                    <span className="mono" style={{ fontSize: 12.5, fontWeight: 700 }}>
                      {open.name}
                    </span>
                    <span style={{ fontSize: 12, opacity: 0.6 }}>
                      {open.origin} · {open.keyCount} key(s)
                    </span>
                    <Btn
                      size="sm"
                      variant={applied.reveal ? "danger" : "outline"}
                      style={{ marginLeft: "auto" }}
                      loading={viewer.isFetching}
                      onClick={() => {
                        const next = !applied.reveal;
                        setReveal(next);
                        // Hiding drops the elevation too, so "Hide" actually
                        // re-locks rather than just repainting the pane. The
                        // 5-minute window would expire anyway; this makes the
                        // button mean what it says.
                        if (!next) {
                          revealTokenRef.current = null;
                          void api.del("/auth/step-up").catch(() => {});
                        }
                        run(next);
                      }}
                    >
                      {applied.reveal ? "Hide values" : "Reveal values"}
                    </Btn>
                    <Btn size="sm" variant="ghost" onClick={copy}>
                      {copied ? "Copied" : "Copy"}
                    </Btn>
                  </div>
                  <div style={{ overflow: "auto", maxHeight: 596 }}>
                    <SyntaxHighlighter
                      language="ini"
                      style={oneDark}
                      showLineNumbers
                      wrapLongLines
                      customStyle={{
                        margin: 0,
                        borderRadius: 0,
                        fontSize: 12.5,
                        background: "transparent",
                      }}
                    >
                      {open.content}
                    </SyntaxHighlighter>
                  </div>
                </>
              )}
            </div>
          </div>
        </Block>
      )}
    </>
  );
}
