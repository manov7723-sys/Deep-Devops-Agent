"use client";

/**
 * "Recommended setup" — the in-project surface of the Deployment Plan saved
 * by the create-project Analysis step. Advisory panel:
 *
 *   • accepted recommendations, grouped, with per-item status chips
 *   • deep links into the flow that fulfils each area (chat wizards / CI-CD)
 *   • "Generate & commit" buttons for missing scaffolding files — the one
 *     action here that writes anything, and it writes to the REPO only.
 *
 * Hidden entirely when the project has no plan (analysis skipped/failed).
 */
import { useState } from "react";
import Link from "next/link";
import type { Route } from "next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Badge, Block, Btn, Icon } from "@/components/ui";
import { api, apiErrorMessage } from "@/lib/api/client";
import type { RepoAnalysisReport } from "@/lib/analysis/repo-analyzer";

type PlanResp = {
  ok: boolean;
  plan: {
    repoFullName: string;
    analyzedAt: string;
    updatedAt: string;
    data: { report?: RepoAnalysisReport; items?: Record<string, string> };
  } | null;
};

/**
 * Per-area Create action. The Chat page reads `?prompt=` on mount and
 * auto-sends it once, so each row here just navigates to Chat with a
 * pre-filled starter that carries the plan values. Keeps ONE code path
 * (the agent's own create-flow) authoritative — the panel is a launcher,
 * not a duplicate wizard.
 *
 * The `env` area doesn't provision; it just sets secrets, so it links to
 * the Connections tab instead of Chat.
 *
 * Prompts are multi-line and structured so the agent's follow-up form
 * (`options-form` fence) can pre-populate its defaults — pod counts, node
 * types, region and target concurrent users all get named explicitly.
 */
type AreaAction = {
  label: string;
  href: (slug: string, promptQS: string) => string;
  prompt?: (ctx: {
    r: { value: string; why: string; title: string };
    report: RepoAnalysisReport;
    infraTarget: string;
  }) => string;
};
const AREA_ACTION: Record<string, AreaAction> = {
  cluster: {
    label: "Create cluster",
    href: (s, q) => `/p/${s}/chat?${q}`,
    prompt: ({ report, infraTarget }) => {
      const c = report.capacity.cluster;
      return [
        "Create a Kubernetes cluster for this project. Use the analysis-recommended sizing:",
        `- Node type: ${c.nodeType}`,
        `- Node count (min): ${c.nodeCount}`,
        `- Node count (max, autoscale): ${c.maxNodeCount}`,
        `- Target concurrent users: ${report.capacity.targetConcurrentUsers}`,
        `- Serves ~${c.maxConcurrentUsers} concurrent users at max`,
        `- Region: ${report.recommendations.find((x) => x.id === "region")?.value ?? "use the connected cloud's default region"}`,
        `Commit the terraform to ${infraTarget}. Confirm the sizing with me before applying.`,
      ].join("\n");
    },
  },
  database: {
    label: "Create database",
    href: (s, q) => `/p/${s}/chat?${q}`,
    prompt: ({ r, infraTarget }) => {
      return [
        `Create the ${r.title.toLowerCase()} recommended by the analysis:`,
        `- ${r.value}`,
        `- Rationale: ${r.why}`,
        `Commit the terraform to ${infraTarget} and wire the connection string into project secrets automatically. Confirm the size/multi-AZ choice with me before applying.`,
      ].join("\n");
    },
  },
  services: {
    // Analyzer emits objectStorage/redis/queue/email needs under `services`.
    label: "Create resource",
    href: (s, q) => `/p/${s}/chat?${q}`,
    prompt: ({ r, infraTarget }) => {
      return [
        `Create the following resource:`,
        `- ${r.title}: ${r.value}`,
        `- Rationale: ${r.why}`,
        `Commit the terraform to ${infraTarget}.`,
      ].join("\n");
    },
  },
  replicas: {
    label: "Deploy app",
    href: (s, q) => `/p/${s}/chat?${q}`,
    prompt: ({ r, report }) => {
      const repls = report.capacity.replicas
        .map(
          (p) =>
            `  - ${p.serviceName} (${p.stack}): min ${p.minReplicas} / max ${p.maxReplicas} pods (~${p.perPodRps} req/s per pod, serves ~${p.usersServedByMax} users at max)`,
        )
        .join("\n");
      return [
        `Deploy my application to the cluster. Replicas + HPA from the analysis:`,
        repls || `- ${r.value}`,
        `- Target concurrent users: ${report.capacity.targetConcurrentUsers}`,
        `Confirm namespace + exposure choices with me, then run the deploy.`,
      ].join("\n");
    },
  },
  exposure: {
    label: "Deploy app",
    href: (s, q) => `/p/${s}/chat?${q}`,
    prompt: ({ r }) =>
      `Deploy my application. Exposure recommendation from the analysis:\n- ${r.value}\n- Rationale: ${r.why}`,
  },
  env: {
    // Env vars live in GitHub Actions **environment secrets** (per-env:
    // dev / staging / prod). The CD workflow reads `${{ secrets.<NAME> }}`
    // from that environment context and materializes them into a k8s Secret
    // named `app-env` that every Deployment envFroms (see cdWorkflowFile in
    // cd-files.ts). Link deep into the GitHub UI so the user can paste
    // values without leaving the workflow.
    label: "Add env secrets on GitHub",
    href: (s) => `/p/${s}/connections?tab=github-env-secrets`,
    // no prompt — this is a link out to the source of truth, not a chat flow
  },
};

/** URL-encode a single ?prompt= value. */
function promptQS(text: string): string {
  return `prompt=${encodeURIComponent(text)}`;
}

export function RecommendedSetupPanel({ slug }: { slug: string }) {
  const qc = useQueryClient();
  const [genError, setGenError] = useState<string | null>(null);
  const [generated, setGenerated] = useState<Record<string, string>>({});

  const planQ = useQuery<PlanResp>({
    queryKey: ["p", slug, "deployment-plan"],
    queryFn: () => api.get<PlanResp>(`/projects/${slug}/deployment-plan`),
    staleTime: 60_000,
  });

  const setStatus = useMutation({
    mutationFn: (args: { id: string; status: "applied" | "skipped" | "accepted" }) =>
      api.patch(`/projects/${slug}/deployment-plan`, { items: { [args.id]: args.status } }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["p", slug, "deployment-plan"] }),
  });

  const generate = useMutation({
    mutationFn: (fileId: string) =>
      api.post<{ ok: boolean; path?: string; message?: string }>(
        `/projects/${slug}/deployment-plan/generate-file`,
        { fileId },
      ),
    onSuccess: (res, fileId) => {
      if (res.ok && res.path) {
        setGenerated((g) => ({ ...g, [fileId]: res.path! }));
        setGenError(null);
      } else setGenError(res.message ?? "Generation failed.");
    },
    onError: (e) => setGenError(apiErrorMessage(e, "Generation failed.")),
  });

  const plan = planQ.data?.plan;
  if (!plan?.data?.report) return null;
  const report = plan.data.report;
  const items = plan.data.items ?? {};
  const accepted = report.recommendations.filter((r) => items[r.id] !== "skipped");
  const pendingMissing = report.missingFiles.filter((f) => f.generatable && !generated[f.id]);

  // Infra-repo target. Slice 4 makes the wizard persist an explicit pick under
  // this sentinel key; until then, the banner falls back to same-repo layout
  // (Terraform lives in ./infra/ inside the app repo).
  const infraRepoPick = items["__infraRepo"] ?? "";
  const infraIsSeparate = infraRepoPick && infraRepoPick !== "same";
  const infraTargetRepo = infraIsSeparate ? infraRepoPick : report.repoFullName;
  const infraTargetPath = infraIsSeparate ? `${slug}/aws/` : "./infra/";

  // Everything the "Deploy my app" flow covers in one shot — frontend +
  // backend replicas, per-service resource requests/limits, exposure choices.
  // Rolled into a single prominent Deploy button at the top of the list so
  // the user doesn't see a Deploy app button on every one of these rows.
  const DEPLOY_AREAS = new Set(["replicas", "resources", "exposure"]);
  const deployRows = accepted.filter((r) => DEPLOY_AREAS.has(r.area));
  const deployPrompt =
    deployRows.length > 0
      ? [
          "Deploy my application to the cluster. Analysis-recommended shape:",
          ...deployRows.map((r) => `- ${r.title}: ${r.value}`),
          `- Target concurrent users: ${report.capacity.targetConcurrentUsers}`,
          "Confirm namespace + exposure choices with me, then run the deploy.",
        ].join("\n")
      : "";

  return (
    <Block>
      <Block.Header>
        <Block.Title
          sub={`From the repo analysis of ${plan.repoFullName} (${new Date(plan.analyzedAt).toLocaleDateString()}). Advisory — each item links into the flow that applies it.`}
        >
          <span className="row gap-2" style={{ alignItems: "center" }}>
            <Icon name="stats" size={16} /> Recommended setup
          </span>
        </Block.Title>
      </Block.Header>
      <Block.Body>
        <div
          className="row gap-3"
          style={{
            alignItems: "center",
            border: "1px dashed var(--border)",
            borderRadius: 10,
            padding: "10px 14px",
            marginBottom: 12,
            background: "var(--surface-1)",
          }}
        >
          <Icon name="server" size={18} style={{ flex: "none", color: "var(--accent, #8b7cf5)" }} />
          <div className="col" style={{ gap: 2, flex: 1, minWidth: 0 }}>
            <span
              className="muted"
              style={{
                fontSize: 10.5,
                textTransform: "uppercase",
                letterSpacing: "0.05em",
                fontWeight: 700,
              }}
            >
              Terraform will be committed to
            </span>
            <span style={{ fontSize: 12.5 }}>
              <b style={{ fontFamily: "var(--font-mono, ui-monospace)" }}>{infraTargetRepo}</b>
              <span className="muted"> · at path </span>
              <b style={{ fontFamily: "var(--font-mono, ui-monospace)" }}>{infraTargetPath}</b>
            </span>
          </div>
          <Badge tone={infraIsSeparate ? "accent" : "default"}>
            {infraIsSeparate ? "separate infra repo" : "same repo"}
          </Badge>
        </div>

        {/*
          Master "Deploy my app" card. Everything the deploy flow covers
          (replicas × 2 services + resources × 2 + exposure × 2) rolls up
          into ONE Deploy button so the panel doesn't show a "Deploy app"
          button on 6 different rows. The individual rows still render below
          as informational (so the user sees the recommended values), just
          without duplicate buttons.
        */}
        {deployRows.length > 0 && (
          <div
            className="row gap-3"
            style={{
              alignItems: "center",
              padding: "12px 14px",
              marginBottom: 12,
              border: "1px solid var(--accent, #8b7cf5)",
              borderRadius: 10,
              background:
                "linear-gradient(90deg, var(--accent-soft, rgba(139,124,245,0.14)), transparent)",
            }}
          >
            <Icon
              name="rocket"
              size={18}
              style={{ flex: "none", color: "var(--accent, #8b7cf5)" }}
            />
            <div className="col" style={{ gap: 2, flex: 1, minWidth: 0 }}>
              <b style={{ fontSize: 13 }}>Deploy my app</b>
              <span className="muted" style={{ fontSize: 11.5 }}>
                One click ships everything below — {deployRows.length} configured item
                {deployRows.length === 1 ? "" : "s"} (replicas, resource limits, exposure).
              </span>
            </div>
            <Link
              className="btn primary sm"
              href={`/p/${slug}/chat?${promptQS(deployPrompt)}` as Route}
              style={{ textDecoration: "none", flex: "none" }}
            >
              🚀 Deploy my app
            </Link>
          </div>
        )}

        <div className="col gap-2">
          {accepted.map((r) => {
            const status = items[r.id] ?? "accepted";
            const action = AREA_ACTION[r.area];
            const infraTarget = `${infraTargetRepo} at ${infraTargetPath}`;
            // Deploy-related rows (replicas/resources/exposure) roll up into
            // the master "Deploy my app" card above — hide their per-row
            // button so we don't show N duplicate Deploy buttons.
            const rolledUp = DEPLOY_AREAS.has(r.area);
            const href = rolledUp
              ? null
              : action
                ? action.prompt
                  ? (action.href(
                      slug,
                      promptQS(action.prompt({ r, report, infraTarget })),
                    ) as Route)
                  : (action.href(slug, "") as Route)
                : null;
            return (
              <div
                key={r.id}
                className="row gap-3"
                style={{
                  alignItems: "flex-start",
                  border: "1px solid var(--border)",
                  borderRadius: 10,
                  padding: "10px 12px",
                  opacity: status === "applied" ? 0.65 : 1,
                }}
              >
                <div className="col" style={{ gap: 2, minWidth: 0, flex: 1 }}>
                  <span className="row gap-2" style={{ alignItems: "center" }}>
                    <b style={{ fontSize: 13 }}>{r.title}</b>
                    <Badge tone={status === "applied" ? "ok" : "default"}>
                      {status === "applied" ? "applied" : "pending"}
                    </Badge>
                  </span>
                  <span style={{ fontSize: 12.5 }}>{r.value}</span>
                  <span className="muted" style={{ fontSize: 11.5 }}>
                    {r.why}
                  </span>
                </div>
                <div className="row gap-2" style={{ flex: "none", alignItems: "center" }}>
                  {action && href && status !== "applied" && (
                    <Link
                      className="btn primary sm"
                      href={href}
                      style={{ textDecoration: "none" }}
                    >
                      {action.label}
                    </Link>
                  )}
                  <Btn
                    size="sm"
                    variant="ghost"
                    onClick={() =>
                      setStatus.mutate({
                        id: r.id,
                        status: status === "applied" ? "accepted" : "applied",
                      })
                    }
                  >
                    {status === "applied" ? "Undo" : "Mark applied"}
                  </Btn>
                </div>
              </div>
            );
          })}

          {pendingMissing.length > 0 && (
            <div className="col gap-2" style={{ marginTop: 6 }}>
              <span className="field-label" style={{ marginBottom: 0 }}>
                Missing files — generate &amp; commit to {report.defaultBranch}
              </span>
              {pendingMissing.map((f) => (
                <div
                  key={f.id}
                  className="row gap-2"
                  style={{
                    alignItems: "center",
                    border: "1px dashed var(--border)",
                    borderRadius: 8,
                    padding: "8px 12px",
                    fontSize: 12.5,
                  }}
                >
                  <Icon name="alert" size={14} style={{ flex: "none" }} />
                  <span className="col" style={{ gap: 1, flex: 1, minWidth: 0 }}>
                    <b>{f.label}</b>
                    <span className="muted" style={{ fontSize: 11.5 }}>
                      {f.detail}
                    </span>
                  </span>
                  <Btn
                    size="sm"
                    variant="outline"
                    icon="check"
                    loading={generate.isPending && generate.variables === f.id}
                    onClick={() => generate.mutate(f.id)}
                  >
                    Generate &amp; commit
                  </Btn>
                </div>
              ))}
            </div>
          )}
          {Object.entries(generated).map(([id, path]) => (
            <span key={id} style={{ fontSize: 12, color: "var(--ok, #30a46c)" }}>
              ✅ Committed {path} to {report.defaultBranch}.
            </span>
          ))}
          {genError && (
            <span style={{ fontSize: 12, color: "var(--danger)" }}>{genError}</span>
          )}
        </div>
      </Block.Body>
    </Block>
  );
}
