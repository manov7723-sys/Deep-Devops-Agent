import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { prisma } from "@/lib/db/prisma";
import { getActiveSession } from "@/lib/auth/session";
import { encryptSecret } from "@/lib/auth/crypto";
import { createProvider } from "@/lib/cloud/providers";
import {
  exchangeAzureCode,
  listAzureSubscriptions,
  azureOAuthGraphEnabled,
} from "@/lib/cloud/azure-oauth";
import { autoProvisionSpFromOAuth } from "@/lib/cloud/azure-provision-sp";
import { audit } from "@/lib/audit/log";

const CLEAR = { httpOnly: true, path: "/", maxAge: 0 };

/** Decode the `tid` (tenant) claim from a JWT access token, best-effort. */
function tenantFromToken(accessToken: string): string | null {
  try {
    const payload = accessToken.split(".")[1];
    const json = JSON.parse(Buffer.from(payload, "base64").toString("utf8")) as { tid?: string };
    return json.tid ?? null;
  } catch {
    return null;
  }
}

/** Popup-aware return: notify the opener + close, or redirect a normal tab. */
function done(popup: boolean, ok: boolean, detail: string): NextResponse {
  const status = ok ? "connected" : "error";
  const html = `<!doctype html><meta charset="utf-8"><title>Azure</title>
<body style="font:14px system-ui;padding:24px;color:#444">${ok ? "Azure connected. You can close this window." : "Azure connection failed."}</body>
<script>
(function(){
  var msg = { source: "dda-azure-oauth", status: ${JSON.stringify(status)}, detail: ${JSON.stringify(detail)} };
  var isPopup = false;
  try { isPopup = ${popup ? "true" : "false"} && !!(window.opener && window.opener !== window); } catch(e){}
  // localStorage is a COOP-proof channel: the opener gets a 'storage' event
  // even when Cross-Origin-Opener-Policy severs window.opener (Next 16).
  try { localStorage.setItem("dda_azure_oauth_result", JSON.stringify(msg) + "|" + Date.now()); } catch(e){}
  if (isPopup) {
    try { window.opener.postMessage(msg, window.location.origin); } catch(e){}
    try { window.close(); } catch(e){}
    setTimeout(function(){ location.replace("/"); }, 400);
  } else {
    location.replace("/u/projects?azure_connected=" + ${JSON.stringify(ok ? "true" : "false")});
  }
})();
</script>`;
  return new NextResponse(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

export async function GET(req: Request) {
  const u = new URL(req.url);
  const code = u.searchParams.get("code") ?? "";
  const state = u.searchParams.get("state") ?? "";
  const oauthErr = u.searchParams.get("error_description") || u.searchParams.get("error");

  const jar = await cookies();
  const expectState = jar.get("az_oauth_state")?.value;
  const verifier = jar.get("az_oauth_verifier")?.value;
  const popup = jar.get("az_oauth_popup")?.value === "1";
  const projSlug = jar.get("az_oauth_proj")?.value ?? "";
  // Tenant override set by the start route from the UI's optional Tenant ID
  // field. Must match what was used to build the authorize URL — the token
  // exchange fails otherwise.
  const tenantOverride = jar.get("az_oauth_tenant")?.value ?? "";
  // Clear the one-time cookies regardless of outcome.
  jar.set("az_oauth_state", "", CLEAR);
  jar.set("az_oauth_verifier", "", CLEAR);
  jar.set("az_oauth_popup", "", CLEAR);
  jar.set("az_oauth_proj", "", CLEAR);
  jar.set("az_oauth_tenant", "", CLEAR);

  if (oauthErr) return done(popup, false, `Microsoft: ${oauthErr}`);
  if (!code || !state || !expectState || state !== expectState || !verifier) {
    return done(popup, false, "Invalid or expired sign-in state — try again.");
  }

  const sess = await getActiveSession();
  if (!sess) return done(popup, false, "Your app session expired — sign in and retry.");

  // 1 — exchange the code for tokens. Tenant override must match the one used
  // in the authorize URL (see start route + start-cookie above).
  const ex = await exchangeAzureCode(code, verifier, tenantOverride || undefined);
  if (!ex.ok) return done(popup, false, ex.error);
  if (!ex.tokens.refreshToken)
    return done(popup, false, "Microsoft returned no refresh token (offline_access not granted).");

  // 2 — validate + resolve the subscription.
  const subsRes = await listAzureSubscriptions(ex.tokens.accessToken);
  if (!subsRes.ok) return done(popup, false, subsRes.error);
  if (subsRes.subs.length === 0) {
    return done(popup, false, "Signed in, but no Azure subscriptions are visible to this account.");
  }
  const sub = subsRes.subs.find((s) => s.state === "Enabled") ?? subsRes.subs[0];
  const tenantId =
    tenantFromToken(ex.tokens.accessToken) ?? process.env.AZURE_OAUTH_TENANT_ID ?? "";

  // 3 — store as an Azure CloudProvider (OAuth method). Convention: roleArn is
  // LEFT NULL for OAuth providers (SP providers always have a client id there),
  // externalId holds the ENCRYPTED refresh token.
  try {
    const encRefresh = encryptSecret(ex.tokens.refreshToken);

    // ISOLATION: resolve which project this connection belongs to (verify access).
    let projectId: string | undefined;
    if (projSlug) {
      const proj = await prisma.project.findFirst({
        where: { slug: projSlug },
        select: { id: true, ownerId: true },
      });
      const allowed =
        proj &&
        (proj.ownerId === sess.userId ||
          (await prisma.membership.count({ where: { projectId: proj.id, userId: sess.userId } })) >
            0);
      if (proj && allowed) projectId = proj.id;
    }

    // Dedupe within the SAME project: reconnecting the same subscription in this
    // project refreshes the token; the same account in another project is a
    // separate row (that's the isolation guarantee).
    const existing = await prisma.cloudProvider.findFirst({
      where: {
        userId: sess.userId,
        kind: "azure",
        accountRef: sub.id,
        projectId: projectId ?? null,
      },
      select: { id: true },
    });
    let providerId: string;
    if (existing) {
      await prisma.cloudProvider.update({
        where: { id: existing.id },
        data: {
          externalId: encRefresh,
          accountId: tenantId,
          status: "ok",
          name: `Azure · ${sub.displayName}`.slice(0, 80),
        },
      });
      providerId = existing.id;
    } else {
      const created = await createProvider({
        userId: sess.userId,
        projectId,
        kind: "azure",
        name: `Azure · ${sub.displayName}`.slice(0, 80),
        accountRef: sub.id,
        accountId: tenantId,
        region: "eastus",
        externalId: encRefresh,
      });
      providerId = created.id;
    }
    // Rebind envs to this freshly-connected provider:
    //   1. Envs with no provider yet — first-time connect
    //   2. Envs bound to any OTHER Azure provider in this project — reconnect
    //      with a different account/subscription. Without this step the envs
    //      stay pointed at stale creds and Terraform hits the OLD subscription.
    // Also nulls out ManagedResource/TfRun/CloudSecurityScope refs and deletes
    // the stale Azure providers so the Cloud page stays clean.
    if (projectId) {
      const staleAzure = await prisma.cloudProvider.findMany({
        where: { projectId, kind: "azure", id: { not: providerId } },
        select: { id: true },
      });
      const staleIds = staleAzure.map((p) => p.id);
      await prisma.env.updateMany({
        where: {
          projectId,
          OR: [
            { cloudProviderId: null },
            ...(staleIds.length > 0 ? [{ cloudProviderId: { in: staleIds } }] : []),
          ],
        },
        data: { cloudProviderId: providerId },
      });
      if (staleIds.length > 0) {
        // TfRun/ManagedResource don't cascade — null them out so the
        // CloudProvider delete below doesn't hit a FK restrict.
        await prisma.tfRun.updateMany({
          where: { cloudProviderId: { in: staleIds } },
          data: { cloudProviderId: null },
        });
        await prisma.managedResource.updateMany({
          where: { cloudProviderId: { in: staleIds } },
          data: { cloudProviderId: null },
        });
        await prisma.cloudProvider.deleteMany({ where: { id: { in: staleIds } } });
      }
    }
    await audit({
      userId: sess.userId,
      action: existing ? "cloud_provider.updated" : "cloud_provider.created",
      targetType: "cloud_provider",
      targetId: existing?.id ?? sub.id,
      metadata: { kind: "azure", method: "oauth", subscription: sub.id },
    });

    // Hybrid auth: right after saving the OAuth provider, silently try to
    // auto-provision an SP via Graph so keyless deploy/cluster ops work without
    // the ACR-admin-secret fallback. Non-blocking — failures (no admin consent,
    // user isn't sub Owner) just leave the columns null. The self-heal path
    // (repair_azure_acr_push_auth) remains as the safety net.
    if (azureOAuthGraphEnabled() && ex.tokens.refreshToken && tenantId) {
      try {
        const sp = await autoProvisionSpFromOAuth({
          oauthRefreshToken: ex.tokens.refreshToken,
          userArmAccessToken: ex.tokens.accessToken,
          tenantId,
          subscriptionId: sub.id,
          displayNameHint: `deepagent-${sub.displayName}`
            .replace(/[^A-Za-z0-9-]/g, "-")
            .slice(0, 90),
        });
        if (sp.ok) {
          await prisma.cloudProvider.update({
            where: { id: providerId },
            data: {
              spClientId: sp.data.clientId,
              spClientSecretEnc: encryptSecret(sp.data.clientSecret),
            },
          });
          await audit({
            userId: sess.userId,
            action: "cloud_provider.sp_provisioned",
            targetType: "cloud_provider",
            targetId: providerId,
            metadata: { kind: "azure", subscription: sub.id, appName: sp.data.appDisplayName },
          }).catch(() => {});
        } else {
          // Silent skip — OAuth is already saved, connect flow proceeds.
          // eslint-disable-next-line no-console
          console.warn(`[azure-oauth] SP auto-provisioning skipped for sub ${sub.id}: ${sp.error}`);
        }
      } catch (e) {
        // eslint-disable-next-line no-console
        console.warn(
          `[azure-oauth] SP auto-provisioning threw: ${e instanceof Error ? e.message : e}`,
        );
      }
    }
  } catch (e) {
    return done(
      popup,
      false,
      e instanceof Error ? e.message : "Could not save the Azure provider.",
    );
  }

  return done(popup, true, `Connected ${sub.displayName}`);
}
