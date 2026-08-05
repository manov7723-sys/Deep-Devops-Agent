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
  Textarea,
  type SelectOption,
} from "@/components/ui";
import { useProjectEnvs } from "@/hooks/queries/project";
import {
  useAwsRdsInRegion,
  useAzureDatabases,
  useSubmitAppSecrets,
  useSubmitAzureDbConnect,
  useSubmitRdsConnect,
  useCloudSqlInstances,
  useCloudSqlDatabases,
  useSubmitCloudSqlConnect,
  type AzureDbConnectResult,
  type CloudSqlConnectResult,
} from "@/hooks/queries/network";
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
 * Connect does three things, in order:
 *   1. NETWORK — verifies the RDS security group admits the cluster's CURRENT
 *      node security groups on the DB port, and adds the rule if missing.
 *      Same-VPC and same-region-peered setups get a narrow security-group
 *      reference; inter-region peering falls back to the cluster VPC's CIDR
 *      because AWS forbids SG references across regions. VPC PEERING ITSELF is
 *      still the caller's job — we detect its absence and warn rather than
 *      build network topology on a button press.
 *   2. SECRET — builds and applies the Kubernetes Secret.
 *   3. WIRING — injects it into the namespace's Deployments via
 *      envFrom.secretRef and lets Kubernetes roll the pods.
 *
 * Step 1 exists because a cluster REBUILD gives every node a new security
 * group while the RDS rule still names the old, deleted one. Every query then
 * fails with "Can't reach database server", which reads like a database
 * outage. Step 3 exists because a Secret nothing references is invisible to
 * the app — and a hand-run `kubectl patch` is wiped by the next CD apply.
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
      <AzureDbConnectPanel slug={slug} />
      <CloudSqlConnectPanel slug={slug} />
      <AppSecretsPanel slug={slug} />
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
  // OPT-IN bootstrap. Default false: both WRITE to the user's database — one
  // creates it, the other mutates schema — so neither may happen implicitly.
  const [createDatabase, setCreateDatabase] = useState<boolean>(false);
  const [runMigrations, setRunMigrations] = useState<boolean>(false);

  const [serverError, setServerError] = useState<string | null>(null);
  const [result, setResult] = useState<
    | null
    | {
        secretName: string;
        namespace: string;
        keysWritten: string[];
        appSecretKey: string | null;
        stdout: string;
        /** Per-Deployment envFrom wiring outcomes from the server. */
        wired?: { deployment: string; status: "patched" | "already" | "failed"; message?: string }[];
        wireError?: string;
        summary?: string;
        /** Pre-flight security-group check — see rds-network.ts. */
        network?: {
          changed: boolean;
          message: string;
          ruleKind: "security-group" | "cidr";
          crossVpc: boolean;
          crossRegion: boolean;
          warnings: string[];
        };
        networkError?: string;
        /** Opt-in create-database / migrate results. */
        bootstrap?: { step: "create-database" | "migrate"; status: "done" | "skipped" | "failed"; message: string }[];
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
        // Lets the server verify (and if needed open) the RDS security group
        // for this cluster's CURRENT node SGs — the thing that silently breaks
        // every time a cluster is rebuilt.
        dbInstanceIdentifier: rdsId || undefined,
        region: region || undefined,
        createDatabase,
        runMigrations,
      });
      if (res.ok) {
        setResult({
          secretName: res.secretName ?? secretName.trim(),
          namespace: res.namespace ?? namespace.trim(),
          keysWritten: res.keysWritten ?? [],
          appSecretKey: res.appSecretKey ?? null,
          stdout: res.kubectl?.stdout ?? "",
          wired: res.wired ?? [],
          wireError: res.wireError,
          summary: res.summary,
          network: res.network,
          networkError: res.networkError,
          bootstrap: res.bootstrap ?? [],
        });
      }
    } catch (e) {
      setServerError(e instanceof Error ? e.message : "RDS connect failed.");
    }
  }

  if (result) {
    // The Secret alone does nothing — what matters is whether it got wired into
    // the Deployments. Reflect that honestly in the header instead of the old
    // "now go run kubectl yourself" copy.
    const wired = result.wired ?? [];
    const patched = wired.filter((w) => w.status === "patched");
    const already = wired.filter((w) => w.status === "already");
    const failed = wired.filter((w) => w.status === "failed");
    const fullyWired = !result.wireError && failed.length === 0 && wired.length > 0;
    return (
      <Block>
        <Block.Header>
          <Block.Title
            sub={
              result.summary ??
              `Secret ${result.namespace}/${result.secretName} applied.`
            }
          >
            {fullyWired
              ? patched.length > 0
                ? "Connected — database wired into your app"
                : "Already connected"
              : "Secret written — wiring needs attention"}
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

            {/* Network path — catches a stale SG after a rebuild, and handles
                cross-VPC / cross-region setups where AWS forbids SG references. */}
            {(result.network || result.networkError) && (
              <div className="col gap-1" style={{ fontSize: 12.5 }}>
                <div className="row gap-2 wrap" style={{ alignItems: "center" }}>
                  <Badge tone={result.networkError ? "warn" : result.network?.changed ? "ok" : "info"}>
                    {result.networkError
                      ? "network unchecked"
                      : result.network?.changed
                        ? "network opened"
                        : "network ok"}
                  </Badge>
                  {result.network?.crossRegion && <Badge tone="info">cross-region</Badge>}
                  {result.network?.crossVpc && !result.network.crossRegion && (
                    <Badge tone="info">cross-VPC</Badge>
                  )}
                  {result.network?.ruleKind === "cidr" && <Badge tone="warn">VPC-wide rule</Badge>}
                  <span className="muted">{result.networkError ?? result.network?.message}</span>
                </div>
                {/* Advisories: missing peering routes, broadened rule scope, … */}
                {(result.network?.warnings ?? []).map((w, i) => (
                  <div key={i} className="muted" style={{ paddingLeft: 2 }}>
                    ⚠ {w}
                  </div>
                ))}
              </div>
            )}

            {/* Opt-in bootstrap: database creation + schema migrations. */}
            {(result.bootstrap ?? []).length > 0 && (
              <div style={{ fontSize: 12.5 }}>
                <div className="muted" style={{ marginBottom: 4 }}>
                  Database bootstrap:
                </div>
                <div className="col gap-1">
                  {(result.bootstrap ?? []).map((b, i) => (
                    <div key={i} className="row gap-2" style={{ alignItems: "flex-start" }}>
                      <Badge
                        tone={b.status === "done" ? "ok" : b.status === "skipped" ? "info" : "warn"}
                      >
                        {b.step === "create-database" ? "create db" : "migrate"}
                      </Badge>
                      <span className="muted">{b.message}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {/* Per-Deployment wiring — the step users used to have to do by hand. */}
            {(wired.length > 0 || result.wireError) && (
              <div style={{ fontSize: 12.5 }}>
                <div className="muted" style={{ marginBottom: 4 }}>
                  Deployments wired (envFrom → secretRef):
                </div>
                {result.wireError && (
                  <div className="row gap-2" style={{ alignItems: "center", marginBottom: 4 }}>
                    <Badge tone="warn">error</Badge>
                    <span className="muted">{result.wireError}</span>
                  </div>
                )}
                <div className="col gap-1">
                  {wired.map((w) => (
                    <div key={w.deployment} className="row gap-2" style={{ alignItems: "center" }}>
                      <Badge
                        tone={
                          w.status === "patched" ? "ok" : w.status === "already" ? "info" : "warn"
                        }
                      >
                        {w.status === "patched"
                          ? "wired"
                          : w.status === "already"
                            ? "already set"
                            : "failed"}
                      </Badge>
                      <span className="mono">{w.deployment}</span>
                      {w.message && w.status === "failed" && (
                        <span className="muted">{w.message}</span>
                      )}
                    </div>
                  ))}
                </div>
                {patched.length > 0 && (
                  <div className="muted" style={{ marginTop: 6 }}>
                    Pods are rolling now — Secret values are read at container start, so a restart
                    is required for DATABASE_URL to appear. Give it ~30s.
                  </div>
                )}
                {already.length > 0 && patched.length === 0 && !failed.length && (
                  <div className="muted" style={{ marginTop: 6 }}>
                    Already wired — pods were rolled anyway so they pick up the Secret&apos;s
                    current values. If the app still can&apos;t reach the database, credentials
                    or the network path are the likelier cause.
                  </div>
                )}
              </div>
            )}
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

            {/* OPT-IN bootstrap. Off by default because both WRITE to the
                user's database. Ticking them turns Connect into a single
                end-to-end action: network → secret → wiring → schema. */}
            <label className="row gap-2" style={{ fontSize: 13, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={createDatabase}
                onChange={(e) => setCreateDatabase(e.target.checked)}
              />
              <span>
                Create the database if it doesn&apos;t exist
                <span className="muted">
                  {" "}
                  — an RDS <em>instance</em> isn&apos;t a <em>database</em>; a fresh one only has{" "}
                  <span className="mono">{engine === "mysql" ? "mysql" : "postgres"}</span>
                </span>
              </span>
            </label>

            <label className="row gap-2" style={{ fontSize: 13, cursor: "pointer" }}>
              <input
                type="checkbox"
                checked={runMigrations}
                onChange={(e) => setRunMigrations(e.target.checked)}
              />
              <span>
                Run schema migrations after connecting
                <span className="muted">
                  {" "}
                  — auto-detects Prisma / Alembic / Django in the app container.{" "}
                  <strong>Mutates schema.</strong>
                </span>
              </span>
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

// ── App config secrets ──────────────────────────────────────────────────
//
// The database is only half of "make this app run". Every real app also needs
// its own config — signing keys, API keys, third-party credentials — and until
// now nothing in the product wrote those; they were set by hand with
// `kubectl create secret --from-env-file`. A freshly deployed app therefore
// started with none of them and failed in ways that look nothing like missing
// configuration (a missing signing key makes login "succeed" and the next
// request 401).
//
// Paste, submit, done: the Secret is applied, wired via envFrom, and the pods
// are rolled — because values are read at container start and never reload.

/**
 * The config keys almost every deployed app needs, rendered as their own
 * labeled boxes instead of buried in a paste-your-.env textarea.
 *
 * WHY (2026-08 incident): a blank textarea assumes the operator already knows
 * WHICH keys matter. In practice a deploy would come up "healthy" and then
 * fail at sign-in because APP_PUBLIC_URL was unset (OAuth redirect_uri became
 * the pod's origin) or APP_SECRET_KEY was missing (TOTP setup 500s). Naming
 * the fields turns tribal knowledge into a form. `extra` still accepts
 * anything app-specific.
 */
const WELL_KNOWN_APP_KEYS: Array<{
  key: string;
  label: string;
  hint: string;
  placeholder: string;
  secret?: boolean;
}> = [
  {
    key: "APP_PUBLIC_URL",
    label: "Public URL",
    hint: "The URL users actually type. Behind a load balancer the app can't infer this — leave it unset and OAuth sends the pod's own origin as redirect_uri, which the provider rejects. No trailing slash.",
    placeholder: "http://my-app-1234.us-east-1.elb.amazonaws.com",
  },
  {
    key: "GITHUB_OAUTH_CLIENT_ID",
    label: "GitHub OAuth client ID",
    hint: "From the OAuth App whose Authorization callback URL is <public URL>/api/v1/auth/oauth/github/callback. Each environment needs its OWN app — one app holds only one callback URL.",
    placeholder: "Ov23li...",
  },
  {
    key: "GITHUB_OAUTH_CLIENT_SECRET",
    label: "GitHub OAuth client secret",
    hint: "Shown once by GitHub when generated. A stale secret fails as 'invalid_client', which reads like a wrong client ID.",
    placeholder: "••••••••",
    secret: true,
  },
  {
    key: "APP_SECRET_KEY",
    label: "App encryption key",
    hint: "base64 of 32 random bytes — generate with: openssl rand -base64 32. Encrypts TOTP secrets, OAuth tokens and stored credentials. Changing it invalidates everything previously encrypted, so set it once and keep it.",
    placeholder: "base64(32 bytes)",
    secret: true,
  },
];

function AppSecretsPanel({ slug }: { slug: string }) {
  const { data: envs } = useProjectEnvs(slug);
  const [envKey, setEnvKey] = useState<string>("");
  const [namespace, setNamespace] = useState<string>("default");
  const [secretName, setSecretName] = useState<string>("app-env");
  const [fields, setFields] = useState<Record<string, string>>({});
  const [envText, setEnvText] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<null | {
    summary?: string;
    keysWritten?: string[];
    skippedLines?: string[];
    localhostKeys?: string[];
  }>(null);

  const submit = useSubmitAppSecrets(slug);

  useEffect(() => {
    if (envKey || !envs?.length) return;
    const nonProd = envs.find((e) => !e.isProduction);
    setEnvKey((nonProd ?? envs[0]!).key);
  }, [envs, envKey]);

  const envOptions: SelectOption[] = (envs ?? []).map((e) => ({
    value: e.key,
    label: e.isProduction ? `${e.name} (prod)` : e.name || e.key,
  }));

  // Count locally so the button can state exactly what will be written before
  // anything is sent. Named fields + any extra pasted lines.
  const filledFields = WELL_KNOWN_APP_KEYS.filter((f) => (fields[f.key] ?? "").trim().length > 0);
  const extraPairCount = envText
    .split(/\r?\n/)
    .filter((l) => {
      const t = l.trim();
      return t && !t.startsWith("#") && /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*\s*=/.test(t);
    }).length;
  const pairCount = filledFields.length + extraPairCount;

  const ready = !!envKey && !!namespace.trim() && !!secretName.trim() && pairCount > 0;

  async function handleSubmit() {
    if (!ready) return;
    setError(null);
    try {
      // Named fields first, then the free-text block — later lines win on a
      // duplicate key, so an explicit override in "Additional variables"
      // beats the same key typed into a box above.
      const composed = [
        ...filledFields.map((f) => `${f.key}=${(fields[f.key] ?? "").trim()}`),
        envText,
      ]
        .filter((s) => s.trim().length > 0)
        .join("\n");
      const res = await submit.mutateAsync({
        envKey,
        namespace: namespace.trim(),
        secretName: secretName.trim(),
        envText: composed,
        // MERGE, never replace. This form only knows about the fields it
        // renders; replacing would silently delete every other key already in
        // the Secret (that is exactly how a lone APP_PUBLIC_URL write wiped
        // the GitHub OAuth credentials in the 2026-08 incident).
        merge: true,
      });
      setDone({
        summary: res.summary,
        keysWritten: res.keysWritten,
        skippedLines: res.skippedLines,
        localhostKeys: res.localhostKeys,
      });
      // Clear the entered secrets from component state once applied — no
      // reason to keep them sitting in memory after they've reached the
      // cluster.
      setFields({});
      setEnvText("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not write app secrets.");
    }
  }

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Fill in the boxes your app needs — the common ones are named below, anything else goes in Additional variables. Written as a Kubernetes Secret, wired into the namespace's Deployments, and the pods are rolled so they pick it up. Values are merged: keys you leave blank keep whatever is already set.">
          App configuration secrets
        </Block.Title>
      </Block.Header>
      <Block.Body>
        <div className="col gap-3">
          {done ? (
            <div className="col gap-2" style={{ fontSize: 12.5 }}>
              <div className="row gap-2" style={{ alignItems: "center" }}>
                <Badge tone="ok">applied</Badge>
                <span className="muted">{done.summary}</span>
              </div>
              {!!done.keysWritten?.length && (
                <div className="row gap-1 wrap">
                  {done.keysWritten.map((k) => (
                    <Badge key={k}>{k}</Badge>
                  ))}
                </div>
              )}
              {!!done.localhostKeys?.length && (
                <div className="col gap-1">
                  <span style={{ color: "var(--warn, #f5a524)" }}>
                    {done.localhostKeys.length} value(s) point at <b>localhost</b> — these will not
                    work from inside the cluster. OAuth callbacks in particular fail with
                    &quot;missing_nonce&quot; because the provider redirects to your laptop instead
                    of the deployed app. Re-paste with your app&apos;s public URL:
                  </span>
                  <div className="row gap-1 wrap">
                    {done.localhostKeys.map((k) => (
                      <Badge key={k} tone="warn">
                        {k}
                      </Badge>
                    ))}
                  </div>
                </div>
              )}
              {!!done.skippedLines?.length && (
                <div className="col gap-1">
                  <span className="muted">
                    Skipped {done.skippedLines.length} line(s) that weren&apos;t KEY=value — a
                    multi-line value is the usual cause:
                  </span>
                  {done.skippedLines.map((l, i) => (
                    <span key={i} className="mono muted">
                      {l}
                    </span>
                  ))}
                </div>
              )}
              <div>
                <Btn variant="outline" size="sm" onClick={() => setDone(null)}>
                  Write more secrets
                </Btn>
              </div>
            </div>
          ) : (
            <>
              <div className="row gap-3 wrap">
                <Field label="Environment" required>
                  <Select
                    value={envKey}
                    onValueChange={setEnvKey}
                    ariaLabel="Environment"
                    options={envOptions}
                  />
                </Field>
                <Field label="Namespace" required>
                  <Input
                    value={namespace}
                    onChange={(e) => setNamespace(e.target.value)}
                    className="mono"
                  />
                </Field>
                <Field label="Secret name" required>
                  <Input
                    value={secretName}
                    onChange={(e) => setSecretName(e.target.value)}
                    className="mono"
                  />
                </Field>
              </div>

              {/* One box per well-known key. Blank boxes are skipped entirely,
                  so this form can be used to set a single value without
                  disturbing anything else already in the Secret. */}
              <div className="col gap-3">
                {WELL_KNOWN_APP_KEYS.map((f) => (
                  <Field key={f.key} label={f.label} hint={f.hint}>
                    <Input
                      value={fields[f.key] ?? ""}
                      onChange={(e) =>
                        setFields((prev) => ({ ...prev, [f.key]: e.target.value }))
                      }
                      className="mono"
                      type={f.secret ? "password" : "text"}
                      autoComplete="off"
                      spellCheck={false}
                      placeholder={f.placeholder}
                    />
                  </Field>
                ))}
              </div>

              {/* The GitHub callback URL is derived, not typed — showing it
                  removes the most common OAuth misconfiguration (hand-built
                  URL with a typo, or pointing at the wrong environment). */}
              {(fields.APP_PUBLIC_URL ?? "").trim() && (
                <div
                  className="col gap-1"
                  style={{ fontSize: 12.5, padding: "8px 10px", border: "1px solid var(--border, #ddd)", borderRadius: 6 }}
                >
                  <span className="muted">
                    Paste this as the <b>Authorization callback URL</b> on your GitHub OAuth App:
                  </span>
                  <span className="mono" style={{ wordBreak: "break-all" }}>
                    {(fields.APP_PUBLIC_URL ?? "").trim().replace(/\/+$/, "")}
                    /api/v1/auth/oauth/github/callback
                  </span>
                </div>
              )}

              <Field
                label="Additional variables"
                hint="Anything else your app reads from the environment — one KEY=value per line. Comments (#) and blanks are ignored; surrounding quotes are stripped. Merged into the Secret alongside the fields above; keys you don't mention are left untouched."
              >
                <Textarea
                  value={envText}
                  onChange={(e: React.ChangeEvent<HTMLTextAreaElement>) => setEnvText(e.target.value)}
                  className="mono"
                  rows={6}
                  placeholder={"JWT_SIGNING_KEY=...\nSTRIPE_SECRET_KEY=...\n# DATABASE_URL is managed by the database connect above"}
                />
              </Field>

              {error && (
                <div className="row gap-2" style={{ alignItems: "center", fontSize: 12.5 }}>
                  <Badge tone="warn">error</Badge>
                  <span className="muted">{error}</span>
                </div>
              )}

              <div className="row gap-2" style={{ alignItems: "center" }}>
                <Btn onClick={handleSubmit} disabled={!ready || submit.isPending}>
                  {submit.isPending
                    ? "Writing…"
                    : pairCount > 0
                      ? `Write ${pairCount} secret(s) and roll pods`
                      : "Write secrets"}
                </Btn>
                <span className="muted" style={{ fontSize: 12.5 }}>
                  Pods restart, so expect ~30s of rollout.
                </span>
              </div>
            </>
          )}
        </div>
      </Block.Body>
    </Block>
  );
}

// ── Azure Database (Flexible Server) ↔ AKS namespace ────────────────────
//
// Azure counterpart of ClusterRdsConnectPanel. Same four steps, one Connect:
//   1. firewall — allow the AKS cluster's OUTBOUND IPs on the server. Azure
//      has no "allow this cluster" primitive like an AWS security-group
//      reference, so the server resolves the egress LB's effective outbound
//      IPs and adds a /32 rule per address.
//   2. Secret   — DATABASE_URL (with sslmode=require; Azure enforces TLS) + DB_* keys.
//   3. wiring   — envFrom into every Deployment, pods rolled.
//   4. optional — CREATE DATABASE and/or run migrations.
//
// Private-access (VNet-integrated) servers can't be fixed with a firewall
// rule; the server reports that rather than silently "succeeding".

function AzureDbConnectPanel({ slug }: { slug: string }) {
  const { data: envs } = useProjectEnvs(slug);
  const dbQuery = useAzureDatabases(slug);
  const submit = useSubmitAzureDbConnect(slug);

  const [envKey, setEnvKey] = useState<string>("");
  const [namespace, setNamespace] = useState<string>("default");
  const [secretName, setSecretName] = useState<string>("app-db");
  const [serverName, setServerName] = useState<string>("");
  const [database, setDatabase] = useState<string>("");
  const [username, setUsername] = useState<string>("");
  const [password, setPassword] = useState<string>("");
  // Default ON. These were opt-out-by-default on the AWS panel because they
  // WRITE to a database the user may already depend on. In the Azure flow the
  // overwhelmingly common case is a database the user just created for this
  // app — where skipping them produces an app that deploys "successfully" and
  // then 500s on every query with "table does not exist". Both steps are
  // idempotent, so leaving them on costs a few seconds and removes the single
  // most common way this flow silently half-completes.
  const [createDatabase, setCreateDatabase] = useState<boolean>(true);
  const [runMigrations, setRunMigrations] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<AzureDbConnectResult | null>(null);

  useEffect(() => {
    if (envKey || !envs?.length) return;
    const nonProd = envs.find((e) => !e.isProduction);
    setEnvKey((nonProd ?? envs[0]!).key);
  }, [envs, envKey]);

  const servers = dbQuery.data?.servers ?? [];
  const picked = servers.find((s) => s.name === serverName);

  // Prefill the admin login from the server record — it's stored on the
  // resource, so making the user retype it is pure friction. The PASSWORD is
  // never retrievable from Azure, so that one is always typed.
  useEffect(() => {
    if (picked && !username) setUsername(picked.adminUser);
  }, [picked, username]);

  const envOptions: SelectOption[] = (envs ?? []).map((e) => ({
    value: e.key,
    label: e.isProduction ? `${e.name} (prod)` : e.name || e.key,
  }));
  const serverOptions: SelectOption[] = servers.map((s) => ({
    value: s.name,
    label: `${s.name} · ${s.engine} ${s.version} · ${s.location}${s.publicAccess ? "" : " · private (VNet)"}`,
  }));

  const missing: string[] = [];
  if (!envKey) missing.push("environment");
  if (!namespace.trim()) missing.push("namespace");
  if (!serverName) missing.push("database server");
  if (!database.trim()) missing.push("database name");
  if (!username.trim()) missing.push("admin username");
  if (!password) missing.push("password");
  const ready = missing.length === 0;

  async function handleConnect() {
    if (!ready) return;
    setError(null);
    try {
      const res = await submit.mutateAsync({
        envKey,
        namespace: namespace.trim(),
        secretName: secretName.trim() || "app-db",
        serverName,
        database: database.trim(),
        username: username.trim(),
        password,
        createDatabase,
        runMigrations,
      });
      setResult(res);
      // Clear the password from component state the moment it has reached the
      // cluster — no reason to keep it in memory after that.
      setPassword("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not connect the database.");
    }
  }

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Wire an Azure Database for PostgreSQL/MySQL into an AKS namespace. Opens the server firewall for the cluster's outbound IPs, writes DATABASE_URL as a Secret, injects it into the Deployments, and rolls the pods.">
          Azure database connection
        </Block.Title>
      </Block.Header>
      <Block.Body>
        {dbQuery.data && dbQuery.data.connected === false ? (
          <span className="muted" style={{ fontSize: 13 }}>
            {dbQuery.data.note ?? "Connect an Azure subscription on the Cloud providers page first."}
          </span>
        ) : result ? (
          <div className="col gap-2" style={{ fontSize: 12.5 }}>
            <div className="row gap-2" style={{ alignItems: "center" }}>
              <Badge tone="ok">connected</Badge>
              <span className="muted">{result.summary}</span>
            </div>
            {!!result.network?.length &&
              result.network.map((n, i) => (
                <span key={i} className="muted">
                  network: {n}
                </span>
              ))}
            {result.networkError && (
              <span style={{ color: "var(--warn, #f5a524)" }}>network: {result.networkError}</span>
            )}
            {!!result.warnings?.length &&
              result.warnings.map((w, i) => (
                <span key={i} style={{ color: "var(--warn, #f5a524)" }}>
                  {w}
                </span>
              ))}
            {!!result.keysWritten?.length && (
              <div className="row gap-1 wrap">
                {result.keysWritten.map((k) => (
                  <Badge key={k}>{k}</Badge>
                ))}
              </div>
            )}
            {!!result.wired?.length && (
              <div className="col gap-1">
                {result.wired.map((w) => (
                  <span key={w.deployment} className="muted">
                    {w.status}: {w.deployment}
                    {w.message ? ` — ${w.message}` : ""}
                  </span>
                ))}
              </div>
            )}
            {!!result.bootstrap?.length &&
              result.bootstrap.map((b, i) => (
                <span
                  key={i}
                  style={{
                    color:
                      b.status === "failed" ? "var(--danger, #e5484d)" : "var(--muted, #888)",
                  }}
                >
                  {b.step}: {b.status} — {b.message}
                </span>
              ))}
            <div>
              <Btn variant="outline" size="sm" onClick={() => setResult(null)}>
                Connect another
              </Btn>
            </div>
          </div>
        ) : (
          <div className="col gap-3">
            <div className="row gap-3 wrap">
              <Field label="Environment" required>
                <Select
                  value={envKey}
                  onValueChange={setEnvKey}
                  ariaLabel="Environment"
                  options={envOptions}
                />
              </Field>
              <Field label="Namespace" required>
                <Input
                  value={namespace}
                  onChange={(e) => setNamespace(e.target.value)}
                  className="mono"
                />
              </Field>
              <Field label="Secret name" required>
                <Input
                  value={secretName}
                  onChange={(e) => setSecretName(e.target.value)}
                  className="mono"
                />
              </Field>
            </div>

            <div className="row gap-3 wrap">
              <Field
                label="Database server"
                hint={dbQuery.isLoading ? "Loading…" : `${servers.length} found in the subscription.`}
                required
              >
                <Select
                  value={serverName}
                  onValueChange={setServerName}
                  ariaLabel="Database server"
                  options={serverOptions}
                />
              </Field>
              <Field label="Database name" hint="The database inside the server, not the server itself." required>
                <Input
                  value={database}
                  onChange={(e) => setDatabase(e.target.value)}
                  className="mono"
                  placeholder="appdb"
                />
              </Field>
            </div>

            <div className="row gap-3 wrap">
              <Field label="Admin username" required>
                <Input
                  value={username}
                  onChange={(e) => setUsername(e.target.value)}
                  className="mono"
                />
              </Field>
              <Field label="Admin password" hint="Azure never returns this — paste the one set at server creation." required>
                <Input
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                />
              </Field>
            </div>

            {picked && !picked.publicAccess && (
              <span style={{ fontSize: 12.5, color: "var(--warn, #f5a524)" }}>
                &quot;{picked.name}&quot; uses private (VNet) access, so firewall rules don&apos;t apply.
                The Secret and wiring will still be written, but the cluster can only reach it if its
                VNet is the same as — or peered with — the server&apos;s.
              </span>
            )}

            <div className="col gap-1" style={{ fontSize: 12.5 }}>
              <label className="row gap-2" style={{ alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={createDatabase}
                  onChange={(e) => setCreateDatabase(e.target.checked)}
                />
                <span>Create the database if it doesn&apos;t exist</span>
              </label>
              <label className="row gap-2" style={{ alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={runMigrations}
                  onChange={(e) => setRunMigrations(e.target.checked)}
                />
                <span>Run schema migrations after connecting (Prisma / Alembic / Django)</span>
              </label>
            </div>

            {error && (
              <div className="row gap-2" style={{ alignItems: "center", fontSize: 12.5 }}>
                <Badge tone="warn">error</Badge>
                <span className="muted">{error}</span>
              </div>
            )}

            <div className="row gap-2" style={{ alignItems: "center" }}>
              <Btn onClick={handleConnect} disabled={!ready || submit.isPending}>
                {submit.isPending ? "Connecting…" : "Connect"}
              </Btn>
              {!ready && (
                <span className="muted" style={{ fontSize: 12.5 }}>
                  Need: {missing.join(", ")}.
                </span>
              )}
            </div>
          </div>
        )}
      </Block.Body>
    </Block>
  );
}

// ── Cloud SQL (GCP) ↔ GKE namespace ─────────────────────────────────────
//
// Deliberately NOT a mirror of the AWS/Azure panels, because GCP's
// recommended access path isn't a firewall rule. Connect performs:
//   1. identity — Google service account + roles/cloudsql.client + a
//      Workload Identity binding for the namespace's Kubernetes SA.
//   2. database — created through the Cloud SQL Admin API when asked.
//   3. secret + sidecar — DATABASE_URL pointing at 127.0.0.1, then the
//      cloud-sql-proxy container injected into every Deployment.
//   4. migrations — optional, shared with the other clouds.
//
// No IP allow-list means nothing to leave stale after a cluster rebuild —
// the failure mode that makes the AWS path need a network-repair step.

function CloudSqlConnectPanel({ slug }: { slug: string }) {
  const { data: envs } = useProjectEnvs(slug);
  const instQuery = useCloudSqlInstances(slug);
  const submit = useSubmitCloudSqlConnect(slug);

  const [envKey, setEnvKey] = useState<string>("");
  const [namespace, setNamespace] = useState<string>("default");
  const [secretName, setSecretName] = useState<string>("app-db");
  const [instanceName, setInstanceName] = useState<string>("");
  const [database, setDatabase] = useState<string>("");
  const [username, setUsername] = useState<string>("postgres");
  const [password, setPassword] = useState<string>("");
  const [createDatabase, setCreateDatabase] = useState<boolean>(true);
  const [runMigrations, setRunMigrations] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CloudSqlConnectResult | null>(null);

  const dbQuery = useCloudSqlDatabases(slug, instanceName || null);

  useEffect(() => {
    if (envKey || !envs?.length) return;
    const nonProd = envs.find((e) => !e.isProduction);
    setEnvKey((nonProd ?? envs[0]!).key);
  }, [envs, envKey]);

  const instances = instQuery.data?.instances ?? [];
  const picked = instances.find((i) => i.name === instanceName);

  // Cloud SQL's built-in superuser differs per engine; default to the right
  // one so the common case needs no typing.
  useEffect(() => {
    if (picked) setUsername((u) => (u === "postgres" || u === "root" ? (picked.engine === "mysql" ? "root" : "postgres") : u));
  }, [picked]);

  const envOptions: SelectOption[] = (envs ?? []).map((e) => ({
    value: e.key,
    label: e.isProduction ? `${e.name} (prod)` : e.name || e.key,
  }));
  const instanceOptions: SelectOption[] = instances.map((i) => ({
    value: i.name,
    label: `${i.name} · ${i.databaseVersion} · ${i.region}${i.state !== "RUNNABLE" ? ` (${i.state})` : ""}`,
  }));

  const missing: string[] = [];
  if (!envKey) missing.push("environment");
  if (!namespace.trim()) missing.push("namespace");
  if (!instanceName) missing.push("Cloud SQL instance");
  if (!database.trim()) missing.push("database name");
  if (!username.trim()) missing.push("username");
  if (!password) missing.push("password");
  const ready = missing.length === 0;

  async function handleConnect() {
    if (!ready) return;
    setError(null);
    try {
      const res = await submit.mutateAsync({
        envKey,
        namespace: namespace.trim(),
        secretName: secretName.trim() || "app-db",
        instanceName,
        database: database.trim(),
        username: username.trim(),
        password,
        createDatabase,
        runMigrations,
      });
      setResult(res);
      setPassword("");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not connect Cloud SQL.");
    }
  }

  return (
    <Block>
      <Block.Header>
        <Block.Title sub="Wire a Cloud SQL instance into a GKE namespace using the Cloud SQL Auth Proxy — Google's recommended path. Grants an IAM identity via Workload Identity and injects a proxy sidecar, so there is no IP allow-list to maintain or leave stale.">
          Cloud SQL connection
        </Block.Title>
      </Block.Header>
      <Block.Body>
        {instQuery.data && instQuery.data.connected === false ? (
          <span className="muted" style={{ fontSize: 13 }}>
            {instQuery.data.note ?? "Connect a GCP project on the Cloud providers page first."}
          </span>
        ) : result ? (
          <div className="col gap-2" style={{ fontSize: 12.5 }}>
            <div className="row gap-2" style={{ alignItems: "center" }}>
              <Badge tone="ok">connected</Badge>
              <span className="muted">{result.summary}</span>
            </div>
            {!!result.identity?.length && (
              <div className="col gap-1">
                {result.identity.map((s, i) => (
                  <span key={i} className="muted">
                    identity: {s}
                  </span>
                ))}
              </div>
            )}
            {!!result.keysWritten?.length && (
              <div className="row gap-1 wrap">
                {result.keysWritten.map((k) => (
                  <Badge key={k}>{k}</Badge>
                ))}
              </div>
            )}
            {!!result.sidecars?.length && (
              <div className="col gap-1">
                {result.sidecars.map((sc) => (
                  <span key={sc.deployment} className="muted">
                    {sc.status}: {sc.deployment}
                    {sc.message ? ` — ${sc.message}` : ""}
                  </span>
                ))}
              </div>
            )}
            {result.sidecarError && (
              <span style={{ color: "var(--warn, #f5a524)" }}>{result.sidecarError}</span>
            )}
            {!!result.bootstrap?.length &&
              result.bootstrap.map((b, i) => (
                <span
                  key={i}
                  style={{
                    color: b.status === "failed" ? "var(--danger, #e5484d)" : "var(--muted, #888)",
                  }}
                >
                  {b.step}: {b.status} — {b.message}
                </span>
              ))}
            <div>
              <Btn variant="outline" size="sm" onClick={() => setResult(null)}>
                Connect another
              </Btn>
            </div>
          </div>
        ) : (
          <div className="col gap-3">
            <div className="row gap-3 wrap">
              <Field label="Environment" required>
                <Select value={envKey} onValueChange={setEnvKey} ariaLabel="Environment" options={envOptions} />
              </Field>
              <Field label="Namespace" required>
                <Input value={namespace} onChange={(e) => setNamespace(e.target.value)} className="mono" />
              </Field>
              <Field label="Secret name" required>
                <Input value={secretName} onChange={(e) => setSecretName(e.target.value)} className="mono" />
              </Field>
            </div>

            <div className="row gap-3 wrap">
              <Field
                label="Cloud SQL instance"
                hint={instQuery.isLoading ? "Loading…" : `${instances.length} found in the project.`}
                required
              >
                <Select
                  value={instanceName}
                  onValueChange={setInstanceName}
                  ariaLabel="Cloud SQL instance"
                  options={instanceOptions}
                />
              </Field>
              <Field
                label="Database name"
                hint={
                  dbQuery.data?.databases?.length
                    ? `Existing: ${dbQuery.data.databases.join(", ")}`
                    : "The database inside the instance."
                }
                required
              >
                <Input
                  value={database}
                  onChange={(e) => setDatabase(e.target.value)}
                  className="mono"
                  placeholder="appdb"
                />
              </Field>
            </div>

            <div className="row gap-3 wrap">
              <Field label="Database user" required>
                <Input value={username} onChange={(e) => setUsername(e.target.value)} className="mono" />
              </Field>
              <Field label="Password" hint="The Cloud SQL user's password — Google never returns it." required>
                <Input type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
              </Field>
            </div>

            {picked && (
              <span className="muted" style={{ fontSize: 12.5 }}>
                Connects through the proxy as <span className="mono">{picked.connectionName}</span>. The app
                reaches it on <span className="mono">127.0.0.1</span> — no public IP or firewall rule involved.
              </span>
            )}

            <div className="col gap-1" style={{ fontSize: 12.5 }}>
              <label className="row gap-2" style={{ alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={createDatabase}
                  onChange={(e) => setCreateDatabase(e.target.checked)}
                />
                <span>Create the database if it doesn&apos;t exist</span>
              </label>
              <label className="row gap-2" style={{ alignItems: "center" }}>
                <input
                  type="checkbox"
                  checked={runMigrations}
                  onChange={(e) => setRunMigrations(e.target.checked)}
                />
                <span>Run schema migrations after connecting</span>
              </label>
            </div>

            {error && (
              <div className="row gap-2" style={{ alignItems: "center", fontSize: 12.5 }}>
                <Badge tone="warn">error</Badge>
                <span className="muted">{error}</span>
              </div>
            )}

            <div className="row gap-2" style={{ alignItems: "center" }}>
              <Btn onClick={handleConnect} disabled={!ready || submit.isPending}>
                {submit.isPending ? "Connecting…" : "Connect"}
              </Btn>
              {!ready && (
                <span className="muted" style={{ fontSize: 12.5 }}>
                  Need: {missing.join(", ")}.
                </span>
              )}
            </div>
          </div>
        )}
      </Block.Body>
    </Block>
  );
}
