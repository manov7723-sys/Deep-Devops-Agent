import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { getAzureAccessToken } from "@/lib/cloud/azure";

const ARM = "https://management.azure.com";

async function armGet(token: string, path: string): Promise<unknown | null> {
  try {
    const res = await fetch(`${ARM}${path}`, {
      headers: { Authorization: `Bearer ${token}` },
      cache: "no-store",
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/**
 * Per-project Azure context: the connected subscription, the available
 * subscriptions + resource groups (fetched live), and the saved
 * resourceGroup/region/cloudEnvironment picks. GET reads, PATCH saves.
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId: gate.access.project.id, kind: "azure" },
    select: {
      id: true,
      accountRef: true,
      resourceGroup: true,
      region: true,
      cloudEnvironment: true,
    },
  });
  if (!cp) return NextResponse.json({ ok: true, connected: false });

  const tok = await getAzureAccessToken(cp.id);
  let subscriptions: Array<{ subscriptionId: string; displayName: string; state: string }> = [];
  let resourceGroups: Array<{ name: string; location: string }> = [];
  let authError: string | null = null;
  if (tok.ok) {
    const subs = (await armGet(tok.accessToken, "/subscriptions?api-version=2020-01-01")) as {
      value?: Array<{ subscriptionId: string; displayName: string; state: string }>;
    } | null;
    subscriptions = (subs?.value ?? []).map((s) => ({
      subscriptionId: s.subscriptionId,
      displayName: s.displayName,
      state: s.state,
    }));
    const rgs = (await armGet(
      tok.accessToken,
      `/subscriptions/${cp.accountRef}/resourcegroups?api-version=2021-04-01`,
    )) as { value?: Array<{ name: string; location: string }> } | null;
    resourceGroups = (rgs?.value ?? []).map((r) => ({ name: r.name, location: r.location }));
  } else {
    authError = tok.error;
  }

  return NextResponse.json({
    ok: true,
    connected: true,
    subscriptionId: cp.accountRef,
    resourceGroup: cp.resourceGroup,
    region: cp.region,
    cloudEnvironment: cp.cloudEnvironment,
    subscriptions,
    resourceGroups,
    authError,
  });
}

const PatchBody = z.object({
  subscriptionId: z.string().trim().optional(),
  resourceGroup: z.string().trim().optional(),
  region: z.string().trim().optional(),
  cloudEnvironment: z.enum(["AzurePublic", "AzureUSGovernment", "AzureChina"]).optional(),
});

export async function PATCH(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId: gate.access.project.id, kind: "azure" },
    select: { id: true },
  });
  if (!cp) return NextResponse.json({ ok: false, code: "no_azure" }, { status: 404 });

  const parsed = PatchBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json({ ok: false, code: "invalid_request" }, { status: 400 });

  const data: Record<string, string | null> = {};
  if (parsed.data.subscriptionId) data.accountRef = parsed.data.subscriptionId;
  if (parsed.data.resourceGroup !== undefined)
    data.resourceGroup = parsed.data.resourceGroup || null;
  if (parsed.data.region) data.region = parsed.data.region;
  if (parsed.data.cloudEnvironment) data.cloudEnvironment = parsed.data.cloudEnvironment;
  if (Object.keys(data).length === 0)
    return NextResponse.json({ ok: false, code: "nothing_to_save" }, { status: 400 });

  await prisma.cloudProvider.update({ where: { id: cp.id }, data });
  return NextResponse.json({ ok: true });
}
