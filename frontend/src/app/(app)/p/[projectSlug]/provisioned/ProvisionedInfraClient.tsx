"use client";

import { useMemo, useState } from "react";
import { Badge, Block, Btn, PageHead } from "@/components/ui";
import { useProjectEnvs } from "@/hooks/queries/project";
import {
  useTerraformRuns,
  useDestroyTerraformRun,
  useDeleteTerraformState,
  type TfRun,
} from "@/hooks/queries/connectivity";

/**
 * Provisioned infrastructure — one card per unique stack the agent has
 * `terraform apply`-ed to a cloud, with a single "Delete infrastructure"
 * button that:
 *   1. runs `terraform destroy -auto-approve` against the source run's files
 *      and backend (wipes every cloud resource the apply created), then
 *   2. deletes the tfstate blob (so a future apply of the same stack starts
 *      from scratch).
 *
 * Groups by (envKey, stack name) — the "latest successful apply" per stack is
 * what represents "what's currently provisioned". Failed and plan-only runs
 * don't show; they don't own cloud resources.
 *
 * Currently powered by tfRun history, so it reflects what the AGENT applied
 * — infra provisioned outside the app (Portal / az CLI) doesn't appear. If
 * we later want a "cloud reality" view, we'd query ARM/EKS/GCP directly and
 * merge. For now, this is the answer to "what did the agent build for me?".
 */
export function ProvisionedInfraClient({ slug }: { slug: string }) {
  const { data: envs } = useProjectEnvs(slug);
  const envKeys = envs?.map((e) => e.key) ?? [];

  return (
    <div className="col gap-5">
      <PageHead
        title="Provisioned infrastructure"
        sub="Everything the agent has applied to a cloud. Delete a stack to run terraform destroy and wipe both cloud resources and its state file."
      />

      {envKeys.length === 0 ? (
        <Block>
          <Block.Body>
            <span className="muted" style={{ fontSize: 13 }}>
              No environments yet — create one, then run an infra wizard (EKS / AKS / GKE) to see it here.
            </span>
          </Block.Body>
        </Block>
      ) : (
        // One block per env — the tfRun list is env-scoped, and mixing envs in
        // one flat list makes the "current state" grouping ambiguous.
        envKeys.map((envKey) => <EnvStacksBlock key={envKey} slug={slug} envKey={envKey} />)
      )}
    </div>
  );
}

function EnvStacksBlock({ slug, envKey }: { slug: string; envKey: string }) {
  const runsQuery = useTerraformRuns(slug, envKey, true);
  const allRuns = runsQuery.data?.runs ?? [];

  // "What's provisioned" = the LATEST SUCCESSFUL APPLY per stack. Failed and
  // plan-only runs don't represent real cloud resources, so they don't count.
  // A subsequent successful destroy also disqualifies — if destroy succeeded
  // MORE RECENTLY than the last apply, that stack is gone.
  const stacks = useMemo(() => groupToLatestApplyPerStack(allRuns), [allRuns]);

  if (stacks.length === 0) {
    // Hide empty envs entirely — a blank card per env would be noise on
    // projects with many empty envs.
    return null;
  }

  return (
    <div className="col gap-3">
      <div className="row gap-2" style={{ alignItems: "baseline" }}>
        <h2 style={{ fontSize: 15, fontWeight: 600, margin: 0 }}>{envKey}</h2>
        <span className="muted" style={{ fontSize: 12.5 }}>
          {stacks.length} stack{stacks.length === 1 ? "" : "s"}
        </span>
      </div>
      <div className="col gap-3">
        {stacks.map((run) => (
          <StackCard key={`${envKey}:${run.name}`} slug={slug} run={run} />
        ))}
      </div>
    </div>
  );
}

/**
 * Deduplicate runs to the most recent successful `apply` per stack. Skip
 * stacks whose most recent SUCCESSFUL run was a `destroy` — those represent
 * gone infra even if an earlier apply is in history.
 */
function groupToLatestApplyPerStack(runs: TfRun[]): TfRun[] {
  // Newest first.
  const sorted = [...runs].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  const winner = new Map<string, TfRun>();
  const disqualified = new Set<string>();
  for (const r of sorted) {
    if (r.status !== "succeeded") continue;
    const key = r.name;
    if (winner.has(key) || disqualified.has(key)) continue;
    // First successful run seen for this stack (which, given newest-first, is
    // the LATEST successful run) — either an apply we surface, or a destroy
    // that hides everything older.
    if (r.action === "destroy") {
      disqualified.add(key);
    } else if (r.action === "apply") {
      winner.set(key, r);
    }
    // "plan"-only runs neither surface nor disqualify — they're diagnostic.
  }
  return [...winner.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function StackCard({ slug, run }: { slug: string; run: TfRun }) {
  const destroy = useDestroyTerraformRun(slug, run.envKey);
  const deleteState = useDeleteTerraformState(slug, run.envKey);
  // We chain destroy → delete state, tracking which phase is running so the
  // button label is honest ("Destroying..." vs "Deleting state..." vs
  // "Delete infrastructure").
  const [phase, setPhase] = useState<null | "destroying" | "deleting_state" | "done" | "failed">(null);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  const busy = phase === "destroying" || phase === "deleting_state";

  async function handleDelete() {
    const ok = window.confirm(
      `Delete "${run.name}"?\n` +
        `This runs terraform destroy (wipes every cloud resource this stack owns) and then removes the state file. ` +
        `Both are irreversible. Typical duration: 5-15 minutes for a cluster.`,
    );
    if (!ok) return;

    setStatusMsg(null);
    setPhase("destroying");
    try {
      const destroyRes = await destroy.mutateAsync({ runId: run.id });
      // The destroy call returns immediately after queuing the run (async
      // pipeline: init → plan → destroy). Poll the run to know when it's
      // actually done — but for now surface a soft success and let the
      // Terraform pipeline card show the live logs. The delete-state step
      // must WAIT for destroy to finish, otherwise it wipes the state
      // Terraform is mid-way through updating.
      const newRunId = destroyRes.run?.id;
      if (!newRunId) throw new Error("Destroy didn't return a run id.");

      setStatusMsg(`Destroy queued (${newRunId}). Waiting for it to finish before deleting state — this can take 5-15 min for a cluster.`);
      await waitForRunToFinish(slug, run.envKey, newRunId);

      setPhase("deleting_state");
      const stateRes = await deleteState.mutateAsync({ stack: run.name });
      setStatusMsg(stateRes.message ?? "State deleted.");
      setPhase("done");
    } catch (e) {
      setPhase("failed");
      setStatusMsg(e instanceof Error ? e.message : "Delete failed.");
    }
  }

  return (
    <Block>
      <Block.Header>
        <div className="row gap-2" style={{ alignItems: "center", justifyContent: "space-between", width: "100%" }}>
          <Block.Title sub={`stack "${run.name}" · env ${run.envKey} · applied ${new Date(run.createdAt).toLocaleString()}`}>
            <span className="row gap-2" style={{ alignItems: "center" }}>
              {run.name}
              <Badge tone={phase === "done" ? "info" : "ok"} withDot>
                {phase === "done" ? "deleted" : "provisioned"}
              </Badge>
            </span>
          </Block.Title>
          <div className="row gap-2">
            <Btn
              size="sm"
              variant="outline"
              icon="trash"
              loading={busy}
              disabled={busy || phase === "done"}
              onClick={handleDelete}
            >
              {phase === "destroying"
                ? "Destroying…"
                : phase === "deleting_state"
                  ? "Deleting state…"
                  : phase === "done"
                    ? "Deleted"
                    : "Delete infrastructure"}
            </Btn>
          </div>
        </div>
      </Block.Header>
      {statusMsg && (
        <Block.Body>
          <span
            style={{
              fontSize: 12.5,
              color:
                phase === "failed"
                  ? "var(--danger, #e5484d)"
                  : phase === "done"
                    ? "var(--ok, #30a46c)"
                    : "var(--muted, #888)",
            }}
          >
            {statusMsg}
          </span>
        </Block.Body>
      )}
    </Block>
  );
}

/**
 * Poll a terraform run until it reaches a terminal state (succeeded / failed).
 * ~30-minute cap — destroys of large clusters can take ~15 minutes, and a
 * cap prevents this promise from hanging forever if the run backend is stuck.
 */
async function waitForRunToFinish(slug: string, envKey: string, runId: string): Promise<void> {
  const start = Date.now();
  const MAX_MS = 30 * 60 * 1000;
  for (;;) {
    const res = await fetch(`/api/v1/projects/${slug}/envs/${envKey}/terraform/${runId}`);
    if (!res.ok) throw new Error(`Couldn't poll destroy run: ${res.status}`);
    const j = (await res.json()) as { ok: boolean; run?: { status?: string } };
    const status = j.run?.status;
    if (status === "succeeded") return;
    if (status === "failed") throw new Error("Destroy failed — see the Infrastructure page's Terraform pipeline card for logs.");
    if (Date.now() - start > MAX_MS) {
      throw new Error(
        "Destroy is taking longer than 30 minutes; abandoning the wait. Check the Terraform pipeline card and re-delete state manually once it finishes.",
      );
    }
    await new Promise((r) => setTimeout(r, 5000));
  }
}
