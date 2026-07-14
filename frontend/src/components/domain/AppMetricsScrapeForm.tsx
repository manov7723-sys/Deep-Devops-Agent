"use client";

/**
 * Create a ServiceMonitor / PodMonitor so the in-cluster Prometheus scrapes the
 * app's OWN /metrics endpoint (request rate, latency, custom metrics) — not just
 * pod resource usage. The app must already expose Prometheus-format metrics.
 *
 * Backed by POST /projects/[slug]/envs/[key]/monitoring/scrape.
 */
import { useState } from "react";
import { useMutation } from "@tanstack/react-query";
import { Block, Btn, Field, Input, Select } from "@/components/ui";
import { api, apiErrorMessage } from "@/lib/api/client";

type Result = { ok: boolean; message?: string };
type Candidate = {
  kind: "ServiceMonitor" | "PodMonitor";
  target: string;
  selectorKey: string;
  selectorValue: string;
  port: string;
  path: string;
  hint: string;
};

export function AppMetricsScrapeForm({
  slug,
  envKey,
  defaultNamespace,
}: {
  slug: string;
  envKey: string;
  defaultNamespace: string;
}) {
  const [kind, setKind] = useState<"ServiceMonitor" | "PodMonitor">("ServiceMonitor");
  const [name, setName] = useState("");
  const [namespace, setNamespace] = useState(defaultNamespace);
  const [selectorKey, setSelectorKey] = useState("app");
  const [selectorValue, setSelectorValue] = useState("");
  const [port, setPort] = useState("metrics");
  const [path, setPath] = useState("/metrics");
  const [interval, setInterval] = useState("30s");
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: () =>
      api.post<Result>(`/projects/${slug}/envs/${envKey}/monitoring/scrape`, {
        kind,
        name: name.trim() || selectorValue.trim(),
        namespace: namespace.trim(),
        selectorKey: selectorKey.trim(),
        selectorValue: selectorValue.trim(),
        port: port.trim(),
        path: path.trim(),
        interval: interval.trim(),
      }),
    onMutate: () => {
      setError(null);
      setResult(null);
    },
    onSuccess: (res) => setResult(res),
    onError: (e) => setError(apiErrorMessage(e, "Failed to create scrape target.")),
  });

  const detect = useMutation({
    mutationFn: () =>
      api.get<{ ok: boolean; candidates?: Candidate[]; message?: string }>(
        `/projects/${slug}/envs/${envKey}/monitoring/scrape`,
        {
          namespace: namespace.trim(),
        },
      ),
    onMutate: () => setError(null),
    onError: (e) => setError(apiErrorMessage(e, "Detect failed.")),
  });

  // One-click: deploy a demo app that exposes /metrics + wire its ServiceMonitor.
  const demo = useMutation({
    mutationFn: () =>
      api.post<Result>(`/projects/${slug}/envs/${envKey}/monitoring/demo-app`, {
        namespace: namespace.trim(),
      }),
    onMutate: () => {
      setError(null);
      setResult(null);
    },
    onSuccess: (res) => setResult(res),
    onError: (e) => setError(apiErrorMessage(e, "Demo app deploy failed.")),
  });

  // Send test traffic so request-rate/latency cards have data (defaults to the demo app).
  const traffic = useMutation({
    mutationFn: () =>
      api.post<Result>(`/projects/${slug}/envs/${envKey}/monitoring/demo-traffic`, {
        namespace: namespace.trim(),
      }),
    onMutate: () => {
      setError(null);
      setResult(null);
    },
    onSuccess: (res) => setResult(res),
    onError: (e) => setError(apiErrorMessage(e, "Send traffic failed.")),
  });

  function fill(c: Candidate) {
    setKind(c.kind);
    setName(c.selectorValue);
    setSelectorKey(c.selectorKey);
    setSelectorValue(c.selectorValue);
    setPort(c.port);
    setPath(c.path);
  }

  const ready = selectorValue.trim() && namespace.trim() && port.trim();

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Scrape your app's own /metrics (request rate, latency, custom metrics). The app must expose Prometheus metrics.">
          Scrape app metrics
        </Block.Title>
      </Block.Header>
      <Block.Body>
        <div className="col gap-3" style={{ maxWidth: 760 }}>
          <div className="row gap-3 wrap">
            <Field label="Type">
              <div style={{ minWidth: 170 }}>
                <Select
                  ariaLabel="Monitor type"
                  value={kind}
                  options={[
                    { value: "ServiceMonitor", label: "ServiceMonitor (via Service)" },
                    { value: "PodMonitor", label: "PodMonitor (via pods)" },
                  ]}
                  onValueChange={(v) => setKind(v as "ServiceMonitor" | "PodMonitor")}
                />
              </div>
            </Field>
            <Field label="Namespace">
              <div className="row gap-2" style={{ alignItems: "center" }}>
                <Input
                  value={namespace}
                  placeholder="dev"
                  onChange={(e) => setNamespace(e.target.value)}
                />
                <Btn
                  variant="outline"
                  icon="search"
                  loading={detect.isPending}
                  disabled={!namespace.trim()}
                  onClick={() => detect.mutate()}
                >
                  Detect
                </Btn>
              </div>
            </Field>
          </div>

          {/* Auto-detected candidates — click one to fill the form. */}
          {detect.data?.ok &&
            ((detect.data.candidates ?? []).length === 0 ? (
              <span className="muted" style={{ fontSize: 12.5 }}>
                No services with an obvious metrics port found in <b>{namespace}</b>. Fill the
                fields manually, or check the app exposes /metrics.
              </span>
            ) : (
              <div className="col gap-1">
                <span className="faint" style={{ fontSize: 11.5 }}>
                  Detected — click to use:
                </span>
                <div className="row gap-2 wrap">
                  {(detect.data.candidates ?? []).map((c) => (
                    <button
                      key={`${c.kind}/${c.target}`}
                      type="button"
                      className="chip"
                      onClick={() => fill(c)}
                      title={c.hint}
                    >
                      {c.target} · {c.selectorKey}={c.selectorValue} · :{c.port}
                      <span className="faint" style={{ fontSize: 11 }}>
                        {" "}
                        · {c.kind === "PodMonitor" ? "PodMonitor" : "ServiceMonitor"} · {c.hint}
                      </span>
                    </button>
                  ))}
                </div>
              </div>
            ))}

          <div className="row gap-3 wrap">
            <Field
              label="Selector label key"
              hint={
                kind === "ServiceMonitor"
                  ? "Matches the Service's label"
                  : "Matches the pods' label"
              }
            >
              <Input
                value={selectorKey}
                placeholder="app"
                onChange={(e) => setSelectorKey(e.target.value)}
              />
            </Field>
            <Field label="Selector value">
              <Input
                value={selectorValue}
                placeholder="vote"
                onChange={(e) => setSelectorValue(e.target.value)}
              />
            </Field>
          </div>

          <div className="row gap-3 wrap">
            <Field label="Metrics port" hint="Named port (metrics) or a number (8080)">
              <Input value={port} placeholder="metrics" onChange={(e) => setPort(e.target.value)} />
            </Field>
            <Field label="Path">
              <Input
                value={path}
                placeholder="/metrics"
                onChange={(e) => setPath(e.target.value)}
              />
            </Field>
            <Field label="Interval">
              <Input
                value={interval}
                placeholder="30s"
                onChange={(e) => setInterval(e.target.value)}
              />
            </Field>
          </div>

          <div className="row gap-2 wrap" style={{ alignItems: "center" }}>
            <Btn
              variant="primary"
              icon="plus"
              loading={create.isPending}
              disabled={!ready}
              onClick={() => create.mutate()}
            >
              Create {kind}
            </Btn>
            <span className="faint" style={{ fontSize: 12 }}>
              or
            </span>
            <Btn
              variant="outline"
              icon="rocket"
              loading={demo.isPending}
              onClick={() => demo.mutate()}
            >
              Deploy demo metrics app
            </Btn>
            <Btn
              variant="outline"
              icon="send"
              loading={traffic.isPending}
              onClick={() => traffic.mutate()}
            >
              Send test traffic
            </Btn>
          </div>
          <span className="faint" style={{ fontSize: 11.5 }}>
            Deploy demo = a sample app exposing /metrics + its ServiceMonitor. Send test traffic =
            make request-rate/latency cards show data.
          </span>

          {error && (
            <span style={{ color: "var(--danger, #e5484d)", fontSize: 12.5 }}>❌ {error}</span>
          )}
          {result && (
            <span
              style={{
                color: result.ok ? "var(--ok, #30a46c)" : "var(--danger, #e5484d)",
                fontSize: 12.5,
              }}
            >
              {result.ok ? "✅ " : "❌ "}
              {result.message}
            </span>
          )}
          {result?.ok && (
            <span className="faint" style={{ fontSize: 11.5 }}>
              Confirm it scraped in Grafana → Explore → Prometheus, or in the Status/Targets. Then
              query your app metrics in the dashboard.
            </span>
          )}
        </div>
      </Block.Body>
    </Block>
  );
}
