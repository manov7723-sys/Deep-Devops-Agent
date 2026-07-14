import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import {
  getChatOpsStatus,
  setChatOpsWebhook,
  setChatOpsEnabled,
  removeChatOps,
} from "@/lib/integrations/chatops";

/**
 * ChatOps connection (Microsoft Teams or Slack) per project.
 *   GET    → { connected, enabled, provider, channel }
 *   PUT    { provider, webhookUrl, channel?, enabled? } → save
 *   PATCH  { enabled }                                  → toggle
 *   DELETE                                              → disconnect
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  return NextResponse.json({ ok: true, ...(await getChatOpsStatus(gate.access.project.id)) });
}

const PutBody = z
  .object({
    provider: z.enum(["teams", "slack"]).default("teams"),
    webhookUrl: z.string().trim().url(),
    channel: z.string().trim().max(80).optional(),
    enabled: z.boolean().default(true),
  })
  .refine(
    (b) =>
      b.provider === "slack"
        ? b.webhookUrl.startsWith("https://hooks.slack.com/")
        : b.webhookUrl.startsWith("https://"),
    {
      message:
        "Teams needs an https webhook URL (…webhook.office.com or Power Automate); Slack needs https://hooks.slack.com/…",
      path: ["webhookUrl"],
    },
  );

export async function PUT(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const parsed = PutBody.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.issues[0]?.message },
      { status: 400 },
    );
  await setChatOpsWebhook(
    gate.access.project.id,
    parsed.data.provider,
    parsed.data.webhookUrl,
    parsed.data.channel ?? null,
    parsed.data.enabled,
  );
  return NextResponse.json({ ok: true, ...(await getChatOpsStatus(gate.access.project.id)) });
}

export async function PATCH(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const parsed = z.object({ enabled: z.boolean() }).safeParse(await req.json().catch(() => ({})));
  if (!parsed.success)
    return NextResponse.json({ ok: false, code: "invalid_request" }, { status: 400 });
  await setChatOpsEnabled(gate.access.project.id, parsed.data.enabled);
  return NextResponse.json({ ok: true, ...(await getChatOpsStatus(gate.access.project.id)) });
}

export async function DELETE(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  await removeChatOps(gate.access.project.id);
  return NextResponse.json({ ok: true });
}
