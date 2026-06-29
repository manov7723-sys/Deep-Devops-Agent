/**
 * Dev-mode helper: parse a fetch response through a zod schema.
 * In production this is a no-op cast — never block prod traffic on parse failures.
 * In dev, parse mismatches are logged loudly so mock drift is visible immediately.
 */
import type { z } from "zod";
import { api } from "./client";

const PROD = process.env.NODE_ENV === "production";

export async function getValidated<T extends z.ZodTypeAny>(
  path: string,
  schema: T,
  params?: Record<string, string | number | undefined>,
): Promise<z.infer<T>> {
  const raw = await api.get<unknown>(path, params);
  if (PROD) return raw as z.infer<T>;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    console.warn(
      `[contract] ${path} response failed schema: ${parsed.error.errors
        .map((e) => `${e.path.join(".")}: ${e.message}`)
        .join("; ")}`,
    );
    return raw as z.infer<T>;
  }
  return parsed.data;
}
