import { z } from "zod";
import { Tone } from "./common";

export const NavBadge = z.object({
  count: z.number(),
  tone: Tone.optional(),
});
export type NavBadge = z.infer<typeof NavBadge>;

export const NavItem = z.object({
  id: z.string(),
  label: z.string(),
  icon: z.string(),
  href: z.string(),
  badge: NavBadge.optional(),
});
export type NavItem = z.infer<typeof NavItem>;

export const Notification = z.object({
  id: z.string(),
  icon: z.string(),
  title: z.string(),
  subtitle: z.string(),
  unread: z.boolean().default(false),
  createdAt: z.string().datetime(),
});
export type Notification = z.infer<typeof Notification>;
