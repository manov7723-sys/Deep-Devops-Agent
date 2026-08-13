/**
 * Built-in MCP server definitions for the clouds that ship WITH the app.
 *
 * WHY THESE LIVE IN CODE: the McpConnector table is for servers a user adds
 * through Admin → MCP. AWS/Azure/GCP are part of the product, so requiring a
 * row meant a manual setup step in every environment — and forgetting it
 * produced "no MCP connector registered" in production while the identical
 * code worked on a laptop. The backend's Python agent already defines its
 * servers in code (backend/app/mcp_servers/*.py); this is the Next.js twin.
 *
 * WHY CREDENTIALS ARE RESOLVED, NOT ASKED FOR: the user already connected
 * their cloud on the Cloud Providers page, and the app stores those
 * credentials encrypted. Asking again — in a "register your MCP server" form —
 * would be asking for something we already hold. So each resolver below reads
 * the project's existing CloudProvider row.
 *
 * A matching McpConnector row still wins when present, so an operator can pin
 * a version, point at a hosted server, or supply different credentials without
 * touching code. See the resolvers in aws-via-mcp / azure-via-mcp / gcp-via-mcp.
 */
import { prisma } from "@/lib/db/prisma";
import { getDecryptedAzureCreds } from "@/lib/cloud/azure";
import { getGcpAccessToken } from "@/lib/cloud/gcp";

export type BuiltinMcpConfig = {
  name: string;
  transport: "stdio";
  command: string;
  args: string[];
  credentials: Record<string, string>;
};

export type BuiltinResult =
  | { ok: true; config: BuiltinMcpConfig }
  | { ok: false; reason: "no_provider" | "no_credentials"; message: string };

/** The project's newest connected provider of a given kind, if any. */
async function providerFor(projectId: string, kind: "aws" | "azure" | "gcp") {
  return prisma.cloudProvider.findFirst({
    where: { projectId, kind },
    select: { id: true, accountRef: true, region: true },
    orderBy: { createdAt: "desc" },
  });
}

/**
 * AWS needs no credential resolution: the stdio subprocess inherits the app's
 * environment, so IRSA, an instance profile, or AWS_* env vars all work with
 * nothing configured. That is what makes a fresh pod work untouched.
 */
export function awsBuiltin(): BuiltinMcpConfig {
  return {
    name: "aws-labs-cli",
    transport: "stdio",
    command: "uvx",
    args: ["awslabs.aws-api-mcp-server@latest"],
    credentials: {},
  };
}

/**
 * Azure: feed the Service-Principal the user already connected. @azure/mcp
 * uses DefaultAzureCredential, which reads these env var names directly.
 */
export async function azureBuiltin(projectId: string): Promise<BuiltinResult> {
  const cp = await providerFor(projectId, "azure");
  if (!cp) {
    return {
      ok: false,
      reason: "no_provider",
      message: "No Azure account is connected to this project. Connect one on the Cloud providers page.",
    };
  }
  const creds = await getDecryptedAzureCreds(cp.id);
  if (!creds.ok) {
    return {
      ok: false,
      reason: "no_credentials",
      message: `The connected Azure account has no usable Service Principal (${creds.error}). Reconnect it on the Cloud providers page.`,
    };
  }
  return {
    ok: true,
    config: {
      name: "azure-mcp",
      transport: "stdio",
      command: "npx",
      args: ["-y", "@azure/mcp@latest", "server", "start"],
      credentials: {
        AZURE_CLIENT_ID: creds.clientId,
        AZURE_CLIENT_SECRET: creds.clientSecret,
        AZURE_TENANT_ID: creds.tenantId,
        AZURE_SUBSCRIPTION_ID: creds.subscriptionId || (cp.accountRef ?? ""),
      },
    },
  };
}

/**
 * GCP: the stored provider is OAuth-based, so we mint a short-lived access
 * token rather than handing over a key file. The Google client libraries
 * accept GOOGLE_OAUTH_ACCESS_TOKEN for exactly this case, which avoids
 * writing a service-account JSON to disk inside the container.
 */
export async function gcpBuiltin(projectId: string): Promise<BuiltinResult> {
  const cp = await providerFor(projectId, "gcp");
  if (!cp) {
    return {
      ok: false,
      reason: "no_provider",
      message: "No GCP account is connected to this project. Connect one on the Cloud providers page.",
    };
  }
  const tok = await getGcpAccessToken(cp.id);
  if (!tok.ok) {
    return {
      ok: false,
      reason: "no_credentials",
      message: `Could not mint a GCP access token (${tok.error}). Reconnect the account on the Cloud providers page.`,
    };
  }
  return {
    ok: true,
    config: {
      name: "gcp-mcp",
      transport: "stdio",
      command: "npx",
      args: ["-y", "gcp-mcp-server"],
      credentials: {
        GOOGLE_OAUTH_ACCESS_TOKEN: tok.accessToken,
        ...(cp.accountRef ? { GOOGLE_CLOUD_PROJECT: cp.accountRef, CLOUDSDK_CORE_PROJECT: cp.accountRef } : {}),
      },
    },
  };
}
