import { prisma } from "@/lib/db/prisma";

/**
 * Pull the bearer token out of a kubeconfig's `users:` block. AKS token-based
 * kubeconfigs written by getAksKubeconfig's toTokenKubeconfig path put the
 * JWT directly under `user.token:` — that's the string kubectl sends as the
 * `Authorization: Bearer` header and therefore what AAD sees as the caller.
 *
 * Returns null if no bearer token is found (e.g. cert-based admin creds,
 * exec-plugin kubelogin, or non-AKS kubeconfig).
 */
function extractTokenFromKubeconfig(kubeconfig: string): string | null {
  const m = kubeconfig.match(/^\s*token:\s*(\S+)\s*$/m);
  const value = m?.[1];
  if (!value) return null;
  // A real JWT has three dot-separated base64 parts; anything else is either
  // truncated or not a JWT (which callerIdentityFromToken would misparse).
  return /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(value) ? value : null;
}

import {
  grantAksRbacClusterAdmin,
  callerIdentityFromToken,
  parseAksClusterRef,
} from "@/lib/cloud/azure-acr";
import { getAzureAccessToken } from "@/lib/cloud/azure";
import { listAksClusters } from "@/lib/cloud/azure-arm";
import { getKubeconfigForEnv } from "@/lib/runner/creds";
import type { Tool } from "./types";

/**
 * Grant an AAD principal `Azure Kubernetes Service RBAC Cluster Admin` on an
 * env's AKS cluster — the AKS mirror of grant_eks_access. Silent self-heal for
 * the "does not have access to the resource in Azure" kubectl error that
 * hits every deploy against an AAD-RBAC-enabled cluster until the deploy
 * identity has this role.
 *
 * The AKS blueprint in this codebase ships with `azure_rbac_enabled = true`,
 * so every cluster it creates needs this grant for at least one identity —
 * usually the app's connected Azure user or SP. Without it, CD workflows
 * that use the exec-plugin kubeconfig (as opposed to the cert-based admin
 * one) fail every kubectl call.
 *
 * Two ways it discovers who to grant to:
 *   1. `principalObjectId` in input — explicit override for granting a
 *      DIFFERENT identity (e.g. a CI service account).
 *   2. Otherwise, decode the connected Azure token and use ITS oid — the
 *      identity the app is acting as, which is what wrote the kubeconfig
 *      and therefore what kubectl authenticates as.
 */
export const grantAksAccessTool: Tool<
  {
    envKey: string;
    /** Explicit principal object id to grant. Omit to grant the connected
     *  Azure identity (usually correct). */
    principalObjectId?: string;
    principalType?: "User" | "ServicePrincipal" | "Group";
    /** Explicit cluster name — used when the env's kubeconfig can't be
     *  parsed and the subscription has more than one AKS cluster. */
    clusterName?: string;
    resourceGroup?: string;
  },
  {
    clusterName: string;
    resourceGroup: string;
    principalObjectId: string;
    principalType: string;
    note: string;
    /** Present when the caller must disambiguate — kubeconfig-parse failed
     *  and more than one AKS cluster exists in the sub. */
    candidates?: Array<{ name: string; resourceGroup: string; location: string }>;
  }
> = {
  name: "grant_aks_access",
  description:
    "Grant the connected Azure identity (or an explicit principal) `Azure Kubernetes Service RBAC Cluster Admin` on an env's AKS cluster. Use this to auto-heal the 'does not have access to the resource in Azure. Update role assignment to allow access' error every kubectl call throws on an AAD-RBAC-enabled cluster until this role is granted. The app CAN do this — NEVER tell the user to open the Portal → Access control (IAM) → Add role assignment. Idempotent.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: {
        type: "string",
        description: "Env whose AKS cluster to grant access on (from list_deploy_targets).",
      },
      principalObjectId: {
        type: "string",
        description:
          "AAD object id to grant. Omit to grant the connected Azure identity (usually correct — that's who the CD's kubeconfig authenticates as). Set this to the exact oid from a Kubernetes 'Forbidden — user XYZ does not have access' error when the caller and the failing identity differ.",
      },
      principalType: {
        type: "string",
        enum: ["User", "ServicePrincipal", "Group"],
        description:
          "Principal type — must match what Graph has for the object. Omit when principalObjectId is omitted (auto-detected from the token).",
      },
      clusterName: {
        type: "string",
        description:
          "Explicit AKS cluster name. Use only when the env's kubeconfig cannot be parsed and listAksClusters returned multiple candidates.",
      },
      resourceGroup: {
        type: "string",
        description: "Resource group of the explicit cluster. Required alongside clusterName.",
      },
    },
    required: ["envKey"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    // Env → connected Azure cloud provider.
    const env = await prisma.env.findFirst({
      where: { projectId: ctx.projectId, key: input.envKey },
      select: { id: true, cloudProviderId: true },
    });
    if (!env) return { ok: false, error: `Env "${input.envKey}" not found on this project.` };
    if (!env.cloudProviderId) {
      return {
        ok: false,
        error: `Env "${input.envKey}" has no cloud provider connected — connect one first.`,
      };
    }
    const cp = await prisma.cloudProvider.findFirst({
      where: { id: env.cloudProviderId, kind: "azure" },
      select: { id: true },
    });
    if (!cp) {
      return {
        ok: false,
        error: `Env "${input.envKey}" isn't wired to an Azure cloud provider — use grant_eks_access for AWS clusters.`,
      };
    }

    // Which cluster? Three sources, in order:
    //   1. Explicit input (clusterName + resourceGroup) — used when a prior
    //      call disambiguated via the candidates list.
    //   2. Parse the env's stored kubeconfig — cheap and specific.
    //   3. Fall back to ARM's listAksClusters on the subscription. Robust
    //      against kubeconfigs the parser doesn't recognise (which happens
    //      when the kubeconfig was written with non-standard user names or
    //      by an older code path).
    //
    // If exactly one AKS cluster exists in the subscription, we use it —
    // same policy as repair_cd_kubeconfig. More than one → return a
    // `candidates` array so the caller can re-invoke with the choice.
    let clusterName = input.clusterName?.trim() || "";
    let resourceGroup = input.resourceGroup?.trim() || "";

    if (!clusterName || !resourceGroup) {
      const kcfg = await getKubeconfigForEnv(env.id).catch(() => null);
      if (kcfg && kcfg.ok) {
        try {
          const { readFile } = await import("node:fs/promises");
          const text = await readFile(kcfg.handle.path, "utf8");
          const parsed = parseAksClusterRef(text);
          if (parsed?.clusterName) clusterName = parsed.clusterName;
          if (parsed?.resourceGroup) resourceGroup = parsed.resourceGroup;
        } finally {
          await kcfg.handle.cleanup().catch(() => {});
        }
      }
    }

    if (!clusterName || !resourceGroup) {
      // Fall back to listing every AKS cluster in the connected subscription.
      const azTok0 = await getAzureAccessToken(cp.id);
      if (!azTok0.ok) {
        return { ok: false, error: `Azure token unavailable for cluster lookup: ${azTok0.error}` };
      }
      const cpRow = await prisma.cloudProvider.findFirst({
        where: { id: cp.id },
        select: { accountRef: true },
      });
      if (!cpRow?.accountRef) {
        return { ok: false, error: `Connected Azure provider has no subscription id stored.` };
      }
      const list = await listAksClusters(azTok0.accessToken, cpRow.accountRef);
      if (!list.ok) {
        return {
          ok: false,
          error: `Couldn't list AKS clusters in the connected subscription: ${list.error}`,
        };
      }
      if (list.clusters.length === 0) {
        return {
          ok: false,
          error: `No AKS clusters exist in the connected Azure subscription. Create one with the AKS wizard first.`,
        };
      }
      if (list.clusters.length === 1) {
        clusterName = list.clusters[0].name;
        resourceGroup = list.clusters[0].resourceGroup;
      } else {
        return {
          ok: true,
          output: {
            clusterName: "",
            resourceGroup: "",
            principalObjectId: "",
            principalType: "",
            note: `Multiple AKS clusters found — pick one and re-invoke grant_aks_access with clusterName + resourceGroup.`,
            candidates: list.clusters.map((c) => ({
              name: c.name,
              resourceGroup: c.resourceGroup,
              location: c.location,
            })),
          },
        };
      }
    }

    // Which principal? Priority order:
    //   1. Explicit input — the failure classifier's oid from the CI log,
    //      always the authoritative answer.
    //   2. The oid embedded in the env's KUBECONFIG token — whoever kubectl
    //      will actually authenticate as, which is what we ACTUALLY need
    //      the role granted for.
    //   3. Fall back to the freshly-minted Azure token (the OAuth caller).
    //      Only correct when 1+2 aren't available; may differ from (2) when
    //      the kubeconfig was written in an older session as a different
    //      user or the refresh token has been rotated.
    //
    // WHY THE KUBECONFIG-EMBEDDED TOKEN MATTERS (2026-07):
    // The first version of this tool defaulted to the freshly-minted OAuth
    // token's oid. When that oid differed from the one embedded in the
    // stored kubeconfig, we granted the wrong identity and the deploy kept
    // failing with the SAME 'does not have access' error — just naming the
    // OTHER user. This is the single most common failure mode we can fix
    // without user intervention.
    let principalObjectId = input.principalObjectId?.trim() || "";
    // Don't default the type — decide it from the kubeconfig token when
    // possible, since AKS AAD tokens can be minted for either a User
    // (idtyp=user) or a Service Principal (idtyp=app). Passing the wrong
    // type to ARM either 400s or silently creates an assignment that grants
    // nothing.
    let principalType: "User" | "ServicePrincipal" | "Group" | null =
      input.principalType ?? null;

    // Peek at the kubeconfig's embedded bearer token regardless of whether
    // the caller supplied an oid — it's authoritative for BOTH the oid AND
    // the type (idtyp claim). Uses:
    //   - Fills the oid when the caller didn't supply one.
    //   - Fills the type when the caller supplied an oid but no type AND
    //     the kubeconfig oid matches (same identity → same type).
    let kcOid: string | null = null;
    let kcType: "User" | "ServicePrincipal" | null = null;
    const kcfg2 = await getKubeconfigForEnv(env.id).catch(() => null);
    if (kcfg2 && kcfg2.ok) {
      try {
        const { readFile } = await import("node:fs/promises");
        const text = await readFile(kcfg2.handle.path, "utf8");
        const embedded = extractTokenFromKubeconfig(text);
        if (embedded) {
          const who = callerIdentityFromToken(embedded);
          if (who) {
            kcOid = who.oid;
            kcType = who.type;
          }
        }
      } finally {
        await kcfg2.handle.cleanup().catch(() => {});
      }
    }
    if (!principalObjectId && kcOid) {
      principalObjectId = kcOid;
      principalType = kcType;
    } else if (principalObjectId && !principalType && kcOid === principalObjectId) {
      // Caller-supplied oid matches the kubeconfig's embedded oid → same
      // identity, use its type.
      principalType = kcType;
    }

    if (!principalObjectId) {
      // Last fallback: whoever the connected Azure session mints as.
      const tok = await getAzureAccessToken(cp.id);
      if (!tok.ok) {
        return { ok: false, error: `Couldn't get Azure token to identify the caller: ${tok.error}` };
      }
      const who = callerIdentityFromToken(tok.accessToken);
      if (!who) {
        return {
          ok: false,
          error:
            "Couldn't decode a principal object id from either the kubeconfig or the current Azure session. Pass principalObjectId explicitly.",
        };
      }
      principalObjectId = who.oid;
      principalType = who.type;
    }

    // Type still unknown? Try both. ARM's role-assignment PUT rejects
    // mismatched principalType with `PrincipalNotFound` / `PrincipalTypeMismatch`,
    // so we can safely attempt one, then fall through to the other. Idempotent
    // for the correct one either way.
    let usedType: "User" | "ServicePrincipal" | "Group" = principalType ?? "ServicePrincipal";
    let grant = await grantAksRbacClusterAdmin(
      cp.id,
      principalObjectId,
      usedType,
      resourceGroup,
      clusterName,
    );
    if (
      !grant.ok &&
      principalType === null &&
      /PrincipalNotFound|PrincipalTypeMismatch|does not exist|not found/i.test(grant.error)
    ) {
      usedType = "User";
      grant = await grantAksRbacClusterAdmin(
        cp.id,
        principalObjectId,
        usedType,
        resourceGroup,
        clusterName,
      );
    }
    if (!grant.ok) return { ok: false, error: grant.error };

    return {
      ok: true,
      output: {
        clusterName,
        resourceGroup,
        principalObjectId,
        principalType: usedType,
        note:
          `Granted ${usedType} ${principalObjectId} "Azure Kubernetes Service RBAC Cluster Admin" on AKS ` +
          `cluster ${clusterName} (${resourceGroup}). ARM propagates role assignments in ~30-60s — a re-run of ` +
          `the failed CD workflow should succeed on the second attempt if it doesn't on the first.`,
      },
    };
  },
};
