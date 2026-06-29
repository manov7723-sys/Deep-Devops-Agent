"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";

/**
 * /me/usage shape — matches `getMyUsage` in server/billing/billing.ts.
 * Returns null when the user has no Usage row yet (e.g. they never subscribed).
 */
export type MeUsage = {
  periodStart: string;
  periodEnd: string;
  agentRunsUsed: number;
  agentRunsLimit: number | null;
  deploysUsed: number;
  deploysLimit: number | null;
  seatsUsed: number;
  seatsLimit: number | null;
  envsUsed: number;
  envsLimit: number | null;
  tokensUsed: number;
  tokensGranted: number;
  tokensRemaining: number;
  /** Super-admins see "Unlimited" instead of a numeric balance. */
  unlimited: boolean;
  samples: Array<{ weekStart: string; tokens: number }>;
};

/**
 * /me/subscription (and the /me/plan alias) shape — matches `getMySubscription`.
 * Returns null when the user has no Subscription row yet.
 */
export type MeSubscription = {
  id: string;
  planTier: "Free" | "Pro" | "Scale" | "Enterprise";
  planName: string;
  status:
    | "trialing"
    | "active"
    | "past_due"
    | "canceled"
    | "unpaid"
    | "incomplete"
    | "incomplete_expired"
    | "paused";
  basePriceCents: number;
  currency: string;
  cancelAtPeriodEnd: boolean;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  trialEndsAt: string | null;
  canceledAt: string | null;
  renewsLabel: string | null;
};

export function useUsage() {
  return useQuery({
    queryKey: ["me", "usage"],
    queryFn: async () => {
      // Server now always returns a populated MeUsage (zero-state when the
      // user has no Usage row yet), so the badge never falls back to "—".
      const res = await api.get<{ usage: MeUsage }>("/me/usage");
      return res.usage;
    },
    staleTime: 30_000,
  });
}

export function usePlan() {
  return useQuery({
    queryKey: ["me", "plan"],
    queryFn: async () => {
      const res = await api.get<{ subscription: MeSubscription | null }>("/me/plan");
      return res.subscription;
    },
    staleTime: 60_000,
  });
}

/** /me/invoices — Stripe-synced billing history with hosted view + PDF links. */
export type MeInvoice = {
  id: string;
  number: string | null;
  amountCents: number;
  currency: string;
  status: "draft" | "open" | "paid" | "void" | "uncollectible";
  hostedInvoiceUrl: string | null;
  pdfUrl: string | null;
  issuedAt: string;
  paidAt: string | null;
};

export function useInvoices() {
  return useQuery({
    queryKey: ["me", "invoices"],
    queryFn: async () => {
      const res = await api.get<{ invoices: MeInvoice[] }>("/me/invoices");
      return res.invoices;
    },
    staleTime: 30_000,
  });
}
