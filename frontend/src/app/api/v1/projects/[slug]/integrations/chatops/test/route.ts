import { NextResponse } from "next/server";
import { z } from "zod";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { postToChatOps, postToWebhookUrl, type ChatMessage } from "@/lib/integrations/chatops";

/**
 * POST /projects/[slug]/integrations/chatops/test
 * Send a test message. If provider+webhookUrl are passed (before saving), tests
 * that URL directly; otherwise posts to the saved connection.
 */
const Body = z.object({ provider: z.enum(["teams", "slack"]).optional(), webhookUrl: z.string().trim().url().optional() });

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  const msg: ChatMessage = {
    title: "✅ DeepAgent connected",
    text: "You'll get alerts, deploy results and security findings in this channel.",
    color: "2EB67D",
  };

  const res = parsed.success && parsed.data.webhookUrl
    ? await postToWebhookUrl(parsed.data.webhookUrl, parsed.data.provider ?? "teams", msg)
    : await postToChatOps(gate.access.project.id, msg);

  if (!res.ok) return NextResponse.json({ ok: false, message: res.error }, { status: 400 });
  return NextResponse.json({ ok: true });
}
