/**
 * Stripe client wrapper. Real mode talks to the Stripe REST API directly via
 * fetch (no SDK dependency); mock mode (DDA_BILLING_MOCK=1) returns
 * deterministic URLs and skips signature verification on webhooks so the
 * test harness can drive end-to-end.
 *
 * Required env vars (real mode):
 *   STRIPE_SECRET_KEY       — sk_live_… / sk_test_…
 *   STRIPE_WEBHOOK_SECRET   — whsec_…
 *   STRIPE_RETURN_URL       — origin for success / cancel / portal-return
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export function isMockMode(): boolean {
  return process.env.DDA_BILLING_MOCK === "1";
}

function readEnv(key: string): string {
  const v = process.env[key];
  if (!v && !isMockMode()) throw new Error(`Missing required env: ${key}`);
  return v ?? "";
}

const API = "https://api.stripe.com/v1";

export class StripeApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    public readonly stripeMessage: string,
    public readonly path: string,
  ) {
    super(`Stripe ${path} ${status} (${code}): ${stripeMessage}`);
    this.name = "StripeApiError";
  }
}

async function stripeFetch<T>(path: string, body: Record<string, string>): Promise<T> {
  const res = await fetch(`${API}${path}`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${readEnv("STRIPE_SECRET_KEY")}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    let code = `http_${res.status}`;
    let message = res.statusText;
    try {
      const parsed = (await res.json()) as {
        error?: { type?: string; code?: string; message?: string; param?: string };
      };
      if (parsed.error) {
        code = parsed.error.code ?? parsed.error.type ?? code;
        message = parsed.error.message ?? message;
        if (parsed.error.param) message += ` (param: ${parsed.error.param})`;
      }
    } catch {
      // Body wasn't JSON; keep the defaults.
    }
    throw new StripeApiError(res.status, code, message, path);
  }
  return (await res.json()) as T;
}

// ──────────────────────────────────────────────────────────────────
// Customers (real Stripe Customer object)
// ──────────────────────────────────────────────────────────────────

export type CreateCustomerArgs = {
  email: string;
  name?: string;
  metadata?: Record<string, string>;
};

export async function createStripeCustomer(args: CreateCustomerArgs): Promise<{ id: string }> {
  if (isMockMode()) {
    return { id: `cus_mock_${randomBytes(8).toString("hex")}` };
  }
  const body: Record<string, string> = { email: args.email };
  if (args.name) body.name = args.name;
  if (args.metadata) {
    for (const [k, v] of Object.entries(args.metadata)) {
      body[`metadata[${k}]`] = v;
    }
  }
  const customer = await stripeFetch<{ id: string }>("/customers", body);
  return { id: customer.id };
}

// ──────────────────────────────────────────────────────────────────
// Checkout
// ──────────────────────────────────────────────────────────────────

export type CheckoutMode = "subscription" | "setup" | "payment";

export type CheckoutSessionResult = {
  id: string;
  url: string;
};

export type CheckoutArgs = {
  mode: CheckoutMode;
  customerEmail: string;
  customerId?: string | null;
  priceId?: string; // required for subscription + payment modes
  successUrl: string;
  cancelUrl: string;
  metadata?: Record<string, string>;
};

export async function createCheckoutSession(args: CheckoutArgs): Promise<CheckoutSessionResult> {
  if (isMockMode()) {
    const id = `cs_mock_${randomBytes(8).toString("hex")}`;
    const url = `https://checkout.stripe.test/${id}`;
    return { id, url };
  }
  const body: Record<string, string> = {
    mode: args.mode,
    success_url: args.successUrl,
    cancel_url: args.cancelUrl,
  };
  if (args.customerId) body.customer = args.customerId;
  else body.customer_email = args.customerEmail;
  if (args.priceId) {
    body["line_items[0][price]"] = args.priceId;
    body["line_items[0][quantity]"] = "1";
  }
  if (args.metadata) {
    for (const [k, v] of Object.entries(args.metadata)) {
      body[`metadata[${k}]`] = v;
    }
  }
  const session = await stripeFetch<{ id: string; url: string }>("/checkout/sessions", body);
  return { id: session.id, url: session.url };
}

// ──────────────────────────────────────────────────────────────────
// Subscription updates (plan switch in place — no second checkout)
// ──────────────────────────────────────────────────────────────────

export type SubscriptionItemRow = {
  id: string;
  price: { id: string };
};

export async function retrieveSubscription(subscriptionId: string): Promise<{
  id: string;
  status: string;
  items: { data: SubscriptionItemRow[] };
  current_period_end?: number;
}> {
  if (isMockMode()) {
    return {
      id: subscriptionId,
      status: "active",
      items: { data: [{ id: "si_mock_seed", price: { id: "price_mock_existing" } }] },
    };
  }
  const res = await fetch(`${API}/subscriptions/${subscriptionId}`, {
    method: "GET",
    headers: { Authorization: `Bearer ${readEnv("STRIPE_SECRET_KEY")}` },
  });
  if (!res.ok) {
    const parsed = await res
      .json()
      .catch(() => ({}) as { error?: { code?: string; message?: string } });
    throw new StripeApiError(
      res.status,
      parsed.error?.code ?? `http_${res.status}`,
      parsed.error?.message ?? res.statusText,
      `/subscriptions/${subscriptionId}`,
    );
  }
  return (await res.json()) as {
    id: string;
    status: string;
    items: { data: SubscriptionItemRow[] };
    current_period_end?: number;
  };
}

export type ProrationBehavior = "create_prorations" | "none" | "always_invoice";

/**
 * Swap an active subscription onto a different price (plan switch).
 *
 * For UPGRADES we credit prorated time on the old plan and bill the new plan
 * immediately — `create_prorations` + `always_invoice` issues the proration
 * invoice right away. For DOWNGRADES `create_prorations` alone schedules the
 * proration credit on the next normal invoice instead, which is the standard
 * recommendation so customers aren't charged extra mid-cycle for downgrading.
 */
export async function updateSubscriptionPrice(args: {
  subscriptionId: string;
  newPriceId: string;
  prorationBehavior?: ProrationBehavior;
}): Promise<{ id: string; status: string; stripePriceId: string }> {
  if (isMockMode()) {
    return { id: args.subscriptionId, status: "active", stripePriceId: args.newPriceId };
  }
  const current = await retrieveSubscription(args.subscriptionId);
  const item = current.items.data[0];
  if (!item) {
    throw new StripeApiError(
      400,
      "no_item",
      "Subscription has no items to update.",
      `/subscriptions/${args.subscriptionId}`,
    );
  }
  if (item.price.id === args.newPriceId) {
    return { id: args.subscriptionId, status: current.status, stripePriceId: args.newPriceId };
  }
  const body: Record<string, string> = {
    "items[0][id]": item.id,
    "items[0][price]": args.newPriceId,
    proration_behavior: args.prorationBehavior ?? "create_prorations",
  };
  const updated = await stripeFetch<{
    id: string;
    status: string;
    items: { data: SubscriptionItemRow[] };
  }>(`/subscriptions/${args.subscriptionId}`, body);
  return {
    id: updated.id,
    status: updated.status,
    stripePriceId: updated.items.data[0]?.price.id ?? args.newPriceId,
  };
}

// ──────────────────────────────────────────────────────────────────
// Customer Portal
// ──────────────────────────────────────────────────────────────────

export async function createPortalSession(args: {
  customerId: string;
  returnUrl: string;
}): Promise<{ url: string }> {
  if (isMockMode()) {
    return { url: `https://portal.stripe.test/${args.customerId}` };
  }
  const session = await stripeFetch<{ url: string }>("/billing_portal/sessions", {
    customer: args.customerId,
    return_url: args.returnUrl,
  });
  return { url: session.url };
}

// ──────────────────────────────────────────────────────────────────
// Webhook signature
// ──────────────────────────────────────────────────────────────────

export type WebhookVerifyResult =
  | { ok: true; event: StripeEvent }
  | { ok: false; code: "missing_sig" | "bad_sig" | "stale" | "malformed" };

export type StripeEvent = {
  id: string;
  type: string;
  api_version?: string;
  data: { object: Record<string, unknown> };
};

const SIG_TOLERANCE_SEC = 5 * 60;

/**
 * Verify a webhook payload using the Stripe-Signature header. In mock mode
 * we trust the JSON body as-is (signature header is ignored).
 *
 * Real mode reimplements Stripe's t=…,v1=… signature scheme so we don't
 * pull in the SDK just for this.
 */
export async function verifyWebhook(
  rawBody: string,
  sigHeader: string | null,
): Promise<WebhookVerifyResult> {
  if (isMockMode()) {
    try {
      return { ok: true, event: JSON.parse(rawBody) as StripeEvent };
    } catch {
      return { ok: false, code: "malformed" };
    }
  }
  if (!sigHeader) return { ok: false, code: "missing_sig" };
  const parts = Object.fromEntries(
    sigHeader.split(",").map((kv) => kv.split("=") as [string, string]),
  );
  const timestamp = Number(parts.t);
  const signature = parts.v1;
  if (!Number.isFinite(timestamp) || !signature) return { ok: false, code: "bad_sig" };

  const ageSec = Math.abs(Date.now() / 1000 - timestamp);
  if (ageSec > SIG_TOLERANCE_SEC) return { ok: false, code: "stale" };

  const expected = createHmac("sha256", readEnv("STRIPE_WEBHOOK_SECRET"))
    .update(`${timestamp}.${rawBody}`)
    .digest("hex");
  const a = Buffer.from(signature, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    return { ok: false, code: "bad_sig" };
  }
  try {
    return { ok: true, event: JSON.parse(rawBody) as StripeEvent };
  } catch {
    return { ok: false, code: "malformed" };
  }
}

/**
 * Test helper — produce a valid Stripe-Signature header for the given body
 * using the configured webhook secret. NEVER ship this in app code.
 */
export function signTestPayload(rawBody: string): string {
  const ts = Math.floor(Date.now() / 1000);
  const sig = createHmac("sha256", readEnv("STRIPE_WEBHOOK_SECRET"))
    .update(`${ts}.${rawBody}`)
    .digest("hex");
  return `t=${ts},v1=${sig}`;
}
