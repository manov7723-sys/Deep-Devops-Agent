/**
 * ChatOps outbound — post alerts / deploys / errors to the team's channel via an
 * incoming webhook. Supports Microsoft Teams (default) and Slack; the message is
 * formatted per provider from a neutral shape. The URL is stored encrypted and
 * all posting is best-effort (never throws).
 */
import { prisma } from "@/lib/db/prisma";
import { encryptSecret, decryptSecret } from "@/lib/auth/crypto";

export type ChatProvider = "teams" | "slack";
export type ChatOpsStatus = { connected: boolean; enabled: boolean; provider: ChatProvider; channel: string | null };

/** Neutral message the per-provider formatters render. */
export type ChatMessage = { title: string; text?: string; color?: string; facts?: Array<{ name: string; value: string }> };

export async function getChatOpsStatus(projectId: string): Promise<ChatOpsStatus> {
  const row = await prisma.chatOpsWebhook.findUnique({ where: { projectId }, select: { enabled: true, channel: true, provider: true } });
  return { connected: !!row, enabled: row?.enabled ?? false, provider: (row?.provider as ChatProvider) ?? "teams", channel: row?.channel ?? null };
}

export async function setChatOpsWebhook(projectId: string, provider: ChatProvider, webhookUrl: string, channel: string | null, enabled = true): Promise<void> {
  const webhookRef = encryptSecret(webhookUrl.trim());
  await prisma.chatOpsWebhook.upsert({
    where: { projectId },
    create: { projectId, provider, webhookRef, channel: channel?.trim() || null, enabled },
    update: { provider, webhookRef, channel: channel?.trim() || null, enabled },
  });
}

export async function setChatOpsEnabled(projectId: string, enabled: boolean): Promise<void> {
  await prisma.chatOpsWebhook.updateMany({ where: { projectId }, data: { enabled } });
}

export async function removeChatOps(projectId: string): Promise<void> {
  await prisma.chatOpsWebhook.deleteMany({ where: { projectId } });
}

async function resolve(projectId: string): Promise<{ url: string; provider: ChatProvider } | null> {
  const row = await prisma.chatOpsWebhook.findUnique({ where: { projectId }, select: { webhookRef: true, enabled: true, provider: true } });
  if (!row || !row.enabled) return null;
  try {
    return { url: decryptSecret(row.webhookRef), provider: (row.provider as ChatProvider) ?? "teams" };
  } catch {
    return null;
  }
}

/** Render the neutral message into the provider's webhook JSON. */
function renderPayload(provider: ChatProvider, m: ChatMessage): unknown {
  if (provider === "slack") {
    const factLine = m.facts?.map((f) => `*${f.name}:* ${f.value}`).join("  ·  ");
    return {
      text: m.title,
      blocks: [
        { type: "section", text: { type: "mrkdwn", text: `*${m.title}*` } },
        ...(m.text ? [{ type: "section", text: { type: "mrkdwn", text: m.text.slice(0, 2800) } }] : []),
        ...(factLine ? [{ type: "context", elements: [{ type: "mrkdwn", text: factLine }] }] : []),
      ],
    };
  }
  // Teams — Adaptive Card wrapped for a Power Automate "Workflows" webhook
  // (the current path; the classic MessageCard connector is retired).
  const titleColor = m.color === "E5484D" ? "Attention" : m.color === "F5A623" ? "Warning" : m.color === "2EB67D" ? "Good" : "Default";
  const body: unknown[] = [{ type: "TextBlock", size: "Medium", weight: "Bolder", wrap: true, color: titleColor, text: m.title }];
  if (m.text) body.push({ type: "TextBlock", wrap: true, text: m.text.slice(0, 2800) });
  if (m.facts?.length) body.push({ type: "FactSet", facts: m.facts.map((f) => ({ title: f.name, value: f.value })) });
  return {
    type: "message",
    attachments: [
      {
        contentType: "application/vnd.microsoft.card.adaptive",
        content: { type: "AdaptiveCard", $schema: "http://adaptivecards.io/schemas/adaptive-card.json", version: "1.4", body },
      },
    ],
  };
}

/** POST to a webhook URL with the right format for the provider. */
export async function postToWebhookUrl(url: string, provider: ChatProvider, m: ChatMessage): Promise<{ ok: boolean; error?: string }> {
  try {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(renderPayload(provider, m)) });
    if (!res.ok) {
      const t = await res.text().catch(() => "");
      return { ok: false, error: `Webhook returned HTTP ${res.status}${t ? ` (${t.slice(0, 120)})` : ""}` };
    }
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "network error" };
  }
}

/** Post to the project's configured channel (if connected + enabled). */
export async function postToChatOps(projectId: string, m: ChatMessage): Promise<{ ok: boolean; error?: string }> {
  const r = await resolve(projectId);
  if (!r) return { ok: false, error: "ChatOps is not connected for this project." };
  return postToWebhookUrl(r.url, r.provider, m);
}

const SEV_COLOR: Record<string, string> = { high: "E5484D", medium: "F5A623", low: "E9C46A" };
const SEV_EMOJI: Record<string, string> = { high: "🔴", medium: "🟠", low: "🟡" };

/** Format + post an alert. Fire-and-forget; never throws. */
export async function postAlertToChatOps(
  projectId: string,
  a: { title: string; detail: string; severity: string; category: string; resource: string; env?: string },
): Promise<void> {
  try {
    await postToChatOps(projectId, {
      title: `${SEV_EMOJI[a.severity] ?? "⚠️"} ${a.title}`,
      text: a.detail,
      color: SEV_COLOR[a.severity] ?? "E5484D",
      facts: [
        { name: "Severity", value: a.severity.toUpperCase() },
        { name: "Category", value: a.category },
        { name: "Resource", value: a.resource },
        ...(a.env ? [{ name: "Environment", value: a.env }] : []),
      ],
    });
  } catch {
    /* best-effort */
  }
}

/** Generic event post (deploys, scans, cost). Fire-and-forget. */
export async function postEventToChatOps(projectId: string, emoji: string, title: string, detail?: string): Promise<void> {
  try {
    await postToChatOps(projectId, { title: `${emoji} ${title}`, text: detail, color: "2EB67D" });
  } catch {
    /* best-effort */
  }
}
