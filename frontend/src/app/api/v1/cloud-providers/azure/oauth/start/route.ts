import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { getActiveSession } from "@/lib/auth/session";
import { azureOAuthConfigured, buildAzureAuthorizeUrl, newPkce } from "@/lib/cloud/azure-oauth";

const COOKIE_OPTS = { httpOnly: true, sameSite: "lax" as const, path: "/", maxAge: 600 };

/**
 * Kick off "Sign in with Microsoft" to connect an Azure account. Generates a
 * PKCE pair + state (stored in short-lived cookies), then redirects the browser
 * (popup) to the Microsoft authorize page. The callback completes the exchange.
 */
export async function GET(req: Request) {
  const sess = await getActiveSession();
  if (!sess) {
    const url = new URL("/auth/login", req.url);
    return NextResponse.redirect(url);
  }
  if (!azureOAuthConfigured()) {
    return NextResponse.json(
      {
        ok: false,
        code: "oauth_not_configured",
        message:
          "Azure OAuth isn't configured (set AZURE_OAUTH_CLIENT_ID / AZURE_OAUTH_CLIENT_SECRET).",
      },
      { status: 400 },
    );
  }

  const u = new URL(req.url);
  const projectSlug = u.searchParams.get("projectSlug") ?? "";
  const popup = u.searchParams.get("popup") === "1";
  // Optional per-connect tenant override — used for personal Microsoft accounts
  // whose Azure subscription lives in a hidden AAD tenant that /common/ can't
  // route ARM tokens through. Empty string / missing = use env default.
  const tenantId = (u.searchParams.get("tenantId") ?? "").trim();

  const { state, verifier, challenge } = newPkce();
  const jar = await cookies();
  jar.set("az_oauth_state", state, COOKIE_OPTS);
  jar.set("az_oauth_verifier", verifier, COOKIE_OPTS);
  jar.set("az_oauth_popup", popup ? "1" : "0", COOKIE_OPTS);
  jar.set("az_oauth_proj", projectSlug, COOKIE_OPTS);
  jar.set("az_oauth_tenant", tenantId, COOKIE_OPTS);

  return NextResponse.redirect(buildAzureAuthorizeUrl(state, challenge, tenantId || undefined));
}
