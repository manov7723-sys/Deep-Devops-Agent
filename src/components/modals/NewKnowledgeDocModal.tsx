"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "@tanstack/react-form";
import { Btn, Field, Input, Modal, Select, Textarea, type SelectOption } from "@/components/ui";
import { api } from "@/lib/api/client";

export interface NewKnowledgeDocModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  projectSlug: string;
}

const TYPE_OPTIONS: SelectOption[] = [
  { value: "Doc", label: "Documentation" },
  { value: "Runbook", label: "Runbook" },
];

/**
 * Create a written KnowledgeDoc — agents pull this content into their
 * context. PDF/file upload uses a different flow (storage → ingest job).
 */
export function NewKnowledgeDocModal({ open, onOpenChange, projectSlug }: NewKnowledgeDocModalProps) {
  const qc = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: async (body: {
      title: string;
      excerpt: string;
      body: string;
      type: "Doc" | "Runbook";
      tags: string[];
    }) => {
      const res = await api.post<{ ok: boolean; doc?: { id: string }; message?: string; code?: string }>(
        `/projects/${projectSlug}/knowledge`,
        body,
      );
      if (!res.ok || !res.doc) throw new Error(res.message ?? res.code ?? "Could not create doc.");
      return res.doc;
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["p", projectSlug, "knowledge"] }),
  });

  const form = useForm({
    defaultValues: { title: "", excerpt: "", body: "", type: "Doc" as "Doc" | "Runbook", tags: "" },
    onSubmit: async ({ value }) => {
      setServerError(null);
      const tags = value.tags
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
        .slice(0, 12);
      try {
        await create.mutateAsync({
          title: value.title.trim(),
          excerpt: value.excerpt.trim() || value.body.slice(0, 140),
          body: value.body.trim(),
          type: value.type,
          tags,
        });
        form.reset();
        onOpenChange(false);
      } catch (e) {
        setServerError(e instanceof Error ? e.message : "Could not create doc.");
      }
    },
  });

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New knowledge doc"
      description="Markdown is welcome — agents read the body verbatim."
      width={620}
      footer={
        <>
          <Btn variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Btn>
          <Btn variant="primary" icon="plus" loading={create.isPending} onClick={() => form.handleSubmit()}>
            Create
          </Btn>
        </>
      }
    >
      <form
        className="col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          form.handleSubmit();
        }}
      >
        <form.Field
          name="title"
          validators={{
            onChange: ({ value }) => (!value.trim() ? "Title is required" : value.length > 200 ? "Max 200 chars" : undefined),
          }}
        >
          {(field) => (
            <Field label="Title" required error={field.state.meta.errors[0]}>
              <Input
                placeholder="Service onboarding · v2"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                autoFocus
              />
            </Field>
          )}
        </form.Field>

        <form.Field name="type">
          {(field) => (
            <Field label="Section" hint="Documentation vs Runbook — affects grouping on the Knowledge tab.">
              <Select
                options={TYPE_OPTIONS}
                value={field.state.value}
                onValueChange={(v) => field.handleChange(v as "Doc" | "Runbook")}
                ariaLabel="Section"
              />
            </Field>
          )}
        </form.Field>

        <form.Field name="excerpt">
          {(field) => (
            <Field label="Excerpt" hint="One-line summary for the card. Auto-derived from body if blank.">
              <Input
                placeholder="Quick context for what this doc covers."
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            </Field>
          )}
        </form.Field>

        <form.Field
          name="body"
          validators={{
            onChange: ({ value }) => (!value.trim() ? "Body is required" : undefined),
          }}
        >
          {(field) => (
            <Field label="Body" required error={field.state.meta.errors[0]}>
              <Textarea
                rows={10}
                placeholder={`# Heading\n\nMarkdown supported. Agents read this verbatim.`}
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            </Field>
          )}
        </form.Field>

        <form.Field name="tags">
          {(field) => (
            <Field label="Tags" hint="Comma-separated. Used for filtering. Max 12.">
              <Input
                placeholder="onboarding, payments, oncall"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            </Field>
          )}
        </form.Field>

        {serverError && (
          <p style={{ fontSize: 12.5, color: "var(--danger)" }} role="alert">
            {serverError}
          </p>
        )}
      </form>
    </Modal>
  );
}
