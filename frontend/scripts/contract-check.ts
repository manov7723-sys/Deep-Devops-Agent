#!/usr/bin/env tsx
/**
 * Contract check — hits each mock endpoint and parses through its zod schema.
 * Phase 11 keeps this script unchanged; it then asserts that Prisma returns
 * the same shape the mocks did. Drift surfaces here loudly.
 *
 * Usage:
 *   1. Run dev server: `npm run dev`
 *   2. Run this script: `npx tsx scripts/contract-check.ts`
 */
import {
  Project,
  Env,
  Workload,
  Pipeline,
  Approval,
  Activity,
  Alert,
  ProjectCost,
  Task,
  AdminUser,
  AdminSubscription,
  McpConnector,
  Agent,
  AdminModel,
} from "../src/lib/api/schemas";
import { z } from "zod";

const BASE = process.env.DDA_BASE ?? "http://localhost:3000";
const EMAIL = "avery@northwind.dev";

type Check = {
  path: string;
  schema: z.ZodTypeAny;
  isArray?: boolean;
  label?: string;
};

const CHECKS: Check[] = [
  { path: "/api/v1/projects", schema: Project, isArray: true },
  { path: "/api/v1/projects/northwind-api/envs", schema: Env, isArray: true },
  { path: "/api/v1/projects/northwind-api/workloads", schema: Workload, isArray: true },
  { path: "/api/v1/projects/northwind-api/pipelines", schema: Pipeline, isArray: true },
  { path: "/api/v1/projects/northwind-api/approvals", schema: Approval, isArray: true },
  { path: "/api/v1/projects/northwind-api/activity", schema: Activity, isArray: true },
  { path: "/api/v1/projects/northwind-api/alerts", schema: Alert, isArray: true },
  { path: "/api/v1/projects/northwind-api/cost", schema: ProjectCost },
  { path: "/api/v1/projects/northwind-api/tasks", schema: Task, isArray: true },
  { path: "/api/v1/admin/users", schema: AdminUser, isArray: true },
  { path: "/api/v1/admin/subscriptions", schema: AdminSubscription, isArray: true },
  { path: "/api/v1/admin/mcp", schema: McpConnector, isArray: true },
  { path: "/api/v1/admin/agents", schema: Agent, isArray: true },
  { path: "/api/v1/admin/models", schema: AdminModel, isArray: true },
];

type CookieJar = Map<string, string>;

function parseSetCookie(jar: CookieJar, header: string | null) {
  if (!header) return;
  for (const piece of header.split(/,(?=[^;]+=)/)) {
    const m = piece.match(/^\s*([^=;]+)=([^;]*)/);
    if (m) jar.set(m[1].trim(), m[2].trim());
  }
}

function cookieHeader(jar: CookieJar): string {
  return Array.from(jar.entries())
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
}

async function authenticate(jar: CookieJar) {
  const next = encodeURIComponent("/u/dashboard");
  const res = await fetch(`${BASE}/api/v1/auth/dev-login?email=${EMAIL}&next=${next}`, {
    headers: { cookie: cookieHeader(jar) },
    redirect: "manual",
  });
  parseSetCookie(jar, res.headers.get("set-cookie"));
}

async function checkOne(
  jar: CookieJar,
  c: Check,
): Promise<{ ok: true } | { ok: false; reason: string }> {
  const res = await fetch(BASE + c.path, {
    headers: { cookie: cookieHeader(jar) },
  });
  if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
  const raw = await res.json();
  const schema = c.isArray ? z.array(c.schema) : c.schema;
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    const messages = parsed.error.errors
      .slice(0, 5)
      .map((e) => `${e.path.join(".") || "<root>"}: ${e.message}`)
      .join(" | ");
    return { ok: false, reason: messages };
  }
  return { ok: true };
}

async function main() {
  const jar: CookieJar = new Map();
  await authenticate(jar);
  if (!jar.has("ddasess")) {
    console.error("[contract] failed to authenticate — is the dev server running?");
    process.exit(1);
  }
  let pass = 0;
  let fail = 0;
  for (const c of CHECKS) {
    const r = await checkOne(jar, c);
    if (r.ok) {
      console.log(`  ✓ ${c.path}`);
      pass += 1;
    } else {
      console.error(`  ✗ ${c.path}  ${r.reason}`);
      fail += 1;
    }
  }
  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
