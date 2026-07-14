"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "@tanstack/react-form";
import { Btn, Field, Input, Modal } from "@/components/ui";
import { api } from "@/lib/api/client";

export interface GrantTokensModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Target user — defines which `/admin/users/:id/grant-tokens` we POST to. */
  user: { id: string; name: string; email: string } | null;
}

const PRESETS: Array<{ label: string; amount: number }> = [
  { label: "100K", amount: 100_000 },
  { label: "500K", amount: 500_000 },
  { label: "1M", amount: 1_000_000 },
  { label: "5M", amount: 5_000_000 },
];

export function GrantTokensModal({ open, onOpenChange, user }: GrantTokensModalProps) {
  const qc = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);

  const grant = useMutation({
    mutationFn: async (body: { amount: number; reason?: string }) => {
      if (!user) throw new Error("No user selected");
      const res = await api.post<{
        ok: boolean;
        tokensGranted?: number;
        tokensRemaining?: number;
        message?: string;
        code?: string;
      }>(`/admin/users/${user.id}/grant-tokens`, body);
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Could not grant tokens.");
      return res;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "users"] });
      qc.invalidateQueries({ queryKey: ["me", "usage"] });
    },
  });

  const form = useForm({
    defaultValues: { amount: "", reason: "" },
    onSubmit: async ({ value }) => {
      setServerError(null);
      const amount = Number.parseInt(value.amount, 10);
      if (!Number.isFinite(amount) || amount < 1) {
        setServerError("Amount must be at least 1.");
        return;
      }
      try {
        await grant.mutateAsync({ amount, reason: value.reason.trim() || undefined });
        form.reset();
        onOpenChange(false);
      } catch (e) {
        setServerError(e instanceof Error ? e.message : "Could not grant tokens.");
      }
    },
  });

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={user ? `Grant tokens to ${user.name}` : "Grant tokens"}
      description={user ? user.email : undefined}
      footer={
        <>
          <Btn variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Btn>
          <Btn
            variant="primary"
            icon="zap"
            loading={grant.isPending}
            onClick={() => form.handleSubmit()}
          >
            Grant tokens
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
          name="amount"
          validators={{
            onChange: ({ value }) => {
              if (!value) return "Amount is required";
              const n = Number.parseInt(value, 10);
              if (!Number.isFinite(n) || n < 1) return "Enter a positive whole number";
              return undefined;
            },
          }}
        >
          {(field) => (
            <Field
              label="Amount"
              required
              error={field.state.meta.errors[0]}
              hint="Whole tokens (e.g. 100000)"
            >
              <Input
                type="number"
                inputMode="numeric"
                step="1000"
                min="1"
                placeholder="100000"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                autoFocus
              />
              <div className="row gap-1" style={{ marginTop: 8 }}>
                {PRESETS.map((p) => (
                  <Btn
                    key={p.amount}
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => field.handleChange(String(p.amount))}
                  >
                    {p.label}
                  </Btn>
                ))}
              </div>
            </Field>
          )}
        </form.Field>

        <form.Field name="reason">
          {(field) => (
            <Field label="Reason" hint="Optional — appears in the audit log">
              <Input
                placeholder="Promo / refund / customer support credit"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            </Field>
          )}
        </form.Field>

        {serverError && (
          <div className="faint" style={{ color: "var(--danger)", fontSize: 12.5 }}>
            {serverError}
          </div>
        )}
      </form>
    </Modal>
  );
}
