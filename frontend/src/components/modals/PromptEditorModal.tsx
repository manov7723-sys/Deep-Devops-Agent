"use client";

import { useEffect, useState } from "react";
import { Btn, Field, Modal, Textarea } from "@/components/ui";

export interface PromptEditorModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentName: string;
  initialPrompt: string;
  loading?: boolean;
  onSave: (prompt: string) => void;
}

export function PromptEditorModal({
  open,
  onOpenChange,
  agentName,
  initialPrompt,
  loading,
  onSave,
}: PromptEditorModalProps) {
  const [prompt, setPrompt] = useState(initialPrompt);

  useEffect(() => {
    setPrompt(initialPrompt);
  }, [initialPrompt, open]);

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      width={620}
      title={`Edit prompt — ${agentName}`}
      description="This system prompt is sent on every run. Keep it scoped and concrete."
      footer={
        <>
          <Btn variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Btn>
          <Btn variant="primary" icon="check" loading={loading} onClick={() => onSave(prompt)}>
            Save prompt
          </Btn>
        </>
      }
    >
      <Field
        label="System prompt"
        hint={`${prompt.length} chars — agent will receive this as the system message`}
      >
        <Textarea rows={10} value={prompt} onChange={(e) => setPrompt(e.target.value)} />
      </Field>
    </Modal>
  );
}
