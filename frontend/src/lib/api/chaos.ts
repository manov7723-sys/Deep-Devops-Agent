/**
 * Mock chaos toggles — exercises loading + error states across every screen.
 *
 * Read in two places:
 *  - api.client wraps every fetch in this delay + maybe-fail.
 *  - DataTable/Block consumers still hit their own loading/error props.
 *
 * URL takes precedence over the persisted store so a teammate can share a
 * `?chaos=fail` link to demo error states.
 */
"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";

export type ChaosLatency = "off" | "slow" | "very-slow";
export type ChaosFailure = "off" | "10%" | "50%" | "always";

export type ChaosState = {
  latency: ChaosLatency;
  failure: ChaosFailure;
  set: (patch: Partial<Pick<ChaosState, "latency" | "failure">>) => void;
  reset: () => void;
};

const LATENCY_MS: Record<ChaosLatency, number> = {
  off: 0,
  slow: 900,
  "very-slow": 2400,
};

const FAILURE_RATE: Record<ChaosFailure, number> = {
  off: 0,
  "10%": 0.1,
  "50%": 0.5,
  always: 1,
};

const DEFAULTS: Pick<ChaosState, "latency" | "failure"> = {
  latency: "off",
  failure: "off",
};

export const useChaos = create<ChaosState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      set: (patch) => set(patch),
      reset: () => set(DEFAULTS),
    }),
    {
      name: "dda-chaos",
      storage: createJSONStorage(() =>
        typeof localStorage !== "undefined" ? localStorage : (undefined as never),
      ),
    },
  ),
);

/**
 * Returns the effective chaos state, considering URL params first.
 * Safe in both client and server contexts — falls back to defaults SSR-side.
 */
export function getEffectiveChaos(): { latencyMs: number; failureRate: number } {
  if (typeof window === "undefined") return { latencyMs: 0, failureRate: 0 };
  const params = new URLSearchParams(window.location.search);
  const urlChaos = params.get("chaos");
  if (urlChaos === "slow") return { latencyMs: LATENCY_MS.slow, failureRate: 0 };
  if (urlChaos === "very-slow") return { latencyMs: LATENCY_MS["very-slow"], failureRate: 0 };
  if (urlChaos === "fail") return { latencyMs: 0, failureRate: 1 };
  if (urlChaos === "fail-some") return { latencyMs: LATENCY_MS.slow, failureRate: 0.5 };
  const s = useChaos.getState();
  return { latencyMs: LATENCY_MS[s.latency], failureRate: FAILURE_RATE[s.failure] };
}

export function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms));
}
