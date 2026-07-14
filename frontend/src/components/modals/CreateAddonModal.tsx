"use client";

import { useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useForm } from "@tanstack/react-form";
import { Btn, Field, Input, Modal, Select, type SelectOption } from "@/components/ui";
import { api } from "@/lib/api/client";

export interface CreateAddonModalProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * Curated icon set for addon cards — must match an `IconName` from
 * @/components/ui/Icon. We expose a small subset that visually reads
 * well at the addon size and matches the "token pack / extra capacity"
 * semantics.
 */
const ICON_OPTIONS: SelectOption[] = [
  { value: "zap", label: "Zap (energy)" },
  { value: "addon", label: "Add-on (plus)" },
  { value: "gauge", label: "Gauge" },
  { value: "server", label: "Server" },
  { value: "bot", label: "Bot" },
  { value: "model", label: "Model" },
  { value: "card", label: "Card" },
  { value: "stats", label: "Stats" },
  { value: "cloud", label: "Cloud" },
  { value: "layers", label: "Layers" },
];

const CURRENCY_OPTIONS: SelectOption[] = [
  { value: "usd", label: "USD ($)" },
  { value: "eur", label: "EUR (€)" },
  { value: "gbp", label: "GBP (£)" },
  { value: "inr", label: "INR (₹)" },
  { value: "cad", label: "CAD ($)" },
  { value: "aud", label: "AUD ($)" },
];

type CreatedAddon = {
  id: string;
  name: string;
  priceCents: number;
  currency: string;
  tokenGrant: number;
};

type CreateInput = {
  name: string;
  icon: string;
  description: string;
  /** Form takes dollars; sent as `priceCents` to the API. */
  priceDollars: string;
  currency: string;
  /** Form takes whole tokens, e.g. "100000". 0 = non-token addon. */
  tokenGrant: string;
  stripeProductId: string;
  stripePriceId: string;
};

export function CreateAddonModal({ open, onOpenChange }: CreateAddonModalProps) {
  const qc = useQueryClient();
  const [serverError, setServerError] = useState<string | null>(null);

  const create = useMutation({
    mutationFn: async (body: {
      name: string;
      icon: string;
      description: string;
      priceCents: number;
      currency: string;
      tokenGrant: number;
      stripeProductId?: string;
      stripePriceId?: string;
    }) => {
      const res = await api.post<{
        ok: boolean;
        addon?: CreatedAddon;
        message?: string;
        code?: string;
      }>("/admin/addons", body);
      if (!res.ok) throw new Error(res.message ?? res.code ?? "Could not create add-on.");
      return res.addon;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["admin", "addons"] });
      qc.invalidateQueries({ queryKey: ["billing", "addons", "catalog"] });
    },
  });

  const form = useForm({
    defaultValues: {
      name: "",
      icon: "zap",
      description: "",
      priceDollars: "",
      currency: "usd",
      tokenGrant: "",
      stripeProductId: "",
      stripePriceId: "",
    } satisfies CreateInput,
    onSubmit: async ({ value }) => {
      setServerError(null);
      const priceCents = Math.round(Number.parseFloat(value.priceDollars) * 100);
      const tokenGrant = value.tokenGrant ? Number.parseInt(value.tokenGrant, 10) : 0;
      if (!Number.isFinite(priceCents) || priceCents < 0) {
        setServerError("Price must be a non-negative number.");
        return;
      }
      try {
        await create.mutateAsync({
          name: value.name.trim(),
          icon: value.icon,
          description: value.description.trim(),
          priceCents,
          currency: value.currency,
          tokenGrant,
          stripeProductId: value.stripeProductId.trim() || undefined,
          stripePriceId: value.stripePriceId.trim() || undefined,
        });
        form.reset();
        onOpenChange(false);
      } catch (e) {
        setServerError(e instanceof Error ? e.message : "Could not create add-on.");
      }
    },
  });

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="New add-on"
      description="Add a new purchasable add-on to the catalog. Users see it on the Subscription page."
      footer={
        <>
          <Btn variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Btn>
          <Btn
            variant="primary"
            icon="plus"
            loading={create.isPending}
            onClick={() => form.handleSubmit()}
          >
            Create add-on
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
          name="name"
          validators={{
            onChange: ({ value }) =>
              !value.trim()
                ? "Name is required"
                : value.length > 80
                  ? "Max 80 characters"
                  : undefined,
          }}
        >
          {(field) => (
            <Field label="Name" required error={field.state.meta.errors[0]}>
              <Input
                placeholder="e.g. Token pack — 100K"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
                autoFocus
              />
            </Field>
          )}
        </form.Field>

        <form.Field
          name="description"
          validators={{
            onChange: ({ value }) =>
              !value.trim()
                ? "Description is required"
                : value.length > 280
                  ? "Max 280 characters"
                  : undefined,
          }}
        >
          {(field) => (
            <Field label="Description" required error={field.state.meta.errors[0]}>
              <Input
                placeholder="Adds 100,000 agent tokens. Top up any time your balance runs low."
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            </Field>
          )}
        </form.Field>

        <div className="row gap-3">
          <form.Field name="icon">
            {(field) => (
              <Field label="Icon">
                <Select
                  options={ICON_OPTIONS}
                  value={field.state.value}
                  onValueChange={field.handleChange}
                  ariaLabel="Addon icon"
                />
              </Field>
            )}
          </form.Field>
          <form.Field name="currency">
            {(field) => (
              <Field label="Currency">
                <Select
                  options={CURRENCY_OPTIONS}
                  value={field.state.value}
                  onValueChange={field.handleChange}
                  ariaLabel="Currency"
                />
              </Field>
            )}
          </form.Field>
        </div>

        <div className="row gap-3">
          <form.Field
            name="priceDollars"
            validators={{
              onChange: ({ value }) => {
                if (!value) return "Price is required";
                const n = Number.parseFloat(value);
                if (!Number.isFinite(n) || n < 0) return "Enter a valid amount";
                return undefined;
              },
            }}
          >
            {(field) => (
              <Field
                label="Price"
                hint="One-time charge"
                required
                error={field.state.meta.errors[0]}
              >
                <Input
                  type="number"
                  inputMode="decimal"
                  step="0.01"
                  min="0"
                  placeholder="15.00"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </Field>
            )}
          </form.Field>

          <form.Field name="tokenGrant">
            {(field) => (
              <Field
                label="Token grant"
                hint="Tokens added to the buyer's balance on purchase (0 = not a token pack)"
              >
                <Input
                  type="number"
                  inputMode="numeric"
                  step="1000"
                  min="0"
                  placeholder="100000"
                  value={field.state.value}
                  onBlur={field.handleBlur}
                  onChange={(e) => field.handleChange(e.target.value)}
                />
              </Field>
            )}
          </form.Field>
        </div>

        <form.Field name="stripePriceId">
          {(field) => (
            <Field
              label="Stripe Price ID"
              hint="One-time price (price_…). Required for real purchases — leave blank to draft the catalog entry without Stripe."
            >
              <Input
                placeholder="price_1Tau…"
                value={field.state.value}
                onBlur={field.handleBlur}
                onChange={(e) => field.handleChange(e.target.value)}
              />
            </Field>
          )}
        </form.Field>

        <form.Field name="stripeProductId">
          {(field) => (
            <Field label="Stripe Product ID" hint="Optional. prod_…">
              <Input
                placeholder="prod_…"
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
