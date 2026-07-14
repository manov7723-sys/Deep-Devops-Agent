import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey, setEnvAzureBackend } from "@/lib/devops/envs";
import { getAzureAccessToken } from "@/lib/cloud/azure";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

const ARM = "https://management.azure.com";
const RG_API = "2021-04-01";
const STORAGE_API = "2023-01-01";
const POLL_MS = 4_000;
const CREATE_TIMEOUT_MS = 4 * 60_000; // Storage account create is usually 30-60s but LRS can hit 2-3min under load.

const Body = z.object({
  /** Resource group name. Created if missing. */
  resourceGroup: z.string().trim().min(1).max(90),
  /** Storage account name (globally unique, 3-24 lowercase letters/digits). */
  storageAccount: z
    .string()
    .trim()
    .min(3)
    .max(24)
    .regex(/^[a-z0-9]+$/, "Storage account name must be lowercase letters + digits only, no hyphens."),
  /** Blob container name (3-63, lowercase, digits, single hyphens). */
  container: z.string().trim().min(3).max(63),
  /** Azure region. Defaults to eastus. */
  location: z.string().trim().min(1).max(40).default("eastus"),
});

/**
 * Provision the three Azure resources terraform's `azurerm` backend needs:
 *   1. Resource group (created if missing, idempotent PUT).
 *   2. Storage account (Standard_LRS, StorageV2, blob public access disabled,
 *      TLS 1.2 minimum). Async — polls Azure-AsyncOperation until Succeeded.
 *   3. Blob container inside the account (public access None).
 *
 * On success, also persists the three names + region onto the env row so the
 * user doesn't have to Save separately — the next AKS apply immediately picks
 * them up via the tf-backend GET.
 *
 * Uses the env's stored Azure creds (SP client-credentials or OAuth refresh),
 * so no CLI needed. Idempotent — safe to click twice if the first Save was
 * done without provisioning.
 */
export async function POST(
  req: Request,
  ctx: { params: Promise<{ slug: string; key: string }> },
) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const { resourceGroup, storageAccount, container, location } = parsed.data;

  const env = await envBySlugAndKey(gate.access.project.id, key);
  if (!env) return NextResponse.json({ ok: false, code: "env_not_found" }, { status: 404 });
  if (!env.cloudProviderId) {
    return NextResponse.json(
      { ok: false, code: "no_provider", message: "This env has no cloud provider attached." },
      { status: 409 },
    );
  }

  const cp = await prisma.cloudProvider.findUnique({
    where: { id: env.cloudProviderId },
    select: { kind: true, accountRef: true },
  });
  if (cp?.kind !== "azure") {
    return NextResponse.json(
      { ok: false, code: "wrong_cloud", message: `Env's cloud is ${cp?.kind ?? "unknown"}, not Azure.` },
      { status: 409 },
    );
  }
  const subscriptionId = cp.accountRef;
  if (!subscriptionId) {
    return NextResponse.json(
      { ok: false, code: "no_subscription", message: "Azure provider row has no subscription id." },
      { status: 409 },
    );
  }

  const tok = await getAzureAccessToken(env.cloudProviderId);
  if (!tok.ok) {
    return NextResponse.json(
      { ok: false, code: "auth_failed", message: `Could not authenticate to Azure: ${tok.error}` },
      { status: 502 },
    );
  }
  const token = tok.accessToken;
  const authHeaders = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
  const steps: string[] = [];

  // ── 1. Ensure resource group exists (idempotent PUT) ──────────────────
  {
    const url = `${ARM}/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}?api-version=${RG_API}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ location }),
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return NextResponse.json(
        { ok: false, code: "rg_failed", status: res.status, message: `Resource group PUT failed: ${body.slice(0, 500)}` },
        { status: 502 },
      );
    }
    steps.push(res.status === 201 ? "created resource group" : "resource group already existed");
  }

  // ── 2. Storage account (async) ────────────────────────────────────────
  {
    const url = `${ARM}/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Storage/storageAccounts/${encodeURIComponent(storageAccount)}?api-version=${STORAGE_API}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({
        location,
        sku: { name: "Standard_LRS" },
        kind: "StorageV2",
        properties: {
          allowBlobPublicAccess: false,
          minimumTlsVersion: "TLS1_2",
          allowSharedKeyAccess: true, // Terraform azurerm backend uses shared-key auth by default
        },
      }),
      cache: "no-store",
    });
    if (res.status === 200) {
      // Storage account already existed — Azure returns the resource immediately.
      steps.push("storage account already existed");
    } else if (res.status === 202) {
      // Async create. Poll the Azure-AsyncOperation URL until Succeeded.
      const opUrl = res.headers.get("Azure-AsyncOperation") ?? res.headers.get("Location");
      if (!opUrl) {
        return NextResponse.json(
          { ok: false, code: "no_op_header", message: "Storage account create returned 202 with no polling URL." },
          { status: 502 },
        );
      }
      const start = Date.now();
      let done = false;
      while (Date.now() - start < CREATE_TIMEOUT_MS) {
        await new Promise((r) => setTimeout(r, POLL_MS));
        const pol = await fetch(opUrl, { headers: authHeaders, cache: "no-store" });
        if (!pol.ok) continue;
        const opState = (await pol.json().catch(() => ({}))) as { status?: string; error?: unknown };
        if (opState.status === "Succeeded") { done = true; break; }
        if (opState.status === "Failed" || opState.status === "Canceled") {
          return NextResponse.json(
            {
              ok: false,
              code: "storage_op_failed",
              message: JSON.stringify(opState.error ?? opState).slice(0, 800),
            },
            { status: 502 },
          );
        }
      }
      if (!done) {
        return NextResponse.json(
          {
            ok: false,
            code: "storage_timeout",
            message: "Storage account create is still going on Azure's side. Click Provision again in a minute to keep polling.",
          },
          { status: 504 },
        );
      }
      steps.push("created storage account");
    } else if (!res.ok) {
      const body = await res.text().catch(() => "");
      return NextResponse.json(
        {
          ok: false,
          code: "storage_failed",
          status: res.status,
          message: `Storage account PUT failed: ${body.slice(0, 700)}`,
        },
        { status: 502 },
      );
    } else {
      steps.push("created storage account");
    }
  }

  // ── 3. Blob container (synchronous) ────────────────────────────────────
  {
    const url = `${ARM}/subscriptions/${encodeURIComponent(subscriptionId)}/resourceGroups/${encodeURIComponent(resourceGroup)}/providers/Microsoft.Storage/storageAccounts/${encodeURIComponent(storageAccount)}/blobServices/default/containers/${encodeURIComponent(container)}?api-version=${STORAGE_API}`;
    const res = await fetch(url, {
      method: "PUT",
      headers: authHeaders,
      body: JSON.stringify({ properties: { publicAccess: "None" } }),
      cache: "no-store",
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      return NextResponse.json(
        {
          ok: false,
          code: "container_failed",
          status: res.status,
          message: `Container PUT failed: ${body.slice(0, 500)}`,
        },
        { status: 502 },
      );
    }
    steps.push(res.status === 201 ? "created blob container" : "blob container already existed");
  }

  // ── 4. Persist onto the env so future AKS applies pick it up ──────────
  await setEnvAzureBackend(gate.access.project.id, key, {
    resourceGroup,
    storageAccount,
    container,
  }).catch(() => {});

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "azure.tfstate_provisioned",
    targetType: "env",
    targetId: env.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { resourceGroup, storageAccount, container, location },
  });

  return NextResponse.json({
    ok: true,
    steps,
    backend: { resourceGroup, storageAccount, container, location },
  });
}
