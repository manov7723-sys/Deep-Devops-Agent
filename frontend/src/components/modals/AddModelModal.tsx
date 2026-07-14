"use client";

import { useEffect, useState } from "react";
import { Btn, Field, Input, Modal, Select, Toggle } from "@/components/ui";
import { useAdminModelCreate } from "@/hooks/queries/admin-ops";

type Provider = "Anthropic" | "OpenAI" | "Groq";

/**
 * Curated preset list per provider. Admin can pick from these (recommended)
 * or type any other ID via the "Custom name" toggle. Keep the lists short —
 * we only ship presets the agent runtime actually supports today.
 */
const PRESETS: Record<Provider, { value: string; label: string; ctx?: number; note?: string }[]> = {
  Anthropic: [
    { value: "claude-opus-4-8", label: "Claude Opus 4.8 (most capable)", ctx: 200_000 },
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6 (balanced)", ctx: 200_000 },
    { value: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", ctx: 200_000 },
    { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5 (fast / cheap)", ctx: 200_000 },
    { value: "claude-fable-5", label: "Claude Fable 5 (creative)", ctx: 200_000 },
  ],
  OpenAI: [
    { value: "gpt-4o", label: "GPT-4o (general purpose)", ctx: 128_000 },
    { value: "gpt-4o-mini", label: "GPT-4o mini (fast / cheap)", ctx: 128_000 },
    { value: "gpt-4-turbo", label: "GPT-4 Turbo", ctx: 128_000 },
    { value: "o1", label: "o1 (reasoning)", ctx: 200_000 },
    { value: "o3-mini", label: "o3-mini (reasoning, fast)", ctx: 200_000 },
  ],
  Groq: [
    { value: "llama-3.3-70b-versatile", label: "Llama 3.3 70B (versatile)", ctx: 128_000 },
    { value: "llama-3.1-8b-instant", label: "Llama 3.1 8B (instant)", ctx: 128_000 },
    {
      value: "llama-3.2-90b-vision-preview",
      label: "Llama 3.2 90B Vision (preview)",
      ctx: 128_000,
    },
    { value: "mixtral-8x7b-32768", label: "Mixtral 8x7B (32k ctx)", ctx: 32_768 },
    { value: "gemma2-9b-it", label: "Gemma 2 9B (instruction tuned)", ctx: 8192 },
    { value: "qwen-2.5-32b", label: "Qwen 2.5 32B", ctx: 128_000 },
    {
      value: "deepseek-r1-distill-llama-70b",
      label: "DeepSeek R1 distill 70B (reasoning)",
      ctx: 128_000,
    },
  ],
};

export interface AddModelModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

export function AddModelModal({ open, onOpenChange }: AddModelModalProps) {
  const create = useAdminModelCreate();
  const [provider, setProvider] = useState<Provider>("Anthropic");
  const [preset, setPreset] = useState<string>(PRESETS.Anthropic[0]!.value);
  const [custom, setCustom] = useState(false);
  const [customName, setCustomName] = useState("");
  const [enabled, setEnabled] = useState(true);
  const [isDefault, setIsDefault] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setProvider("Anthropic");
    setPreset(PRESETS.Anthropic[0]!.value);
    setCustom(false);
    setCustomName("");
    setEnabled(true);
    setIsDefault(false);
    setError(null);
  }, [open]);

  // Switching provider resets the preset to that provider's first option.
  function switchProvider(p: Provider) {
    setProvider(p);
    setPreset(PRESETS[p][0]!.value);
  }

  const resolvedName = (custom ? customName.trim() : preset).trim();
  const ctxFromPreset = PRESETS[provider].find((p) => p.value === preset)?.ctx;
  const canSubmit = resolvedName.length > 0;

  async function submit() {
    setError(null);
    try {
      await create.mutateAsync({
        name: resolvedName,
        provider,
        enabled,
        isDefault,
        ...(ctxFromPreset && !custom ? { ctxTokens: ctxFromPreset } : {}),
      });
      onOpenChange(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Could not create model.");
    }
  }

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="Add model"
      description="Catalog entry for the chat agent. Use presets for known model IDs or type a custom one."
      width={560}
      footer={
        <>
          <Btn variant="ghost" onClick={() => onOpenChange(false)} disabled={create.isPending}>
            Cancel
          </Btn>
          <Btn
            variant="primary"
            icon="check"
            loading={create.isPending}
            disabled={!canSubmit}
            onClick={submit}
          >
            Add model
          </Btn>
        </>
      }
    >
      <div className="col gap-4">
        <Field label="Provider">
          <Select
            value={provider}
            onValueChange={(v) => switchProvider(v as Provider)}
            ariaLabel="Provider"
            options={[
              { value: "Anthropic", label: "Anthropic (Claude)" },
              { value: "OpenAI", label: "OpenAI (GPT / o-series)" },
              { value: "Groq", label: "Groq (Llama / Mixtral / DeepSeek)" },
            ]}
          />
        </Field>

        {!custom ? (
          <Field label="Model" hint="Pick a known model ID. Switch to Custom for anything else.">
            <Select
              value={preset}
              onValueChange={setPreset}
              ariaLabel="Model"
              options={PRESETS[provider].map((p) => ({ value: p.value, label: p.label }))}
            />
          </Field>
        ) : (
          <Field
            label="Custom model ID"
            required
            hint="Exactly as the provider expects it in API calls."
          >
            <Input
              className="mono"
              placeholder={
                provider === "OpenAI"
                  ? "gpt-4.1-2025-..."
                  : provider === "Groq"
                    ? "llama-3.3-70b-versatile"
                    : "claude-..."
              }
              value={customName}
              onChange={(e) => setCustomName(e.target.value)}
              autoFocus
            />
          </Field>
        )}

        <button
          type="button"
          className="auth-link"
          onClick={() => setCustom((c) => !c)}
          style={{
            background: "none",
            border: "none",
            padding: 0,
            color: "var(--accent)",
            cursor: "pointer",
            fontSize: 12.5,
            textAlign: "left",
            width: "fit-content",
          }}
        >
          {custom ? "← Use a preset instead" : "Use a custom model ID instead"}
        </button>

        <div
          className="col gap-3"
          style={{
            padding: 12,
            background: "var(--surface-2)",
            borderRadius: 8,
            border: "1px solid var(--border)",
          }}
        >
          <div className="row between">
            <div className="col">
              <span style={{ fontWeight: 600, fontSize: 13 }}>Enabled</span>
              <span className="faint" style={{ fontSize: 11.5 }}>
                Off = ignored even when picked as default.
              </span>
            </div>
            <Toggle checked={enabled} onCheckedChange={setEnabled} ariaLabel="Enabled" />
          </div>
          <div className="row between">
            <div className="col">
              <span style={{ fontWeight: 600, fontSize: 13 }}>Set as platform default</span>
              <span className="faint" style={{ fontSize: 11.5 }}>
                Replaces whichever model was previously the default.
              </span>
            </div>
            <Toggle checked={isDefault} onCheckedChange={setIsDefault} ariaLabel="Default" />
          </div>
        </div>

        <p className="faint" style={{ fontSize: 11.5, lineHeight: 1.4 }}>
          API key required:{" "}
          <code className="mono">
            {provider === "OpenAI"
              ? "OPENAI_API_KEY"
              : provider === "Groq"
                ? "GROQ_API_KEY"
                : "ANTHROPIC_API_KEY"}
          </code>{" "}
          must be set on the server.
        </p>

        {error && (
          <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">
            {error}
          </p>
        )}
      </div>
    </Modal>
  );
}
