/**
 * Typed fetch wrapper used by every TanStack Query hook.
 *
 * Phase 0 — mocks are wired via MSW + Next route handlers under /api/v1.
 * Phase 10 — chaos: optional latency + failure injection for demoing
 * loading + error states. URL ?chaos=slow|fail|very-slow|fail-some takes
 * precedence over the persisted Zustand store.
 * Phase 11 — swap-in: the route handlers stay; only what they call under
 * the hood changes from src/mocks/db to src/server/db (Prisma).
 */
import { getEffectiveChaos, sleep } from "./chaos";

const BASE = "/api/v1";

export type ApiError = {
  status: number;
  message: string;
  details?: unknown;
};

/**
 * Real Error subclass so unhandled rejections show a readable message in
 * Next.js's dev overlay (a plain `throw {status,message,...}` object
 * stringifies as "[object Object]"). Still carries `status` + `details` for
 * every existing consumer that reads them via `apiErrorMessage()` or a
 * `typeof e === "object"` guard — those checks succeed on Errors too, since
 * an Error instance IS an object with a message property.
 */
class ApiRequestError extends Error implements ApiError {
  status: number;
  details?: unknown;
  constructor(fields: ApiError) {
    super(fields.message);
    this.name = "ApiRequestError";
    this.status = fields.status;
    this.details = fields.details;
  }
}

async function request<T>(
  path: string,
  init?: RequestInit & { params?: Record<string, string | number | undefined> },
): Promise<T> {
  const chaos = getEffectiveChaos();
  if (chaos.latencyMs > 0) await sleep(chaos.latencyMs);
  if (chaos.failureRate > 0 && Math.random() < chaos.failureRate) {
    throw new ApiRequestError({
      status: 503,
      message: "Mock chaos injection",
      details: { path, chaos },
    });
  }
  const url = new URL(
    BASE + path,
    typeof window !== "undefined" ? window.location.origin : "http://localhost:3000",
  );
  if (init?.params) {
    for (const [k, v] of Object.entries(init.params)) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
  }
  const res = await fetch(url.toString(), {
    ...init,
    headers: {
      "Content-Type": "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new ApiRequestError({
      status: res.status,
      message: res.statusText || "Request failed",
      details: body,
    });
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

/**
 * Extract a human-readable message from a thrown ApiError. The client throws
 * `{ status, message: statusText, details: <body text> }` on non-2xx, so the
 * useful message is usually the JSON body's `message`, not `statusText`.
 */
export function apiErrorMessage(e: unknown, fallback = "Request failed"): string {
  if (e && typeof e === "object") {
    const ae = e as Partial<ApiError>;
    if (typeof ae.details === "string" && ae.details) {
      try {
        const j = JSON.parse(ae.details) as { message?: string; code?: string };
        if (j?.message) return j.message;
        if (j?.code) return j.code;
      } catch {
        /* details wasn't JSON */
      }
    }
    if (typeof ae.message === "string" && ae.message) return ae.message;
  }
  if (e instanceof Error) return e.message;
  return fallback;
}

export const api = {
  get: <T>(path: string, params?: Record<string, string | number | undefined>) =>
    request<T>(path, { method: "GET", params }),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "POST", body: body ? JSON.stringify(body) : undefined }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PATCH", body: body ? JSON.stringify(body) : undefined }),
  put: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: "PUT", body: body ? JSON.stringify(body) : undefined }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
};
