"use client";

import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import type { Theme, Density } from "@/lib/api/schemas";

export const ACCENTS = [
  { id: "violet", label: "Violet", hue: 285 },
  { id: "blue", label: "Blue", hue: 235 },
  { id: "emerald", label: "Emerald", hue: 158 },
  { id: "rose", label: "Rose", hue: 22 },
] as const;
export type AccentId = (typeof ACCENTS)[number]["id"];

export const DENSITY_SCALE: Record<Density, number> = {
  compact: 0.85,
  regular: 1,
  comfy: 1.16,
};

export const FONTS = ["Plus Jakarta Sans", "Manrope", "Hanken Grotesk", "Inter"] as const;
export type FontFamily = (typeof FONTS)[number];

export type TweaksState = {
  theme: Theme;
  accent: AccentId;
  density: Density;
  font: FontFamily;
  set: (patch: Partial<Omit<TweaksState, "set" | "reset" | "hydrated">>) => void;
  reset: () => void;
  hydrated: boolean;
};

const DEFAULTS: Omit<TweaksState, "set" | "reset" | "hydrated"> = {
  theme: "dark",
  accent: "violet",
  density: "regular",
  font: "Plus Jakarta Sans",
};

export const useTweaks = create<TweaksState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      hydrated: false,
      set: (patch) => set(patch),
      reset: () => set(DEFAULTS),
    }),
    {
      name: "dda-tweaks",
      storage: createJSONStorage(() => localStorage),
      onRehydrateStorage: () => (state) => {
        if (state) state.hydrated = true;
      },
    },
  ),
);

export function applyTweaksToDocument(
  t: Pick<TweaksState, "theme" | "accent" | "density" | "font">,
) {
  if (typeof document === "undefined") return;
  const accent = ACCENTS.find((a) => a.id === t.accent) ?? ACCENTS[0];
  document.documentElement.dataset.theme = t.theme;
  document.documentElement.style.setProperty("--accent-h", String(accent.hue));
  document.documentElement.style.setProperty("--density", String(DENSITY_SCALE[t.density]));
  document.documentElement.style.setProperty("--font-ui", `'${t.font}', system-ui, sans-serif`);
}
