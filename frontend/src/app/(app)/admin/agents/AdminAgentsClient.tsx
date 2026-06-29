"use client";

import { useState } from "react";
import { Block, Btn, PageHead } from "@/components/ui";
import { AgentRow } from "@/components/domain/AgentRow";
import { PromptEditorModal } from "@/components/modals/PromptEditorModal";
import { AddAgentModal } from "@/components/modals/AddAgentModal";
import { useAdminAgentPatch, useAdminAgents } from "@/hooks/queries/admin-ops";

export function AdminAgentsClient() {
  const { data: agents } = useAdminAgents();
  const patch = useAdminAgentPatch();
  const [editingId, setEditingId] = useState<string | null>(null);
  const [addOpen, setAddOpen] = useState(false);

  const editing = agents?.find((a) => a.id === editingId);

  return (
    <div className="col gap-5">
      <PageHead
        title="Agents"
        sub="DevOps reviewers and operators. Configure skills, triggers, prompts and approvals."
        actions={
          <Btn variant="primary" icon="plus" onClick={() => setAddOpen(true)}>
            New agent
          </Btn>
        }
      />
      {agents ? (
        <div className="col gap-3">
          {agents.map((a) => (
            <AgentRow
              key={a.id}
              agent={a}
              onEditPrompt={(id) => setEditingId(id)}
              onToggle={(id, on) => patch.mutate({ id, patch: { on } })}
            />
          ))}
        </div>
      ) : (
        <Block>
          <Block.Loading />
        </Block>
      )}
      {editing && (
        <PromptEditorModal
          open={!!editingId}
          onOpenChange={(open) => !open && setEditingId(null)}
          agentName={editing.name}
          initialPrompt={editing.prompt}
          loading={patch.isPending}
          onSave={async (prompt) => {
            await patch.mutateAsync({ id: editing.id, patch: { prompt } });
            setEditingId(null);
          }}
        />
      )}

      <AddAgentModal open={addOpen} onOpenChange={setAddOpen} />
    </div>
  );
}
