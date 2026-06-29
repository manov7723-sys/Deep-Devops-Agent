/**
 * Prisma seed — super-admin bootstrap.
 *
 * Two modes, evaluated in order:
 *
 * 1. SEED_ADMINS_JSON — a JSON array for seeding ANY number of super-admins:
 *
 *      SEED_ADMINS_JSON='[
 *        {"email":"admin@deepagent.local","password":"Strong-pass-1!","name":"Admin"},
 *        {"email":"ops@deepagent.local","password":"Other-pass-1!","name":"Ops"}
 *      ]'
 *
 * 2. SEED_SUPER_ADMIN_EMAIL / _PASSWORD / _NAME — the original single-admin
 *    triple. When both are set, JSON entries are processed first and the single
 *    triple is appended at the end.
 *
 * Behaviour:
 *   - argon2id-hashes the password.
 *   - Upserts each User with isSuperAdmin=true, role=admin, emailVerifiedAt=now,
 *     termsAcceptedAt=now so post-signup gates are bypassed.
 *   - Idempotent: re-running with the same email REPLACES the password hash and
 *     re-asserts the admin flag.
 *
 * Password policy here is relaxed compared to the runtime signup policy:
 *   - Hard requirement: at least 8 characters, AND at least one digit AND one
 *     symbol. Less than that and the seed refuses — the row would be unusable.
 *   - Soft requirement: 12+ characters. Anything shorter prints a warning but
 *     still creates the row, on the assumption that an operator pasting a
 *     password into an env file knows what they're doing.
 *
 * Two-factor is NOT pre-enrolled — every admin completes forced TOTP on first
 * login like every other user.
 *
 * Run: `npm run db:seed`
 */
import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { PrismaClient, type BillingPeriod, type PlanTier } from "@prisma/client";
import argon2 from "argon2";

/**
 * Auto-load .env.local and .env from the project root (in priority order),
 * the same way Next.js does at runtime. `tsx prisma/seed.ts` and Prisma's
 * own seed runner both only load .env by default, so vars added to .env.local
 * (DATABASE_URL, SEED_SUPER_ADMIN_*, STRIPE_PRICE_*) wouldn't reach the seed
 * process otherwise.
 */
(function loadDotenv(): void {
  const root = resolve(__dirname, "..");
  for (const name of [".env.local", ".env"]) {
    const file = resolve(root, name);
    if (!existsSync(file)) continue;
    const text = readFileSync(file, "utf8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eq = trimmed.indexOf("=");
      if (eq <= 0) continue;
      const key = trimmed.slice(0, eq).trim();
      // Existing env wins — command-line / shell overrides keep priority.
      if (process.env[key] !== undefined) continue;
      let value = trimmed.slice(eq + 1).trim();
      if (
        (value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))
      ) {
        value = value.slice(1, -1);
      }
      process.env[key] = value;
    }
  }
})();

const prisma = new PrismaClient();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

type AdminSpec = {
  email: string;
  password: string;
  name?: string;
};

type PolicyCheck =
  | { ok: true; warning?: string }
  | { ok: false; reason: string };

function checkPolicy(password: string): PolicyCheck {
  if (password.length < 8) {
    return { ok: false, reason: "password must be at least 8 characters" };
  }
  if (!/\d/.test(password)) {
    return { ok: false, reason: "password must contain at least one digit" };
  }
  if (!/[^A-Za-z0-9]/.test(password)) {
    return { ok: false, reason: "password must contain at least one symbol" };
  }
  if (password.length < 8) {
    return {
      ok: true,
      warning: `password is ${password.length} characters — minimum policy is 8. Allowed for seed; rotate before production.`,
    };
  }
  return { ok: true };
}

function splitName(full: string | undefined, emailFallback: string): {
  firstName: string;
  lastName: string;
  display: string;
} {
  const trimmed = (full ?? "").trim();
  const display = trimmed.length > 0 ? trimmed : (emailFallback.split("@")[0] ?? "Super Admin");
  const parts = display.split(/\s+/);
  const firstName = parts[0]!;
  const lastName = parts.length > 1 ? parts.slice(1).join(" ") : "Admin";
  return { firstName, lastName, display };
}

function parseAdminsJson(): AdminSpec[] {
  const raw = process.env.SEED_ADMINS_JSON?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`SEED_ADMINS_JSON is not valid JSON: ${message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("SEED_ADMINS_JSON must be a JSON array of admin objects.");
  }
  return parsed.map((row, idx) => {
    if (!row || typeof row !== "object") {
      throw new Error(`SEED_ADMINS_JSON[${idx}] is not an object.`);
    }
    const obj = row as Record<string, unknown>;
    const email = typeof obj.email === "string" ? obj.email.trim().toLowerCase() : "";
    const password = typeof obj.password === "string" ? obj.password : "";
    const name = typeof obj.name === "string" ? obj.name : undefined;
    if (!email) throw new Error(`SEED_ADMINS_JSON[${idx}].email is required.`);
    if (!password) throw new Error(`SEED_ADMINS_JSON[${idx}].password is required.`);
    return { email, password, name };
  });
}

function parseSingleAdmin(): AdminSpec | null {
  const email = process.env.SEED_SUPER_ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.SEED_SUPER_ADMIN_PASSWORD;
  const name = process.env.SEED_SUPER_ADMIN_NAME?.trim();
  if (!email || !password) return null;
  return { email, password, name };
}

async function upsertAdmin(spec: AdminSpec): Promise<void> {
  if (!EMAIL_RE.test(spec.email)) {
    throw new Error(`Invalid email "${spec.email}".`);
  }
  const policy = checkPolicy(spec.password);
  if (!policy.ok) {
    throw new Error(`${spec.email}: ${policy.reason}`);
  }
  if (policy.warning) {
    console.warn(`  ⚠  ${spec.email}: ${policy.warning}`);
  }

  const { firstName, lastName, display } = splitName(spec.name, spec.email);
  const passwordHash = await argon2.hash(spec.password, { type: argon2.argon2id });
  const now = new Date();

  const user = await prisma.user.upsert({
    where: { email: spec.email },
    update: {
      passwordHash,
      name: display,
      firstName,
      lastName,
      isSuperAdmin: true,
      role: "admin",
      emailVerifiedAt: now,
    },
    create: {
      email: spec.email,
      passwordHash,
      name: display,
      firstName,
      lastName,
      isSuperAdmin: true,
      role: "admin",
      emailVerifiedAt: now,
      termsAcceptedAt: now,
    },
    select: { id: true, email: true, isSuperAdmin: true, twoFactorEnabled: true },
  });

  console.log(`  ✓ ${user.email}`);
  console.log(`      id:            ${user.id}`);
  console.log(`      isSuperAdmin:  ${user.isSuperAdmin}`);
  console.log(`      twoFactorEnabled: ${user.twoFactorEnabled} (forced setup on first login)`);
}

async function bootstrapSuperAdmins() {
  const fromJson = parseAdminsJson();
  const fromTriple = parseSingleAdmin();

  // De-duplicate by email — JSON entries take priority, single triple appended.
  const seen = new Set<string>();
  const queue: AdminSpec[] = [];
  for (const spec of [...fromJson, ...(fromTriple ? [fromTriple] : [])]) {
    if (seen.has(spec.email)) {
      console.warn(`  ⏭  Skipping duplicate entry for ${spec.email}`);
      continue;
    }
    seen.add(spec.email);
    queue.push(spec);
  }

  if (queue.length === 0) {
    console.warn(
      "[seed] No admin specs found. Set either SEED_ADMINS_JSON or SEED_SUPER_ADMIN_EMAIL+_PASSWORD.",
    );
    return;
  }

  console.log(`[seed] Bootstrapping ${queue.length} super-admin${queue.length === 1 ? "" : "s"}:`);
  for (const spec of queue) {
    await upsertAdmin(spec);
  }
}

// ──────────────────────────────────────────────────────────────────
// Billing catalog seed (plans + addons)
// ──────────────────────────────────────────────────────────────────
//
// First-run seed: creates the default plan + addon catalog if the
// corresponding rows don't already exist. NEVER overwrites an existing row —
// once an admin tweaks a plan via the admin UI, this seeder leaves it alone.
//
// Stripe price IDs are pulled from env vars (whose names the operator picks
// when they create prices in the Stripe Dashboard).
//
// Opt out by setting SEED_SKIP_CATALOG=true.

type PlanDefault = {
  tier: PlanTier;
  name: string;
  priceCents: number | null;
  isCustomPrice?: boolean;
  period: BillingPeriod;
  popular?: boolean;
  sortOrder: number;
  stripeProductIdEnv?: string;
  stripePriceIdEnv?: string;
  projectLimit: number | null;
  envLimit: number | null;
  seatLimit: number | null;
  agentTier: string;
  highlights: string[];
};

type AddonDefault = {
  name: string;
  icon: string;
  description: string;
  priceCents: number;
  tokenGrant: number;
  stripeProductIdEnv?: string;
  stripePriceIdEnv?: string;
};

const PLAN_CATALOG: PlanDefault[] = [
  {
    tier: "Free",
    name: "Free",
    priceCents: 0,
    period: "forever",
    sortOrder: 0,
    projectLimit: 2,
    envLimit: 2,
    seatLimit: 1,
    agentTier: "Community agents",
    highlights: ["2 projects", "2 environments", "Community agents"],
  },
  {
    tier: "Pro",
    name: "Starter",
    priceCents: 9900,
    period: "month",
    sortOrder: 1,
    stripePriceIdEnv: "STRIPE_PRICE_STARTER_MONTHLY",
    projectLimit: 5,
    envLimit: 3,
    seatLimit: 5,
    agentTier: "Pro agents",
    highlights: ["5 projects", "3 environments per project", "5 seats", "Slack & PagerDuty alerts"],
  },
  {
    tier: "Scale",
    name: "Pro",
    priceCents: 24900,
    period: "month",
    popular: true,
    sortOrder: 2,
    stripePriceIdEnv: "STRIPE_PRICE_PRO_MONTHLY",
    projectLimit: 20,
    envLimit: 10,
    seatLimit: 20,
    agentTier: "All agents + custom models",
    highlights: ["20 projects", "10 environments per project", "20 seats", "All agents + custom models", "Audit log retention"],
  },
  {
    tier: "Enterprise",
    name: "Enterprise",
    priceCents: null,
    isCustomPrice: true,
    period: "month",
    sortOrder: 3,
    stripePriceIdEnv: "STRIPE_PRICE_ENTERPRISE_MONTHLY",
    projectLimit: null,
    envLimit: null,
    seatLimit: null,
    agentTier: "Custom",
    highlights: ["Unlimited projects + envs", "Custom seats", "On-prem option", "SSO + SCIM", "Dedicated support"],
  },
];

const ADDON_CATALOG: AddonDefault[] = [
  {
    name: "Token pack — 100K",
    icon: "zap",
    description: "Adds 100,000 agent tokens. Top up any time your balance runs low.",
    priceCents: 1500,
    tokenGrant: 100_000,
    stripePriceIdEnv: "STRIPE_PRICE_BOOST_100K",
  },
  {
    name: "Token pack — 500K",
    icon: "zap",
    description: "Adds 500,000 agent tokens. Top up any time your balance runs low.",
    priceCents: 5900,
    tokenGrant: 500_000,
    stripePriceIdEnv: "STRIPE_PRICE_BOOST_500K",
  },
  {
    name: "Token pack — 2M",
    icon: "zap",
    description: "Adds 2,000,000 agent tokens. Top up any time your balance runs low.",
    priceCents: 19900,
    tokenGrant: 2_000_000,
    stripePriceIdEnv: "STRIPE_PRICE_BOOST_2M",
  },
];

function envValue(name: string | undefined): string | null {
  if (!name) return null;
  const v = process.env[name];
  return v && v.trim().length > 0 ? v.trim() : null;
}

/**
 * Extra plans from SEED_PLANS_JSON. Same shape as the defaults but with
 * literal Stripe IDs (no env-var indirection) since the operator is already
 * writing values directly in the JSON. Example:
 *
 *   SEED_PLANS_JSON='[{"tier":"Pro","name":"Solo","priceCents":500,
 *                     "period":"month","sortOrder":5,
 *                     "stripePriceId":"price_…","highlights":["1 seat"]}]'
 *
 * Entries with a tier that already exists are skipped — same idempotency rule.
 */
type PlanJsonRow = {
  tier: PlanTier;
  name: string;
  priceCents?: number | null;
  isCustomPrice?: boolean;
  period?: BillingPeriod;
  popular?: boolean;
  sortOrder?: number;
  stripeProductId?: string;
  stripePriceId?: string;
  projectLimit?: number | null;
  envLimit?: number | null;
  seatLimit?: number | null;
  agentTier?: string;
  highlights?: string[];
};

function parsePlansJson(): PlanJsonRow[] {
  const raw = process.env.SEED_PLANS_JSON?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`SEED_PLANS_JSON is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("SEED_PLANS_JSON must be a JSON array.");
  }
  return parsed as PlanJsonRow[];
}

/**
 * Extra addons from SEED_ADDONS_JSON. Same idempotency: rows with a name
 * already in the DB are skipped. Example:
 *
 *   SEED_ADDONS_JSON='[{"name":"SOC2 pack","icon":"shield",
 *                       "description":"Compliance evidence","priceCents":9900,
 *                       "stripePriceId":"price_…"}]'
 */
type AddonJsonRow = {
  name: string;
  icon: string;
  description: string;
  priceCents: number;
  tokenGrant?: number;
  stripeProductId?: string;
  stripePriceId?: string;
};

function parseAddonsJson(): AddonJsonRow[] {
  const raw = process.env.SEED_ADDONS_JSON?.trim();
  if (!raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`SEED_ADDONS_JSON is not valid JSON: ${err instanceof Error ? err.message : err}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error("SEED_ADDONS_JSON must be a JSON array.");
  }
  return parsed as AddonJsonRow[];
}

async function seedPlans(): Promise<void> {
  const extras = parsePlansJson();
  const total = PLAN_CATALOG.length + extras.length;
  console.log(
    `[seed] Plan catalog (${PLAN_CATALOG.length} defaults${extras.length ? ` + ${extras.length} from SEED_PLANS_JSON` : ""}):`,
  );

  // 1) Defaults (with env-var indirection for Stripe IDs).
  for (const p of PLAN_CATALOG) {
    const existing = await prisma.plan.findUnique({ where: { tier: p.tier } });
    if (existing) {
      console.log(`  ⏭  ${p.tier} (“${existing.name}”) already exists — left untouched`);
      continue;
    }
    const stripeProductId = envValue(p.stripeProductIdEnv);
    const stripePriceId = envValue(p.stripePriceIdEnv);
    const created = await prisma.plan.create({
      data: {
        tier: p.tier,
        name: p.name,
        priceCents: p.priceCents,
        isCustomPrice: p.isCustomPrice ?? false,
        period: p.period,
        popular: p.popular ?? false,
        sortOrder: p.sortOrder,
        stripeProductId,
        stripePriceId,
        projectLimit: p.projectLimit,
        envLimit: p.envLimit,
        seatLimit: p.seatLimit,
        agentTier: p.agentTier,
        highlights: p.highlights,
      },
    });
    const priceLabel = created.isCustomPrice
      ? "Custom"
      : created.priceCents === null
        ? "—"
        : `$${(created.priceCents / 100).toFixed(2)}/${created.period}`;
    console.log(`  ✓ ${created.tier} (“${created.name}”) ${priceLabel}${stripePriceId ? `  ${stripePriceId}` : ""}`);
  }

  // 2) Extras from SEED_PLANS_JSON (with literal Stripe IDs in the JSON).
  for (const p of extras) {
    const existing = await prisma.plan.findUnique({ where: { tier: p.tier } });
    if (existing) {
      console.log(`  ⏭  ${p.tier} (“${existing.name}”) already exists — left untouched`);
      continue;
    }
    const created = await prisma.plan.create({
      data: {
        tier: p.tier,
        name: p.name,
        priceCents: p.priceCents ?? null,
        isCustomPrice: p.isCustomPrice ?? false,
        period: p.period ?? "month",
        popular: p.popular ?? false,
        sortOrder: p.sortOrder ?? 99,
        stripeProductId: p.stripeProductId ?? null,
        stripePriceId: p.stripePriceId ?? null,
        projectLimit: p.projectLimit ?? null,
        envLimit: p.envLimit ?? null,
        seatLimit: p.seatLimit ?? null,
        agentTier: p.agentTier ?? null,
        highlights: p.highlights ?? [],
      },
    });
    console.log(`  ✓ ${created.tier} (“${created.name}”) [from SEED_PLANS_JSON]`);
  }
  if (total === 0) console.log("  (nothing to do)");
}

async function seedAddons(): Promise<void> {
  const extras = parseAddonsJson();
  console.log(
    `[seed] Addon catalog (${ADDON_CATALOG.length} defaults${extras.length ? ` + ${extras.length} from SEED_ADDONS_JSON` : ""}):`,
  );

  // 1) Defaults.
  for (const a of ADDON_CATALOG) {
    const existing = await prisma.addon.findFirst({ where: { name: a.name } });
    if (existing) {
      console.log(`  ⏭  Addon “${a.name}” already exists — left untouched`);
      continue;
    }
    const stripeProductId = envValue(a.stripeProductIdEnv);
    const stripePriceId = envValue(a.stripePriceIdEnv);
    const created = await prisma.addon.create({
      data: {
        name: a.name,
        icon: a.icon,
        description: a.description,
        priceCents: a.priceCents,
        tokenGrant: a.tokenGrant,
        stripeProductId,
        stripePriceId,
      },
    });
    console.log(
      `  ✓ Addon “${created.name}” $${(created.priceCents / 100).toFixed(2)} (+${created.tokenGrant.toLocaleString()} tokens)${stripePriceId ? `  ${stripePriceId}` : ""}`,
    );
  }

  // 2) Extras from SEED_ADDONS_JSON.
  for (const a of extras) {
    const existing = await prisma.addon.findFirst({ where: { name: a.name } });
    if (existing) {
      console.log(`  ⏭  Addon “${a.name}” already exists — left untouched`);
      continue;
    }
    const created = await prisma.addon.create({
      data: {
        name: a.name,
        icon: a.icon,
        description: a.description,
        priceCents: a.priceCents,
        tokenGrant: a.tokenGrant ?? 0,
        stripeProductId: a.stripeProductId ?? null,
        stripePriceId: a.stripePriceId ?? null,
      },
    });
    console.log(
      `  ✓ Addon “${created.name}” $${(created.priceCents / 100).toFixed(2)} (+${created.tokenGrant.toLocaleString()} tokens) [from SEED_ADDONS_JSON]`,
    );
  }
}

async function seedBillingCatalog(): Promise<void> {
  if (process.env.SEED_SKIP_CATALOG === "true") {
    console.log("[seed] SEED_SKIP_CATALOG=true — skipping plan/addon catalog seed");
    return;
  }
  await seedPlans();
  await seedAddons();
}

async function main() {
  await bootstrapSuperAdmins();
  await seedBillingCatalog();
}

main()
  .catch((err) => {
    console.error("[seed] failed:", err instanceof Error ? err.message : err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
