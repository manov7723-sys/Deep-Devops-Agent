/**
 * TLS certificate expiry check — opens a TLS connection to an https URL and
 * reads the server certificate's `valid_to` date. Used by the uptime monitors
 * to warn before a cert expires (a common cause of "the whole site is down").
 */
import tls from "node:tls";

const TIMEOUT_MS = 10_000;

/** Returns the certificate expiry date for an https URL, or null if unavailable. */
export async function getCertExpiry(rawUrl: string): Promise<Date | null> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;

  const host = url.hostname;
  const port = url.port ? Number(url.port) : 443;

  return new Promise<Date | null>((resolve) => {
    let settled = false;
    const done = (v: Date | null) => {
      if (settled) return;
      settled = true;
      try {
        socket.destroy();
      } catch {
        /* ignore */
      }
      resolve(v);
    };

    const socket = tls.connect(
      { host, port, servername: host, timeout: TIMEOUT_MS, rejectUnauthorized: false },
      () => {
        const cert = socket.getPeerCertificate();
        if (!cert || !cert.valid_to) return done(null);
        const exp = new Date(cert.valid_to);
        done(Number.isNaN(exp.getTime()) ? null : exp);
      },
    );
    socket.on("error", () => done(null));
    socket.on("timeout", () => done(null));
    setTimeout(() => done(null), TIMEOUT_MS + 1000);
  });
}

export function daysUntil(date: Date, now: Date): number {
  return Math.floor((date.getTime() - now.getTime()) / (24 * 60 * 60 * 1000));
}
