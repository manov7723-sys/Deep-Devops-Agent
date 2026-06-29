"use client";

import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api/client";
import type {
  AdminDashboardPayload,
  AdminMcpSummary,
  AdminPlanSlice,
  AdminRecentSignup,
} from "@/lib/api/schemas/admin-api";
import type {
  SeedAdminPlan,
  SeedAdminSubscription,
} from "@/lib/legacy-types";
import type { AdminUserRow } from "@/lib/admin/aggregates";

export type AdminDashboard = AdminDashboardPayload;
export type AdminPlanSummary = AdminPlanSlice;
export type AdminMcp = AdminMcpSummary;
export type AdminSignup = AdminRecentSignup;

export function useAdminDashboard() {
  return useQuery({
    queryKey: ["admin", "dashboard"],
    queryFn: () => api.get<AdminDashboardPayload>("/admin/dashboard"),
    staleTime: 60_000,
  });
}

// NOTE: the three hooks below still type-against the legacy Seed* shapes —
// /admin/users, /admin/plans, /admin/subscriptions return real Prisma rows
// that don't yet carry the richer display fields the admin pages render
// (popular/price/period for plans, addons/base for subscriptions, etc.).
// Casting via `as` keeps the clients compiling; enrich the routes to drop
// the cast.
export function useAdminUsers(q: string) {
  return useQuery({
    queryKey: ["admin", "users", q],
    queryFn: () => api.get<AdminUserRow[]>("/admin/users", { q }),
    staleTime: 30_000,
  });
}

export function useAdminPlans() {
  return useQuery({
    queryKey: ["admin", "plans"],
    queryFn: () => api.get<SeedAdminPlan[]>("/admin/plans"),
    staleTime: 5 * 60_000,
  });
}

export function useAdminSubscriptions() {
  return useQuery({
    queryKey: ["admin", "subscriptions"],
    queryFn: () => api.get<SeedAdminSubscription[]>("/admin/subscriptions"),
    staleTime: 60_000,
  });
}
