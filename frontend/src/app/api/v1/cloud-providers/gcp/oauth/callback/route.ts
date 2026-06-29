import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db/prisma";
import { getActiveSession } from "@/lib/auth/session";
import { encryptSecret } from "@/lib/auth/crypto";
import { createProvider } from "@/lib/cloud/providers";
import { exchangeGcpCode, listGcpProjects } from "@/lib/cloud/gcp-oauth";
import { audit } from "@/lib/audit/log";

const CLEAR = { httpOnly: true, path: "/", maxAge: 0 };

/** Popup-aware return (postMessage + COOP-proof localStorage signal), or redirect. */
function done(popup: boolean, ok: boolean, detail: string): NextResponse {
  const status = ok ? "connected" : "error";
  const html = `<!doctype html><meta charset="utf-8"><title>GCP</title>
<body style="font:14px system-ui;padding:24px;color:#444">${ok ? "Google Cloud connected. You can close this window." : "GCP connection failed."}</body>
<script>
(function(){
  var msg = { source: "dda-gcp-oauth", status: ${JSON.stringify(status)}, detail: ${JSON.stringify(detail)} };
  try { localStorage.setItem("dda_gcp_oauth_result", JSON.stringify(msg) + "|" + Date.now()); } catch(e){}
  var isPopup = false;
  try { isPopup = ${popup ? "true" : "false"} && !!(window.opener && window.opener !== window); } catch(e){}
  if (isPopup) {
    try { window.opener.postMessage(msg, window.location.origin); } catch(e){}
    try { window.close(); } catch(e){}
    setTimeout(function(){ location.replace("/"); }, 400);
  } else {
    location.replace("/u/projects?gcp_connected=" + ${JSON.stringify(ok ? "true" : "false")});
  }
})();
</script>`;
  return new NextResponse(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const code = u.searchParams.get("code") ?? "";
  const state = u.searchParams.get("state") ?? "";
  const oauthErr = u.searchParams.get("error");

  const jar = await cookies();
  const expectState = jar.get("gcp_oauth_state")?.value;
  const verifier = jar.get("gcp_oauth_verifier")?.value;
  const popup = jar.get("gcp_oauth_popup")?.value === "1";
  const projSlug = jar.get("gcp_oauth_proj")?.value ?? "";
  jar.set("gcp_oauth_state", "", CLEAR);
  jar.set("gcp_oauth_verifier", "", CLEAR);
  jar.set("gcp_oauth_popup", "", CLEAR);
  jar.set("gcp_oauth_proj", "", CLEAR);

  if (oauthErr) return done(popup, false, `Google: ${oauthErr}`);
  if (!code || !state || !expectState || state !== expectState || !verifier) {
    return done(popup, false, "Invalid or expired sign-in state — try again.");
  }

  const sess = await getActiveSession();
  if (!sess) return done(popup, false, "Your app session expired — sign in and retry.");

  // 1 — exchange the code for tokens.
  const ex = await exchangeGcpCode(code, verifier);
  if (!ex.ok) return done(popup, false, ex.error);
  if (!ex.tokens.refreshToken) {
    return done(popup, false, "Google returned no refresh token — revoke prior access at myaccount.google.com/permissions and retry.");
  }

  // 2 — validate + resolve the GCP project.
  const projs = await listGcpProjects(ex.tokens.accessToken);
  if (!projs.ok) return done(popup, false, projs.error);
  if (projs.projects.length === 0) {
    return done(popup, false, "Signed in, but no GCP projects are visible to this account.");
  }
  const proj = projs.projects.find((p) => p.lifecycleState === "ACTIVE") ?? projs.projects[0];

  // 3 — store as a GCP CloudProvider (OAuth). accountRef = project id,
  // externalId = encrypted refresh token, isolated to the workspace project.
  try {
    const encRefresh = encryptSecret(ex.tokens.refreshToken);
    let projectId: string | undefined;
    if (projSlug) {
      const p = await prisma.project.findFirst({ where: { slug: projSlug }, select: { id: true, ownerId: true } });
      const allowed = p && (p.ownerId === sess.userId || (await prisma.membership.count({ where: { projectId: p.id, userId: sess.userId } })) > 0);
      if (p && allowed) projectId = p.id;
    }

    const existing = await prisma.cloudProvider.findFirst({
      where: { userId: sess.userId, kind: "gcp", accountRef: proj.projectId, projectId: projectId ?? null },
      select: { id: true },
    });
    let providerId: string;
    if (existing) {
      await prisma.cloudProvider.update({
        where: { id: existing.id },
        data: { externalId: encRefresh, status: "ok", name: `GCP · ${proj.name || proj.projectId}`.slice(0, 80) },
      });
      providerId = existing.id;
    } else {
      const created = await createProvider({
        userId: sess.userId,
        projectId,
        kind: "gcp",
        name: `GCP · ${proj.name || proj.projectId}`.slice(0, 80),
        accountRef: proj.projectId,
        accountId: proj.projectNumber,
        region: "us-central1",
        externalId: encRefresh,
      });
      providerId = created.id;
    }
    if (projectId) {
      await prisma.env.updateMany({ where: { projectId, cloudProviderId: null }, data: { cloudProviderId: providerId } });
    }
    await audit({
      userId: sess.userId,
      action: existing ? "cloud_provider.updated" : "cloud_provider.created",
      targetType: "cloud_provider",
      targetId: existing?.id ?? proj.projectId,
      metadata: { kind: "gcp", method: "oauth", project: proj.projectId },
    });
  } catch (e) {
    return done(popup, false, e instanceof Error ? e.message : "Could not save the GCP provider.");
  }

  return done(popup, true, `Connected ${proj.name || proj.projectId}`);
}
