/**
 * SMTP delivery for scheduled reports.
 *
 * Host/port/from live in `PlatformSetting` (already in the schema); the
 * PASSWORD deliberately does not. Credentials belong in the environment, not
 * in a table a project admin can read through the settings UI — so it comes
 * from `SMTP_PASSWORD` (with `SMTP_USER` defaulting to the from-address,
 * which is what most providers expect).
 *
 * Every failure returns rather than throws: a report send is a background job
 * whose failure must be recorded against the run, not surfaced as an
 * unhandled rejection in the scheduler tick.
 */
import nodemailer from "nodemailer";
import { prisma } from "@/lib/db/prisma";

export type MailConfig = {
  host: string;
  port: number;
  from: string;
  user: string;
  password: string;
  /** Implicit TLS on 465; STARTTLS on 587/25. */
  secure: boolean;
};

export type MailConfigResult =
  | { ok: true; config: MailConfig }
  | { ok: false; error: string; missing: string[] };

/**
 * Resolve SMTP configuration, naming every missing piece at once.
 *
 * Reporting them one at a time turns setup into a guessing game — the caller
 * fixes one field, retries, and discovers the next.
 */
export async function resolveMailConfig(): Promise<MailConfigResult> {
  const setting = await prisma.platformSetting.findFirst({
    select: { smtpHost: true, smtpPort: true, fromAddress: true },
  });

  const host = setting?.smtpHost?.trim() || process.env.SMTP_HOST?.trim() || "";
  const port = setting?.smtpPort ?? Number(process.env.SMTP_PORT ?? 587);
  const from = setting?.fromAddress?.trim() || process.env.SMTP_FROM?.trim() || "";
  const password = process.env.SMTP_PASSWORD ?? "";
  const user = process.env.SMTP_USER?.trim() || from;

  const missing: string[] = [];
  if (!host) missing.push("SMTP host (Admin → Settings, or SMTP_HOST)");
  if (!from) missing.push("From address (Admin → Settings, or SMTP_FROM)");
  if (!password) missing.push("SMTP_PASSWORD (environment variable)");
  if (missing.length > 0) {
    return {
      ok: false,
      missing,
      error: `SMTP is not configured — missing: ${missing.join("; ")}.`,
    };
  }

  return {
    ok: true,
    config: { host, port, from, user, password, secure: port === 465 },
  };
}

export type SendResult = { ok: true; accepted: string[] } | { ok: false; error: string };

/** Send one HTML email to many recipients. */
export async function sendReportEmail(args: {
  config: MailConfig;
  to: string[];
  subject: string;
  html: string;
}): Promise<SendResult> {
  const { config, to, subject, html } = args;
  if (to.length === 0) return { ok: false, error: "No recipients." };

  try {
    const transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.password },
    });

    const info = await transport.sendMail({
      from: config.from,
      // BCC, not To: recipients of an infrastructure report shouldn't have
      // each other's addresses disclosed, and a long visible To: list is how
      // internal distribution lists leak.
      bcc: to,
      to: config.from,
      subject,
      html,
    });

    const accepted = (info.accepted ?? []).map((a) => (typeof a === "string" ? a : a.address));
    if (accepted.length === 0) {
      return { ok: false, error: "The SMTP server accepted no recipients." };
    }
    return { ok: true, accepted };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "Unknown SMTP error";
    // The three failures that account for nearly every first-run problem, each
    // with an opaque default message.
    const hint = /EAUTH|535/i.test(msg)
      ? " — authentication rejected. For Gmail this must be an App Password, not the account password."
      : /ECONNREFUSED|ETIMEDOUT|EHOSTUNREACH/i.test(msg)
        ? " — could not reach the SMTP host. Check the host/port and that outbound SMTP isn't blocked."
        : /self.signed|certificate/i.test(msg)
          ? " — TLS certificate rejected. Port 465 expects implicit TLS; 587 expects STARTTLS."
          : "";
    return { ok: false, error: `${msg}${hint}` };
  }
}

/** Verify SMTP without sending — powers a "Test connection" button. */
export async function verifySmtp(config: MailConfig): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const transport = nodemailer.createTransport({
      host: config.host,
      port: config.port,
      secure: config.secure,
      auth: { user: config.user, pass: config.password },
    });
    await transport.verify();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "SMTP verification failed." };
  }
}
