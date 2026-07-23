"use client";

import { useEffect, useMemo, useState } from "react";
import {
  Badge,
  Block,
  Btn,
  Field,
  Input,
  PageHead,
  Select,
  type SelectOption,
} from "@/components/ui";
import { useProjectEnvs } from "@/hooks/queries/project";
import { useAwsRdsInRegion, useSubmitRdsConnect } from "@/hooks/queries/network";
// Shared with the chat wizards + Network page — see lib/aws-regions.ts.
import { AWS_REGIONS as COMMON_REGIONS } from "@/lib/aws-regions";

/**
 * Connections — wire an existing RDS instance into an EKS cluster by writing
 * a Kubernetes Secret with the DB URL + individual keys into the cluster's
 * namespace. Same two-column shape as the /network peering page: LEFT picks
 * the cluster (via env), RIGHT picks the RDS (via region + instance list).
 * When Connect fires, the server builds the Secret manifest and `kubectl
 * apply`s it against the env's stored kubeconfig — the same code path the
 * chat playbook's `create_rds_k8s_secret` + `apply_k8s_manifest` tools use.
 *
 * Assumes the network layer already works: VPC peering + route tables + RDS
 * security-group ingress are the caller's responsibility. Symptoms if any of
 * those are missing surface as `no such host` / `connection refused` on the
 * app's first pod restart, not here — this endpoint only manages the Secret.
 */
const REGION_OPTIONS: SelectOption[] = COMMON_REGIONS.map((r) => ({ value: r, label: r }));
const ENGINE_OPTIONS: SelectOption[] = [
  { value: "postgres", label: "PostgreSQL (port 5432)" },
  { value: "mysql", label: "MySQL / MariaDB (port 3306)" },
];

export function ProjectConnectionsClient({ slug }: { slug: string }) {
  return (
    <div className="col gap-5">
      <PageHead
        title="Connections"
        sub="Wire an existing RDS into a cluster. Writes a Kubernetes Secret with DATABASE_URL + DB_* keys into the cluster's namespace."
      />
      <ClusterRdsConnectPanel slug={slug} />
    </div>
  );
}

// ── Cluster ↔ RDS panel ─────────────────────────────────────────────────

function ClusterRdsConnectPanel({ slug }: { slug: string }) {
  const { data: envs } = useProjectEnvs(slug);

  // LEFT — env (proxy for cluster) + k8s target
  const [envKey, setEnvKey] = useState<string>("");
  const [namespace, setNamespace] = useState<string>("default");
  const [secretName, setSecretName] = useState<string>("app-db");

  // RIGHT — region + RDS instance
  const [region, setRegion] = useState<string>("");
  const [rdsId, setRdsId] = useState<string>("");

  // Credentials — RDS master password isn't recoverable via describe, so the
  // user always types it (or pastes from wherever they stashed it at create).
  const [password, setPassword] = useState<string>("");
  // If the DB instance describe returns no DBName the user has to type one
  // (common for BYO databases created without a default schema).
  const [dbNameOverride, setDbNameOverride] = useState<string>("");
  const [alsoStoreInAppSecret, setAlsoStoreInAppSecret] = useState<boolean>(true);

  const [serverError, setServerError] = useState<string | null>(null);
  const [result, setResult] = useState<
    | null
    | {
        secretName: string;
        namespace: string;
        keysWritten: string[];
        appSecretKey: string | null;
        stdout: string;
      }
  >(null);

  const submit = useSubmitRdsConnect(slug);
  const rdsQuery = useAwsRdsInRegion(slug, region || null);

  // Env default: pick the first non-prod env if any, else first available.
  useEffect(() => {
    if (envKey || !envs?.length) return;
    const nonProd = envs.find((e) => !e.isProduction);
    setEnvKey((nonProd ?? envs[0]!).key);
  }, [envs, envKey]);

  // Reset dependent picker when region changes.
  useEffect(() => setRdsId(""), [region]);

  const envOptions: SelectOption[] = (envs ?? []).map((e) => ({
    value: e.key,
    label: e.isProduction ? `${e.name} (prod)` : e.name || e.key,
  }));

  const instances = rdsQuery.data && "instances" in rdsQuery.data ? rdsQuery.data.instances : [];
  const rdsOptions: SelectOption[] = instances.map((r) => ({
    value: r.identifier,
    label: `${r.identifier} · ${r.engine}${r.vpcId ? ` · ${r.vpcId}` : ""}${r.status !== "available" ? ` (${r.status})` : ""}`,
  }));
  const picked = instances.find((i) => i.identifier === rdsId);
  const engine: "postgres" | "mysql" = useMemo(() => {
    if (!picked?.engine) return "postgres";
    return picked.engine.toLowerCase().includes("mysql") || picked.engine.toLowerCase().includes("maria")
      ? "mysql"
      : "postgres";
  }, [picked?.engine]);
  const defaultPort = engine === "mysql" ? 3306 : 5432;
  const effectivePort = picked?.port ?? defaultPort;
  const effectiveDatabase = (dbNameOverride.trim() || picked?.database || "").trim();
  const effectiveUsername = picked?.username ?? "";
  const disconnectNote =
    rdsQuery.data && !("connected" in rdsQuery.data && rdsQuery.data.connected)
      ? (rdsQuery.data as { note?: string }).note ?? null
      : null;

  const missingFields: string[] = [];
  if (!envKey) missingFields.push("environment");
  if (!namespace.trim()) missingFields.push("namespace");
  if (!secretName.trim()) missingFields.push("secret name");
  if (!picked?.endpoint) missingFields.push("RDS with an endpoint");
  if (!effectiveDatabase) missingFields.push("database name");
  if (!effectiveUsername) missingFields.push("master username (RDS returned none)");
  if (!password) missingFields.push("password");
  const ready = missingFields.length === 0 && !!picked?.endpoint;

  async function handleSubmit() {
    if (!ready || !picked?.endpoint) return;
    setServerError(null);
    try {
      const res = await submit.mutateAsync({
        envKey,
        namespace: namespace.trim(),
        secretName: secretName.trim(),
        host: picked.endpoint,
        port: effectivePort,
        database: effectiveDatabase,
        username: effectiveUsername,
        password,
        engine,
        alsoStoreInAppSecret,
      });
      if (res.ok) {
        setResult({
          secretName: res.secretName ?? secretName.trim(),
          namespace: res.namespace ?? namespace.trim(),
          keysWritten: res.keysWritten ?? [],
          appSecretKey: res.appSecretKey ?? null,
          stdout: res.kubectl?.stdout ?? "",
        });
      }
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "RDS connect failed.");
    }
  }

  if (result) {
    return (
      <Block>
        <Block.Header>
          <Block.Title
            sub={`Secret ${result.namespace}/${result.secretName} applied. Patch your Deployment with envFrom.secretRef and roll pods to pick up the DB.`}
          >
            Connected — Secret written to the cluster
          </Block.Title>
        </Block.Header>
        <Block.Body>
          <div className="col gap-3">
            <div className="row gap-2 wrap" style={{ fontSize: 12.5 }}>
              <Badge tone="ok">applied</Badge>
              <span className="mono">{result.namespace}/{result.secretName}</span>
              {result.appSecretKey && (
                <>
                  <Badge tone="info">AppSecret</Badge>
                  <span className="mono">{result.appSecretKey}</span>
                </>
              )}
            </div>
            <div style={{ fontSize: 12.5 }}>
              <div className="muted" style={{ marginBottom: 4 }}>Keys written:</div>
              <div className="row gap-1 wrap">
                {result.keysWritten.map((k) => (
                  <Badge key={k}>{k}</Badge>
                ))}
              </div>
            </div>
            {result.stdout && (
              <pre
                className="mono"
                style={{
                  fontSize: 12,
                  padding: 10,
                  background: "var(--surface-2)",
                  borderRadius: 8,
                  overflow: "auto",
                  maxHeight: 200,
                }}
              >
                {result.stdout}
              </pre>
            )}
            <div className="row gap-2" style={{ justifyContent: "flex-end" }}>
              <Btn
                variant="ghost"
                onClick={() => {
                  setResult(null);
                  setPassword("");
                }}
              >
                Connect another
              </Btn>
            </div>
          </div>
        </Block.Body>
      </Block>
    );
  }

  return (
    <div className="col gap-4">
      <Block>
        <Block.Header>
          <Block.Title sub="Pick a cluster on the left and an existing RDS on the right. Requires the network layer (peering + routes + SG) to already work.">
            Cluster ↔ RDS
          </Block.Title>
        </Block.Header>
      </Block>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
        {/* LEFT — cluster / env */}
        <Block>
          <Block.Header>
            <Block.Title>LEFT (cluster)</Block.Title>
          </Block.Header>
          <div className="col gap-3" style={{ padding: 4 }}>
            <Field
              label="Environment"
              required
              hint="The env whose connected cluster receives the Secret. Connect the cluster on the Clusters page first."
            >
              <Select
                options={envOptions}
                value={envKey}
                onValueChange={setEnvKey}
                ariaLabel="Environment"
                placeholder="Pick an env…"
              />
            </Field>
            <Field label="Namespace" required hint="K8s namespace to write the Secret into.">
              <Input value={namespace} onChange={(e) => setNamespace(e.target.value)} className="mono" />
            </Field>
            <Field label="Secret name" required hint="DNS-1123 (lowercase + dashes). Typical: <app>-db.">
              <Input value={secretName} onChange={(e) => setSecretName(e.target.value)} className="mono" />
            </Field>
            <label className="row gap-2" style={{ fontSize: 13, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={alsoStoreInAppSecret}
                onChange={(e) => setAlsoStoreInAppSecret(e.target.checked)}
              />
              <span>Also store DATABASE_URL in AppSecret (encrypted; readable by agent tools)</span>
            </label>
          </div>
        </Block>

        {/* RIGHT — RDS */}
        <Block>
          <Block.Header>
            <Block.Title>RIGHT (RDS)</Block.Title>
          </Block.Header>
          <div className="col gap-3" style={{ padding: 4 }}>
            <Field label="Region" required>
              <Select
                options={REGION_OPTIONS}
                value={region}
                onValueChange={setRegion}
                ariaLabel="RDS region"
                placeholder="Pick a region…"
              />
            </Field>
            <Field
              label="RDS instance"
              required
              hint={
                !region
                  ? "Pick a region first."
                  : rdsQuery.isLoading
                    ? "Loading RDS instances…"
                    : disconnectNote
                      ? disconnectNote
                      : instances.length === 0
                        ? "No RDS instances in this region."
                        : `${instances.length} instance${instances.length === 1 ? "" : "s"} in ${region}.`
              }
            >
              <Select
                options={rdsOptions}
                value={rdsId}
                onValueChange={setRdsId}
                ariaLabel="RDS instance"
                placeholder="Pick an RDS…"
                disabled={!region || rdsOptions.length === 0}
              />
            </Field>
            {picked && (
              <div className="row gap-2 wrap" style={{ fontSize: 12 }}>
                <Badge tone={picked.status === "available" ? "ok" : "warn"}>{picked.status}</Badge>
                <Badge>{engine}</Badge>
                {picked.endpoint && (
                  <>
                    <Badge tone="info">endpoint</Badge>
                    <span className="mono" style={{ wordBreak: "break-all" }}>
                      {picked.endpoint}:{effectivePort}
                    </span>
                  </>
                )}
                {picked.vpcId && (
                  <>
                    <Badge>VPC</Badge>
                    <span className="mono">{picked.vpcId}</span>
                  </>
                )}
              </div>
            )}
            {picked && (
              <>
                <Field
                  label="Database name"
                  required
                  hint={
                    picked.database
                      ? "Auto-detected from RDS metadata. Override if you're using a different schema."
                      : "RDS didn't return a default DB name — type the one your app uses."
                  }
                >
                  <Input
                    value={dbNameOverride || picked.database || ""}
                    onChange={(e) => setDbNameOverride(e.target.value)}
                    className="mono"
                  />
                </Field>
                <Field
                  label="Master username"
                  hint={
                    effectiveUsername
                      ? "Auto-detected. Read-only — passed straight into the Secret."
                      : "RDS didn't return a username. Reconnect with the DB creds if you need a different user."
                  }
                >
                  <Input value={effectiveUsername} disabled className="mono" />
                </Field>
                <Field
                  label="Master password"
                  required
                  hint="Never printed back. Passed into the Secret's DB_PASSWORD + DATABASE_URL."
                >
                  <Input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    className="mono"
                    placeholder="•••••••••"
                  />
                </Field>
              </>
            )}
          </div>
        </Block>
      </div>

      {missingFields.length > 0 && envKey && region && (
        <div
          className="row gap-2"
          style={{
            padding: 10,
            borderRadius: 8,
            background: "var(--warn-soft)",
            color: "var(--warn)",
            fontSize: 12.5,
          }}
          role="status"
        >
          <span>Still need: {missingFields.join(", ")}.</span>
        </div>
      )}

      {serverError && (
        <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">
          {serverError}
        </p>
      )}

      <div className="row gap-2" style={{ justifyContent: "flex-end" }}>
        <Btn
          variant="primary"
          icon="link"
          loading={submit.isPending}
          disabled={!ready || submit.isPending}
          onClick={handleSubmit}
        >
          Connect cluster to RDS
        </Btn>
      </div>
    </div>
  );
}
