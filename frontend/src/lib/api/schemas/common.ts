import { z } from "zod";

export const Tone = z.enum(["ok", "warn", "danger", "info", "accent"]);
export type Tone = z.infer<typeof Tone>;

export const EnvId = z.enum(["alpha", "beta", "release"]);
export type EnvId = z.infer<typeof EnvId>;

export const Money = z.object({
  amount: z.number(),
  currency: z.string().default("USD"),
});
export type Money = z.infer<typeof Money>;

export const Entitlement = z.union([z.number(), z.literal("unlimited")]);
export type Entitlement = z.infer<typeof Entitlement>;

export const Density = z.enum(["compact", "regular", "comfy"]);
export type Density = z.infer<typeof Density>;

export const Theme = z.enum(["dark", "light"]);
export type Theme = z.infer<typeof Theme>;
