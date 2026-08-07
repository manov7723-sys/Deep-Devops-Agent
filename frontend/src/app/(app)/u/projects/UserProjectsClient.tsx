"use client";

import { useRouter, useSearchParams } from "next/navigation";
import type { Route } from "next";
import { useEffect, useMemo, useState } from "react";
import { Btn, PageHead, TileGrid } from "@/components/ui";
import { ProjectCard } from "@/components/domain/ProjectCard";
import { CreateProjectWizard } from "@/components/modals/CreateProjectWizard";
import { DeleteProjectModal } from "@/components/modals/DeleteProjectModal";
import { useProjects } from "@/hooks/queries/projects";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";

function genDraftId() {
  // Deterministic enough for the wizard — wireframe-only state, no security.
  const t = typeof performance !== "undefined" ? Math.floor(performance.now() * 1000) : 1;
  return `d${t.toString(36)}`;
}

export function UserProjectsClient() {
  const { data: projects } = useProjects();
  // Only admins can create projects — the button and the empty-state "create
  // new" tile disappear for everyone else. /auth/me exposes this pre-computed;
  // the server-side gate on POST /projects still rejects a hand-crafted
  // attempt from a non-admin.
  const { data: me } = useQuery<{ user: { canCreateProjects: boolean } }>({
    queryKey: ["auth", "me"],
    queryFn: () => api.get("/auth/me"),
    staleTime: 60_000,
  });
  const canCreate = me?.user.canCreateProjects === true;
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
        sub={
          canCreate
            ? "Every product you're running on DeepAgent."
            : "Projects your admin has given you access to. Ask your admin to create new ones or grant additional access."
        }
        actions={
          canCreate ? (
            <Btn variant="primary" icon="plus" onClick={() => setWizard(true)}>
              New project
            </Btn>
          ) : null
        }
      />

      <TileGrid minTile={300}>
        {sorted.map((p) => (
          <ProjectCard
            key={p.id}
            project={p}
            variant="tile"
            onDelete={() => setToDelete({ slug: p.slug, name: p.name })}
          />
        ))}
        {canCreate && <ProjectCard variant="create-new" onCreate={() => setWizard(true)} />}
      </TileGrid>

      <DeleteProjectModal
        open={!!toDelete}
        onOpenChange={(o) => {
          if (!o) setToDelete(null);
        }}
        project={toDelete}
      />

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
