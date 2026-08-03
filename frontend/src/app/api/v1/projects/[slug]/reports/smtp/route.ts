import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { encryptSecret } from "@/lib/auth/crypto";
import { resolveMailConfig, verifySmtp } from "@/lib/reports/mailer";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * Email delivery settings for scheduled reports.
 *
 * Lives under the project's Reports tab rather than the platform admin
 * console, because that console is gated on the super-admin role — a project
 * developer configuring their own reports would otherwise hit a 404 and have
 * no way in. Delivery settings are platform-wide (one relay, one from-address)
 * but they are edited from where they are used.
 *
 * The password is written as AES-256-GCM ciphertext and NEVER read back to a
 * client. GET reports only whether one is stored.
 *
 *   GET   — current settings, password redacted
 *   POST  — { action: "save" | "test" }
 */
export async function GET(_req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const s = await prisma.platformSetting.findFirst({
    select: {
      smtpHost: true,
      smtpPort: true,
      fromAddress: true,
      smtpUser: true,
      smtpPasswordRef: true,
      smtpVerifiedAt: true,
    },
  });
  const resolved = await resolveMailConfig();

  return NextResponse.json({
    ok: true,
    settings: {
      host: s?.smtpHost ?? "",
      port: s?.smtpPort ?? 587,
      from: s?.fromAddress ?? "",
      user: s?.smtpUser ?? "",
      // Never the value — only whether one exists, so the UI can show
      // "saved" without ever transporting the secret to a browser.
      hasPassword: !!s?.smtpPasswordRef || !!process.env.SMTP_PASSWORD,
      passwordFromEnv: !s?.smtpPasswordRef && !!process.env.SMTP_PASSWORD,
      verifiedAt: s?.smtpVerifiedAt?.toISOString() ?? null,
    },
    configured: resolved.ok,
    missing: resolved.ok ? [] : resolved.missing,
  });
}

const Body = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("save"),
    host: z
      .string()
      .trim()
      .min(1, "SMTP host is required.")
      // The single most common mistake: pasting the email address into the
      // host field. It saves fine, then every send fails with a DNS error
      // that never mentions the real problem.
      .refine((h) => !h.includes("@"), {
        message:
          "SMTP host must be a mail SERVER hostname, not an email address — e.g. smtp.gmail.com, not you@gmail.com.",
      })
      .refine((h) => /^[a-z0-9.-]+\.[a-z]{2,}$/i.test(h), {
        message: "SMTP host must look like a hostname, e.g. smtp.gmail.com or email-smtp.us-east-1.amazonaws.com.",
      }),
    port: z.coerce.number().int().min(1).max(65535).default(587),
    from: z.string().trim().email("From address must be a valid email."),
    /** Blank means "leave the stored password unchanged". */
    password: z.string().default(""),
    /** Blank means "use the from-address", which is what most relays expect. */
    user: z.string().trim().default(""),
  }),
  z.object({ action: z.literal("test") }),
])
  // Refined on the UNION, not the member: z.discriminatedUnion requires plain
  // ZodObjects, and .refine() on a member yields a ZodEffects it rejects.
  //
  // Most relays authenticate with the full mailbox address. A display name
  // ("Mano") saves fine and then fails at send time with Google's opaque
  // "535-5.7.8 Username and Password not accepted" — which blames the
  // password and sends people to regenerate an App Password that was never
  // the problem. SendGrid is the deliberate exception: its username is the
  // literal string "apikey".
  .superRefine((v, ctx) => {
    if (v.action !== "save") return;
    if (v.user && !v.user.includes("@") && v.user !== "apikey") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["user"],
        message:
          "Username must be the full email address (e.g. you@gmail.com), not a display name. Leave it blank to use the From address.",
      });
    }
  });

export async function POST(req: Request, ctx: { params: Promise<{ slug: string }> }) {
  const { slug } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const parsed = Body.safeParse(await req.json().catch(() => ({})));
  if (!parsed.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: parsed.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const body = parsed.data;

  if (body.action === "test") {
    const cfg = await resolveMailConfig();
    if (!cfg.ok) {
      return NextResponse.json({ ok: false, message: cfg.error }, { status: 400 });
    }
    const res = await verifySmtp(cfg.config);
    if (res.ok) {
      // Record the successful handshake so the UI can show when it last worked.
      const existing = await prisma.platformSetting.findFirst({ select: { id: true } });
      if (existing) {
        await prisma.platformSetting.update({
          where: { id: existing.id },
          data: { smtpVerifiedAt: new Date() },
        });
      }
      return NextResponse.json({
        ok: true,
        message: `Connected to ${cfg.config.host}:${cfg.config.port} as ${cfg.config.user}. Reports can be delivered.`,
      });
    }
    return NextResponse.json({ ok: false, message: res.error }, { status: 400 });
  }

  // save
  const data: {
    smtpHost: string;
    smtpPort: number;
    fromAddress: string;
    smtpUser: string | null;
    smtpPasswordRef?: string;
  } = {
    smtpHost: body.host,
    smtpPort: body.port,
    fromAddress: body.from,
    smtpUser: body.user || null,
  };
  // An empty password field means "keep what's stored" — otherwise editing the
  // host would silently wipe the credential, which is a nasty surprise.
  if (body.password.trim()) {
    // Strip ALL whitespace, not just the ends.
    //
    // Google presents an App Password as four space-separated groups
    // ("abcd efgh ijkl mnop") and people paste it exactly as shown. Those
    // spaces are display formatting, not part of the credential — sending
    // them verbatim produces "535-5.7.8 Username and Password not accepted",
    // identical to the message for a genuinely wrong password. The user then
    // regenerates a correct password and pastes it the same way, forever.
    data.smtpPasswordRef = encryptSecret(body.password.replace(/\s+/g, ""));
  }

  const existing = await prisma.platformSetting.findFirst({ select: { id: true } });
  if (existing) {
    await prisma.platformSetting.update({ where: { id: existing.id }, data });
  } else {
    // First-run: the settings row may not exist yet. siteTitle and
    // metaDescription are required by the schema, so seed sensible values
    // rather than failing on a column this form has nothing to say about.
    await prisma.platformSetting.create({
      data: { siteTitle: "DeepAgent", metaDescription: "Autonomous DevOps", ...data },
    });
  }

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "admin.settings_patched",
    targetType: "platform_setting",
    targetId: "smtp",
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    // Host and from-address only — never the password, not even its length.
    metadata: { host: body.host, port: body.port, from: body.from, passwordChanged: !!body.password.trim() },
  });

  const resolved = await resolveMailConfig();
  return NextResponse.json({
    ok: true,
    configured: resolved.ok,
    missing: resolved.ok ? [] : resolved.missing,
    message: resolved.ok
      ? "Saved. Use Test connection to confirm before relying on the daily schedule."
      : `Saved, but still incomplete — missing: ${resolved.missing.join(", ")}.`,
  });
}
