/**
 * Prisma client singleton.
 *
 * Phase 11 — wraps PrismaClient with the Next.js dev-mode HMR safety pattern
 * (one instance per server lifetime, not per import).
 */
import { PrismaClient } from "@prisma/client";

declare global {
  // eslint-disable-next-line no-var
  var __ddaPrisma: PrismaClient | undefined;
}

export const prisma =
  global.__ddaPrisma ??
  new PrismaClient({
    log: process.env.DDA_PRISMA_LOG === "1" ? ["query", "error", "warn"] : ["error"],
  });

if (process.env.NODE_ENV !== "production") {
  global.__ddaPrisma = prisma;
}
