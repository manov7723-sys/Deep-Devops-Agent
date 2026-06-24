"use client";

import { useEffect, useState } from "react";
import { Btn, Field, Input, Modal, Select, Textarea, Toggle } from "@/components/ui";
import { useAdminAgentCreate, useAdminModels } from "@/hooks/queries/admin-ops";

export interface AddAgentModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

const PRESETS: Array<{
  name: string;
  skill: string;
  triggerDescription: string;
  approvalPolicy: string;
  systemPrompt: string;
}> = [
  {
    name: "Code Reviewer",
    skill: "code-review",
    triggerDescription: "Runs on every pull request opened against this project.",
    approvalPolicy: "Posts review comments. Merging still requires a human approval.",
    systemPrompt:
      "You are a senior code reviewer. Read each diff, flag risks, suggest improvements, and approve when the change is clean. Be specific, cite line numbers, and don't repeat low-value nitpicks.",
  },
  {
    name: "Infra Operator",
    skill: "infra-operator",
    triggerDescription: "Manual run from the project chat. Authorized for plan/apply on non-prod envs.",
    approvalPolicy: "Auto-apply on alpha/beta. Production requires human approval.",
    systemPrompt:
      "You are an infrastructure operator. Generate Terraform changes, run `terraform plan`, summarize the diff, and apply only after approval. Always include a rollback plan.",
  },
  {
    name: "Cost Sentinel",
    skill: "cost-sentinel",
    triggerDescription: "Nightly cron at 03:00 UTC. Also triggered when a deployment lands in release.",
    approvalPolicy: "Opens issues. Cannot apply changes directly.",
    systemPrompt:
      "You monitor cloud spend. Surface anomalies, untagged resources, idle capacity, and overprovisioning. Be concise and actionable.",
  },
  {
    name: "Custom",
    skill: "",
    triggerDescription: "",
    approvalPolicy: "",
    systemPrompt: "",
  },
];

export function AddAgentModal({ open, onOpenChange }: AddAgentModalProps) {
  const create = useAdminAgentCreate();
  const { data: models } = useAdminModels();
  const enabledModels = (models ?? []).filter((m) => m.on);

  const [presetIdx, setPresetIdx] = useState("0");
  const [name, setName] = useState(PRESETS[0]!.name);
  const [skill, setSkill] = useState(PRESETS[0]!.skill);
  const [triggerDescription, setTriggerDescription] = useState(PRESETS[0]!.triggerDescription);
  const [approvalPolicy, setApprovalPolicy] = useState(PRESETS[0]!.approvalPolicy);
  const [systemPrompt, setSystemPrompt] = useState(PRESETS[0]!.systemPrompt);
  const [modelId, setModelId] = useState<string>("");
  const [enabled, setEnabled] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    applyPreset(0);
    setEnabled(true);
    setError(null);
    // Pre-select the platform-default model if one exists.
    const def = enabledModels.find((m) => m.isDefault);
    setModelId(def?.id ?? "");
    // We intentionally don't include enabledModels in deps — re-running this
    // on every keystroke would wipe the user's selection.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  function applyPreset(idx: number) {
    const p = PRESETS[idx];
    if (!p) return;
    setPresetIdx(String(idx));
    setName(p.name);
    setSkill(p.skill);
    setTriggerDescription(p.triggerDescription);
    setApprovalPolicy(p.approvalPolicy);
    setSystemPrompt(p.systemPrompt);
  }

  const canSubmit =
    name.trim().length > 0 &&
    skill.trim().length > 0 &&
    triggerDescription.trim().length > 0 &&
    approvalPolicy.trim().length > 0 &&
    systemPrompt.trim().length > 0;

  async function submit() {
    setError(null);
    try {
      await create.mutateAsync({
        name: name.trim(),
        skill: skill.trim(),
        triggerDescription: triggerDescription.trim(),
        approvalPolicy: approvalPolicy.trim(),
        systemPrompt: systemPrompt.trim(),
        modelId: modelId || undefined,
        enabled,
      });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create agent.");
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New agent"
      description="Configure a Deep Agent personality with its trigger, skill, model and prompt."
      width={620}
      footer={
        <>
          <Btn variant="ghost" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Btn>
          <Btn
            variant="primary"
            icon="plus"
            loading={create.isPending}
            disabled={!canSubmit}
            onClick={submit}
          >
            Create agent
          </Btn>
        </>
      }
    >
      <div className="col gap-4">
        <Field
          label="Preset"
          hint="Start from a template — every field is still editable below."
        >
          <Select
            value={presetIdx}
            onValueChange={(v) => applyPreset(Number(v))}
            ariaLabel="Preset"
            options={PRESETS.map((p, i) => ({ value: String(i), label: p.name || "(blank)" }))}
          />
        </Field>

        <div className="row gap-3">
          <Field label="Name" required>
            <Input value={name} onChange={(e) => setName(e.target.value)} autoFocus />
          </Field>
          <Field label="Skill" required hint="Short slug used internally.">
            <Input
              className="mono"
              placeholder="code-review"
              value={skill}
              onChange={(e) => setSkill(e.target.value)}
            />
          </Field>
        </div>

        <Field label="Trigger description" required>
          <Input
            placeholder="Runs on every pull request…"
            value={triggerDescription}
            onChange={(e) => setTriggerDescription(e.target.value)}
          />
        </Field>

        <Field label="Approval policy" required>
          <Input
            placeholder="Auto-apply on non-prod. Production requires human approval."
            value={approvalPolicy}
            onChange={(e) => setApprovalPolicy(e.target.value)}
          />
        </Field>

        <Field
          label="Model"
          hint={
            enabledModels.length === 0
              ? "No models enabled. Add one in Admin → Models first."
              : "Leave blank to use the platform default."
          }
        >
          <Select
            value={modelId}
            onValueChange={setModelId}
            ariaLabel="Model"
            options={[
              { value: "", label: "Platform default" },
              ...enabledModels.map((m) => ({
                value: m.id,
                label: `${m.name} · ${m.provider}${m.isDefault ? " · default" : ""}`,
              })),
            ]}
          />
        </Field>

        <Field label="System prompt" required hint="Sent to the model as the system message on every turn.">
          <Textarea
            rows={6}
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
          />
        </Field>

        <div
          className="row between"
          style={{
            padding: "10px 12px",
            background: "var(--surface-2)",
            borderRadius: 8,
            border: "1px solid var(--border)",
          }}
        >
          <div className="col">
            <span style={{ fontWeight: 600, fontSize: 13 }}>Enabled</span>
            <span className="faint" style={{ fontSize: 11.5 }}>
              Disabled agents won&apos;t run their triggers.
            </span>
          </div>
          <Toggle checked={enabled} onCheckedChange={setEnabled} ariaLabel="Enabled" />
        </div>

        {error && (
          <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
