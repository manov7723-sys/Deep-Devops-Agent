/**
 * Platform-level settings (branding, SMTP, assets, env vars, system components).
 * Values that are secrets (PlatformEnvVar.valueRef) are encrypted at rest via
 * the AES-GCM helper.
 */
import type { HealthStatus, PlatformSetting } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";
import { encryptSecret } from "@/lib/auth/crypto";

// ──────────────────────────────────────────────────────────────────
// PlatformSetting (singleton-ish)
// ──────────────────────────────────────────────────────────────────

export type PlatformSettingsRow = {
  siteTitle: string;
  metaDescription: string;
  smtpHost: string | null;
  smtpPort: number | null;
  fromAddress: string | null;
  smtpVerifiedAt: string | null;
  updatedAt: string;
};

function row(s: PlatformSetting): PlatformSettingsRow {
  return {
    siteTitle: s.siteTitle,
    metaDescription: s.metaDescription,
    smtpHost: s.smtpHost,
    smtpPort: s.smtpPort,
    fromAddress: s.fromAddress,
    smtpVerifiedAt: s.smtpVerifiedAt?.toISOString() ?? null,
    updatedAt: s.updatedAt.toISOString(),
  };
}

async function getOrCreate(): Promise<PlatformSetting> {
  const existing = await prisma.platformSetting.findFirst();
  if (existing) return existing;
  return prisma.platformSetting.create({
    data: {
      siteTitle: "DeepAgent",
      metaDescription: "Connect GitHub, choose repos, ship to your cloud — with agents.",
    },
  });
}

export async function getPlatformSettings(): Promise<PlatformSettingsRow> {
  return row(await getOrCreate());
}

export type PatchPlatformArgs = Partial<{
  siteTitle: string;
  metaDescription: string;
  smtpHost: string | null;
  smtpPort: number | null;
  fromAddress: string | null;
  smtpVerifiedAt: Date | null;
}>;

export async function patchPlatformSettings(patch: PatchPlatformArgs): Promise<PlatformSettingsRow> {
  const current = await getOrCreate();
  const updated = await prisma.platformSetting.update({
    where: { id: current.id },
    data: {
      ...(patch.siteTitle !== undefined && { siteTitle: patch.siteTitle }),
      ...(patch.metaDescription !== undefined && { metaDescription: patch.metaDescription }),
      ...(patch.smtpHost !== undefined && { smtpHost: patch.smtpHost }),
      ...(patch.smtpPort !== undefined && { smtpPort: patch.smtpPort }),
      ...(patch.fromAddress !== undefined && { fromAddress: patch.fromAddress }),
      ...(patch.smtpVerifiedAt !== undefined && { smtpVerifiedAt: patch.smtpVerifiedAt }),
    },
  });
  return row(updated);
}

// ──────────────────────────────────────────────────────────────────
// PlatformAsset (logo/favicon/og)
// ──────────────────────────────────────────────────────────────────

/**
 * Branding always exposes these three slots in the UI. When nothing has been
 * uploaded yet, the UI falls back to a checked-in SVG under /public/brand/ so
 * the admin page never renders a broken image.
 */
const BRAND_ASSET_DEFAULTS: Record<string, { label: string; hint: string; localFallback: string }> = {
  logo: {
    label: "Logo",
    hint: "Shown in the top-left nav, login screen and emails. SVG recommended.",
    localFallback: "/brand/logo.svg",
  },
  favicon: {
    label: "Favicon",
    hint: "Browser tab icon. 32×32 PNG or .ico.",
    localFallback: "/brand/favicon.svg",
  },
  og: {
    label: "Social share card",
    hint: "Open Graph image used by Slack / Twitter / LinkedIn previews. 1200×630 PNG/JPG.",
    localFallback: "/brand/og.svg",
  },
};

export type AssetRow = {
  key: string;
  label: string;
  hint: string;
  url: string | null;
  localFallback: string;
  hasUpload: boolean;
  updatedAt: string;
};

export async function listAssets(): Promise<AssetRow[]> {
  const rows = await prisma.platformAsset.findMany();
  const byKey = new Map(rows.map((r) => [r.key, r]));
  return Object.entries(BRAND_ASSET_DEFAULTS).map(([key, def]) => {
    const stored = byKey.get(key);
    return {
      key,
      label: stored?.label ?? def.label,
      hint: stored?.hint ?? def.hint,
      url: stored?.url ?? null,
      localFallback: def.localFallback,
      hasUpload: !!stored?.url,
      updatedAt: stored?.updatedAt.toISOString() ?? new Date(0).toISOString(),
    };
  });
}

export async function upsertAsset(args: {
  key: string;
  label?: string;
  hint?: string;
  url?: string | null;
}): Promise<AssetRow> {
  const def = BRAND_ASSET_DEFAULTS[args.key];
  const label = args.label ?? def?.label ?? args.key;
  const hint = args.hint ?? def?.hint ?? "";
  const upserted = await prisma.platformAsset.upsert({
    where: { key: args.key },
    create: { key: args.key, label, hint, url: args.url ?? null },
    update: { label, hint, url: args.url ?? null },
  });
  return {
    key: upserted.key,
    label: upserted.label,
    hint: upserted.hint,
    url: upserted.url,
    localFallback: def?.localFallback ?? "",
    hasUpload: !!upserted.url,
    updatedAt: upserted.updatedAt.toISOString(),
  };
}

// ──────────────────────────────────────────────────────────────────
// PlatformEnvVar (encrypted)
// ──────────────────────────────────────────────────────────────────

export type EnvVarRow = {
  key: string;
  status: HealthStatus;
  statusLabel: string;
  updatedAt: string;
  hasValue: boolean;
};

export async function listEnvVars(): Promise<EnvVarRow[]> {
  const rows = await prisma.platformEnvVar.findMany({ orderBy: { key: "asc" } });
  return rows.map((v) => ({
    key: v.key,
    status: v.status,
    statusLabel: v.statusLabel,
    updatedAt: v.updatedAt.toISOString(),
    hasValue: v.valueRef.length > 0,
  }));
}

export async function upsertEnvVar(args: {
  key: string;
  value: string;
  status: HealthStatus;
  statusLabel: string;
}): Promise<EnvVarRow> {
  const valueRef = encryptSecret(args.value);
  const upserted = await prisma.platformEnvVar.upsert({
    where: { key: args.key },
    create: {
      key: args.key,
      valueRef,
      status: args.status,
      statusLabel: args.statusLabel,
    },
    update: {
      valueRef,
      status: args.status,
      statusLabel: args.statusLabel,
    },
  });
  return {
    key: upserted.key,
    status: upserted.status,
    statusLabel: upserted.statusLabel,
    updatedAt: upserted.updatedAt.toISOString(),
    hasValue: true,
  };
}

// ──────────────────────────────────────────────────────────────────
// SystemComponent
// ──────────────────────────────────────────────────────────────────

export type SystemComponentRow = {
  key: string;
  name: string;
  status: HealthStatus;
  note: string;
};

export async function listSystemComponents(): Promise<SystemComponentRow[]> {
  const rows = await prisma.systemComponent.findMany({ orderBy: { key: "asc" } });
  return rows.map((c) => ({ key: c.key, name: c.name, status: c.status, note: c.note }));
}

export async function upsertSystemComponent(args: {
  key: string;
  name: string;
  status: HealthStatus;
  note: string;
}): Promise<SystemComponentRow> {
  const upserted = await prisma.systemComponent.upsert({
    where: { key: args.key },
    create: { key: args.key, name: args.name, status: args.status, note: args.note },
    update: { name: args.name, status: args.status, note: args.note },
  });
  return { key: upserted.key, name: upserted.name, status: upserted.status, note: upserted.note };
}
