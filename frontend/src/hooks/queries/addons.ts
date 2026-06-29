"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/lib/api/client";

/** Catalog row (public /addons). */
export type CatalogAddon = {
  id: string;
  name: string;
  icon: string;
  description: string;
  priceCents: number;
  currency: string;
  tokenGrant: number;
  active: boolean;
};

/** Purchased-by-this-user row (/me/addons). */
export type MyAddon = {
  id: string;
  name: string;
  icon: string;
  priceCents: number;
  status: "active" | "cancelled" | "pending";
  purchasedAt: string;
};

const CATALOG_KEY = ["billing", "addons", "catalog"];
const MINE_KEY = ["me", "addons"];

export function useAddonCatalog() {
  return useQuery({
    queryKey: CATALOG_KEY,
    queryFn: async () => {
      const res = await api.get<{ addons: CatalogAddon[] }>("/addons");
      return res.addons;
    },
    staleTime: 60_000,
  });
}

export function useMyAddons() {
  return useQuery({
    queryKey: MINE_KEY,
    queryFn: async () => {
      const res = await api.get<{ items: MyAddon[] }>("/me/addons");
      return res.items;
    },
    staleTime: 30_000,
  });
}

/**
 * Toggling an add-on starts a Stripe Checkout session for "add_addon". The UI
 * redirects to the returned URL; the actual subscription-item creation happens
 * via the Stripe webhook (`/billing/webhook`).
 *
 * This hook intentionally only handles the "add" half — cancelling an active
 * add-on goes through the Stripe Customer Portal.
 */
export function useStartAddonCheckout() {
  return useMutation({
    mutationFn: async (input: { addonId: string }) => {
      const res = await api.post<{ ok: boolean; url?: string; code?: string }>(
        "/billing/checkout",
        { purpose: "add_addon", addonId: input.addonId },
      );
      if (!res.ok || !res.url) throw new Error(res.code ?? "Checkout failed");
      return res.url;
    },
  });
}

/** Helpers — invalidate after a webhook-driven change has presumably landed. */
export function useInvalidateAddons() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: MINE_KEY });
}
