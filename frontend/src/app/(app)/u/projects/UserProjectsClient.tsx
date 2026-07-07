"use client";

import { useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
import { useEffect, useMemo, useState } from "react";
import { Btn, PageHead, TileGrid } from "@/components/ui";
import { ProjectCard } from "@/components/domain/ProjectCard";
import { CreateProjectWizard } from "@/components/modals/CreateProjectWizard";
import { DeleteProjectModal } from "@/components/modals/DeleteProjectModal";
import { useProjects } from "@/hooks/queries/projects";

function genDraftId() {
  // Deterministic enough for the wizard — wireframe-only state, no security.
  const t = typeof performance !== "undefined" ? Math.floor(performance.now() * 1000) : 1;
  return `d${t.toString(36)}`;
}

export function UserProjectsClient() {
  const { data: projects } = useProjects();
  const router = useRouter();
  const params = useSearchParams();
  const wizardOpen = params.get("new") === "1";
  const stepParam = parseInt(params.get("step") ?? "1", 10);
  const step = Number.isFinite(stepParam) && stepParam >= 1 && stepParam <= 4 ? stepParam : 1;
  const draftId = params.get("draft");

  // If wizard is opened without a draft id, mint one and reflect in URL.
  useEffect(() => {
    if (wizardOpen && !draftId) {
      const next = new URLSearchParams(params);
      next.set("new", "1");
      next.set("step", String(step));
      next.set("draft", genDraftId());
      router.replace((`/u/projects?` + next.toString()) as Route);
    }
  }, [wizardOpen, draftId, step, params, router]);

  function setWizard(open: boolean) {
    if (!open) {
      router.replace("/u/projects" as Route);
    } else {
      const next = new URLSearchParams();
      next.set("new", "1");
      next.set("step", "1");
      next.set("draft", genDraftId());
      router.push((`/u/projects?` + next.toString()) as Route);
    }
  }

  function setStep(nextStep: number) {
    const next = new URLSearchParams(params);
    next.set("step", String(nextStep));
    router.replace((`/u/projects?` + next.toString()) as Route);
  }

  const sorted = useMemo(() => projects ?? [], [projects]);
  const [toDelete, setToDelete] = useState<{ slug: string; name: string } | null>(null);

  return (
    <div className="col gap-5">
      <PageHead
        title="Projects"
        sub="Every product you're running on DeepAgent."
        actions={
          <Btn variant="primary" icon="plus" onClick={() => setWizard(true)}>
            New project
          </Btn>
        }
      />

      <TileGrid minTile={300}>
        {sorted.map((p) => (
          <ProjectCard key={p.id} project={p} variant="tile" onDelete={() => setToDelete({ slug: p.slug, name: p.name })} />
        ))}
        <ProjectCard variant="create-new" onCreate={() => setWizard(true)} />
      </TileGrid>

      <DeleteProjectModal open={!!toDelete} onOpenChange={(o) => { if (!o) setToDelete(null); }} project={toDelete} />

      {wizardOpen && draftId && (
        <CreateProjectWizard
          open={wizardOpen}
          step={step}
          draftId={draftId}
          onOpenChange={setWizard}
          onStepChange={setStep}
        />
      )}
    </div>
  );
}
