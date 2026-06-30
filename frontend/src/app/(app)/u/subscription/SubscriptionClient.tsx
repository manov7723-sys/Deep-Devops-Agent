"use client";

import { useQuery } from "@tanstack/react-query";
import { Badge, Block, Btn, Icon, PageHead } from "@/components/ui";
import { PaymentMethodRow } from "@/components/domain/PaymentMethodRow";
import {
  useAddonCatalog,
  useMyAddons,
  useStartAddonCheckout,
} from "@/hooks/queries/addons";
import { useInvoices, usePlan, useUsage } from "@/hooks/queries/me";
import { api } from "@/lib/api/client";

type PlanCatalogRow = {
  id: string;
  tier: "Free" | "Pro" | "Scale" | "Enterprise";
  name: string;
  priceCents: number | null;
  isCustomPrice: boolean;
  currency: string;
  popular: boolean;
};

type PaymentMethod = {
  id: string;
  brand: string;
  last4: string;
  expMonth: number;
  expYear: number;
  isDefault: boolean;
};

function formatCents(cents: number | null, currency: string): string {
  if (cents === null) return "—";
  return new Intl.NumberFormat("en-US", {
    style: "currency",
    currency: currency.toUpperCase(),
    maximumFractionDigits: 0,
  }).format(cents / 100);
}

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}

/**
 * Returns a URL the browser should navigate to. For a brand-new subscription
 * that's a Stripe Checkout URL; for an in-place plan switch the server has
 * already mutated Stripe + the DB and just returns a back-to-app redirect.
 */
async function startSubscriptionCheckout(planId: string): Promise<string> {
  const res = await api.post<{
    ok: boolean;
    url?: string;
    redirect?: string;
    switched?: boolean;
    code?: string;
    message?: string;
  }>("/billing/checkout", { purpose: "new_subscription", planId });
  if (!res.ok) throw new Error(res.message ?? res.code ?? "Checkout failed");
  const target = res.url ?? res.redirect;
  if (!target) throw new Error("missing_redirect");
  return target;
}

export function SubscriptionClient() {
  const { data: subscription } = usePlan();
  const { data: catalog } = useQuery({
    queryKey: ["billing", "plans"],
    queryFn: async () => {
      const res = await api.get<{ plans: PlanCatalogRow[] }>("/plans");
      return res.plans;
    },
    staleTime: 60_000,
  });
  const { data: catalogAddons } = useAddonCatalog();
  const { data: myAddons } = useMyAddons();
  const { data: cards } = useQuery({
    queryKey: ["me", "payment-methods"],
    queryFn: async () => {
      const res = await api.get<{ methods: PaymentMethod[] }>("/me/payment-methods");
      return res.methods;
    },
    staleTime: 30_000,
  });
  const addonCheckout = useStartAddonCheckout();

  const { data: usage } = useUsage();
  const { data: invoices } = useInvoices();
  const defaultCard = cards?.find((c) => c.isDefault) ?? cards?.[0] ?? null;
  // Show top-ups in price-ascending order; user clicks "Buy" any time they're low.
  const sortedAddons = (catalogAddons ?? []).slice().sort((a, b) => a.priceCents - b.priceCents);
  const recentPurchases = myAddons?.slice(0, 5) ?? [];
  const isUnlimited = !!usage?.unlimited;

  return (
    <div className="col gap-5">
      <PageHead title="Subscription" sub="Manage your plan, seats and add-ons." />

      <div className="dda-sub-banner">
        <span className="dda-sub-banner-icon">
          <Icon name="zap" size={22} />
        </span>
        <div className="col grow" style={{ lineHeight: 1.4 }}>
          <span style={{ fontWeight: 800, fontSize: 16 }}>
            {isUnlimited
              ? "Platform admin · unlimited access"
              : subscription
              ? `${subscription.planName} plan · ${formatCents(subscription.basePriceCents, subscription.currency)}/mo`
              : "No plan yet"}
          </span>
          <span className="muted" style={{ fontSize: 13 }}>
            {isUnlimited
              ? "No plan or charges apply. Use the controls below to grant tokens to other users."
              : subscription
              ? `Renews ${formatDate(subscription.currentPeriodEnd)}${defaultCard ? ` · ${defaultCard.brand} ending ${defaultCard.last4}` : ""}`
              : "Pick a plan below to start your subscription."}
          </span>
        </div>
        {!isUnlimited && <Btn variant="outline">Change plan</Btn>}
      </div>

      {!isUnlimited && (
        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))", gap: 14 }}>
          {(catalog ?? []).map((p) => {
            const current = subscription?.planTier === p.tier;
            return (
              <div key={p.id} className="card card-pad col gap-3">
                <div className="row gap-2" style={{ alignItems: "baseline" }}>
                  <span style={{ fontSize: 18, fontWeight: 800 }}>{p.name}</span>
                  {p.popular && <Badge tone="accent">Popular</Badge>}
                  {current && <Badge tone="ok">Current</Badge>}
                </div>
                <div className="row gap-1" style={{ alignItems: "baseline" }}>
                  <span style={{ fontSize: 26, fontWeight: 800 }}>
                    {p.isCustomPrice ? "Custom" : formatCents(p.priceCents, p.currency)}
                  </span>
                  {!p.isCustomPrice && <span className="muted">/ month</span>}
                </div>
                {!current && (
                  <Btn
                    variant="primary"
                    size="sm"
                    onClick={async () => {
                      try {
                        const url = await startSubscriptionCheckout(p.id);
                        window.location.assign(url);
                      } catch (err) {
                        console.error(err);
                      }
                    }}
                    disabled={p.isCustomPrice}
                  >
                    {p.isCustomPrice ? "Contact sales" : "Choose plan"}
                  </Btn>
                )}
              </div>
            );
          })}
        </div>
      )}

      <Block>
        <Block.Header>
          <Block.Title sub="Buy more tokens whenever your balance runs low — no recurring charge.">
            Top up agent tokens
          </Block.Title>
          <Block.Actions>
            {isUnlimited ? (
              <Badge tone="accent">Unlimited tokens</Badge>
            ) : usage ? (
              <Badge tone={usage.tokensRemaining < 50_000 ? "warn" : "accent"}>
                {usage.tokensRemaining.toLocaleString()} tokens left
              </Badge>
            ) : (
              <Badge>—</Badge>
            )}
          </Block.Actions>
        </Block.Header>
        {catalogAddons ? (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14, padding: 14 }}>
            {sortedAddons.map((a) => (
              <div key={a.id} className="card card-pad col gap-3">
                <div className="row gap-2" style={{ alignItems: "center" }}>
                  <Icon name={a.icon as Parameters<typeof Icon>[0]["name"]} size={18} />
                  <span style={{ fontWeight: 700 }}>{a.name}</span>
                </div>
                <div className="row gap-1" style={{ alignItems: "baseline" }}>
                  <span style={{ fontSize: 24, fontWeight: 800 }}>
                    ${(a.priceCents / 100).toFixed(0)}
                  </span>
                  <span className="muted" style={{ fontSize: 12 }}>one-time</span>
                </div>
                <span className="muted" style={{ fontSize: 12.5, lineHeight: 1.4 }}>
                  +{a.tokenGrant.toLocaleString()} tokens · {a.description}
                </span>
                <Btn
                  variant="primary"
                  size="sm"
                  onClick={async () => {
                    try {
                      const url = await addonCheckout.mutateAsync({ addonId: a.id });
                      window.location.assign(url);
                    } catch (err) {
                      console.error(err);
                    }
                  }}
                >
                  Buy
                </Btn>
              </div>
            ))}
          </div>
        ) : (
          <Block.Loading />
        )}
        {recentPurchases.length > 0 && (
          <div style={{ borderTop: "1px solid var(--border)", padding: 14 }}>
            <span className="muted" style={{ fontSize: 12, fontWeight: 600 }}>Recent top-ups</span>
            <div className="col gap-1" style={{ marginTop: 6 }}>
              {recentPurchases.map((p) => (
                <div key={p.id} className="row between" style={{ fontSize: 12.5 }}>
                  <span>{p.name}</span>
                  <span className="faint">
                    ${(p.priceCents / 100).toFixed(0)} · {new Date(p.purchasedAt).toLocaleDateString()}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}
      </Block>

      <Block>
        <Block.Header>
          <Block.Title sub="Stripe-issued invoices for your plan + add-on purchases. Download as PDF or view the hosted receipt.">
            Invoices & purchases
          </Block.Title>
          <Block.Actions>
            <Badge tone="default">{invoices?.length ?? 0} invoices</Badge>
          </Block.Actions>
        </Block.Header>
        <Block.Body>
          {invoices === undefined ? (
            <Block.Loading />
          ) : invoices.length === 0 ? (
            <span className="muted" style={{ fontSize: 13 }}>
              No invoices yet. Purchases — plan upgrades or token packs — appear here once Stripe finalizes them.
            </span>
          ) : (
            <div className="col gap-1">
              {invoices.map((inv) => (
                <div
                  key={inv.id}
                  className="row between"
                  style={{ fontSize: 13, padding: "10px 0", borderBottom: "1px solid var(--border)" }}
                >
                  <div className="col" style={{ lineHeight: 1.35 }}>
                    <span className="row gap-2" style={{ fontWeight: 600, alignItems: "center" }}>
                      <span>{inv.number ?? inv.id.slice(0, 12)}</span>
                      <Badge tone={inv.status === "paid" ? "ok" : inv.status === "open" ? "warn" : "default"}>
                        {inv.status}
                      </Badge>
                    </span>
                    <span className="faint" style={{ fontSize: 12 }}>
                      {formatDate(inv.paidAt ?? inv.issuedAt)} · {formatCents(inv.amountCents, inv.currency)}
                    </span>
                  </div>
                  <div className="row gap-2">
                    {inv.hostedInvoiceUrl && (
                      <Btn
                        size="sm"
                        variant="ghost"
                        icon="eye"
                        onClick={() => window.open(inv.hostedInvoiceUrl!, "_blank", "noopener,noreferrer")}
                      >
                        View
                      </Btn>
                    )}
                    {inv.pdfUrl && (
                      <Btn
                        size="sm"
                        variant="outline"
                        icon="download"
                        onClick={() => window.open(inv.pdfUrl!, "_blank", "noopener,noreferrer")}
                      >
                        PDF
                      </Btn>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Block.Body>
      </Block>

      <Block>
        <Block.Header>
          <Block.Title>Payment method</Block.Title>
          <Block.Actions>
            <Btn
              size="sm"
              variant="outline"
              icon="edit"
              onClick={async () => {
                try {
                  const res = await api.post<{ ok: boolean; url?: string }>("/billing/portal", {});
                  if (res.ok && res.url) window.location.assign(res.url);
                } catch (err) {
                  console.error(err);
                }
              }}
            >
              Open portal
            </Btn>
          </Block.Actions>
        </Block.Header>
        <Block.Body>
          {cards ? (
            defaultCard ? (
              <PaymentMethodRow
                brand={defaultCard.brand}
                last4={defaultCard.last4}
                exp={`${String(defaultCard.expMonth).padStart(2, "0")}/${String(defaultCard.expYear).slice(-2)}`}
              />
            ) : (
              <span className="muted" style={{ fontSize: 13 }}>
                No card on file. Pick a plan above to add one through Stripe.
              </span>
            )
          ) : (
            <span className="skel" style={{ height: 32, width: 220, display: "block" }} />
          )}
        </Block.Body>
      </Block>
    </div>
  );
}
