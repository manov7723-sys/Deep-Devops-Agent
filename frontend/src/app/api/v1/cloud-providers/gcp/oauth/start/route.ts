import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getActiveSession } from "@/lib/auth/session";
import { gcpOAuthConfigured, buildGcpAuthorizeUrl, newPkce } from "@/lib/cloud/gcp-oauth";

const COOKIE_OPTS = { httpOnly: true, sameSite: "lax" as const, path: "/", maxAge: 600 };

/**
 * Kick off "Sign in with Google" to connect a GCP account. Generates PKCE +
 * state (stored in short-lived cookies), then redirects the browser (popup) to
 * Google's consent page. The callback completes the exchange.
 */
export async function GET(req: Request) {
  const sess = await getActiveSession();
  if (!sess) return NextResponse.redirect(new URL("/auth/login", req.url));
  if (!gcpOAuthConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        code: "oauth_not_configured",
        message: "GCP OAuth isn't configured (set GCP_OAUTH_CLIENT_ID / GCP_OAUTH_CLIENT_SECRET).",
      },
      { status: 400 },
    );
  }

  const u = new URL(req.url);
  const projectSlug = u.searchParams.get("projectSlug") ?? "";
  const popup = u.searchParams.get("popup") === "1";

  const { state, verifier, challenge } = newPkce();
  const jar = await cookies();
  jar.set("gcp_oauth_state", state, COOKIE_OPTS);
  jar.set("gcp_oauth_verifier", verifier, COOKIE_OPTS);
  jar.set("gcp_oauth_popup", popup ? "1" : "0", COOKIE_OPTS);
  jar.set("gcp_oauth_proj", projectSlug, COOKIE_OPTS);

  return NextResponse.redirect(buildGcpAuthorizeUrl(state, challenge));
}
