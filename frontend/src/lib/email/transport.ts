/**
 * Email transport.
 *
 * Strategy:
 *   - If MAILJET_API_KEY + MAILJET_SECRET_KEY are set, send via Mailjet.
 *   - Otherwise, log to stdout so the dev mail "transport" still works in
 *     development and the Playwright sweep can read tokens out of the log.
 *
 * The dev/Mailjet split is intentional — the helper used to be dev-only and
 * any test that grepped the log for a token would silently break if we
 * switched to a real transport. Keeping both paths means setting/unsetting
 * the keys flips behaviour without code changes.
 */
export type EmailMessage = {
  to: string;
  subject: string;
  text: string;
};

function isMailjetConfigured(): boolean {
  return !!(process.env.MAILJET_API_KEY && process.env.MAILJET_SECRET_KEY);
}

type FromAddress = { email: string; name: string };

/** Parse `"Display Name <email@host>"` or a bare `"email@host"`. */
function parseFromAddress(): FromAddress {
  const raw = process.env.MAILJET_FROM_EMAIL ?? "";
  const fallbackName = process.env.MAILJET_FROM_NAME ?? "DeepAgent";
  const m = raw.match(/^\s*(.*?)\s*<([^>]+)>\s*$/);
  if (m) return { name: m[1] || fallbackName, email: m[2] };
  return { name: fallbackName, email: raw || "no-reply@deepagent.local" };
}

async function sendViaMailjet(msg: EmailMessage): Promise<void> {
  const auth = Buffer.from(
    `${process.env.MAILJET_API_KEY}:${process.env.MAILJET_SECRET_KEY}`,
  ).toString("base64");
  const from = parseFromAddress();
  const body = {
    Messages: [
      {
        From: { Email: from.email, Name: from.name },
        To: [{ Email: msg.to }],
        Subject: msg.subject,
        TextPart: msg.text,
      },
    ],
  };
  const res = await fetch("https://api.mailjet.com/v3.1/send", {
    method: "POST",
    headers: {
      Authorization: `Basic ${auth}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`Mailjet ${res.status}: ${text}`);
  }
}

function logDevEmail(msg: EmailMessage): void {
  // eslint-disable-next-line no-console
  console.log(
    [
      "",
      "─── 📧 [dev email transport] ─────────────────────────────",
      `To:      ${msg.to}`,
      `Subject: ${msg.subject}`,
      "",
      msg.text,
      "──────────────────────────────────────────────────────────",
      "",
    ].join("\n"),
  );
}

export async function sendEmail(msg: EmailMessage): Promise<void> {
  if (isMailjetConfigured()) {
    try {
      await sendViaMailjet(msg);
      // eslint-disable-next-line no-console
      console.log(`[email] mailjet → ${msg.to} (${msg.subject})`);
      // Mirror the dev log line too, so the Playwright token grepper still
      // works against the log — the link is also visible in the body text
      // and the grep pulls it from there.
      logDevEmail(msg);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // eslint-disable-next-line no-console
      console.error(`[email] mailjet failed (${message}), falling back to dev log`);
      logDevEmail(msg);
      return;
    }
  }
  logDevEmail(msg);
}
