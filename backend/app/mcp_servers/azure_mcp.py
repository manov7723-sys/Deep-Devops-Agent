import os
import logging

logger = logging.getLogger(__name__)


def get_azure_config(az_env: dict | None = None) -> dict:
    """MCP server for Azure operations (subscriptions, resource groups, AKS,
    ACR, storage, VMs, monitoring…).

    Wraps Microsoft's official `@azure/mcp` server, spawned per-session via
    `npx`. Credentials come from either the caller (`az_env`, e.g. an already-
    resolved service principal) or the process env. When neither carries usable
    credentials we return `{}` and skip registration — same "no schemas, no
    token cost" convention as the other files in this folder.

    NOTE: `@azure/mcp` is currently on a 3.x BETA release line, but it's
    maintained by the Azure SDK team (npm maintainers: azure-sdk, microsoft1es,
    microsoft-oss-releases). Fine for Phase 0; watch for the GA release.
    """
    env: dict[str, str] = {}
    if az_env:
        for k in (
            "AZURE_CLIENT_ID",
            "AZURE_CLIENT_SECRET",
            "AZURE_TENANT_ID",
            "AZURE_SUBSCRIPTION_ID",
        ):
            v = az_env.get(k)
            if v:
                env[k] = v

    # Fallback to process env — covers workload identity, managed identity, and
    # any long-lived service principal already exported on the pod. We forward
    # ARM_* too because Terraform-flavoured deployments often set only those.
    for k in (
        "AZURE_CLIENT_ID",
        "AZURE_CLIENT_SECRET",
        "AZURE_TENANT_ID",
        "AZURE_SUBSCRIPTION_ID",
        "AZURE_FEDERATED_TOKEN_FILE",  # workload identity
        "AZURE_AUTHORITY_HOST",
        "ARM_CLIENT_ID",
        "ARM_CLIENT_SECRET",
        "ARM_TENANT_ID",
        "ARM_SUBSCRIPTION_ID",
    ):
        if k not in env:
            v = os.getenv(k, "")
            if v:
                env[k] = v

    # DefaultAzureCredential tries env → managed identity → cli in order, so
    # having a subscription id at minimum is enough for it to reach live
    # resources when running on an Azure VM/AKS pod. Off-Azure it needs an SP.
    has_sp = ("AZURE_CLIENT_ID" in env and "AZURE_CLIENT_SECRET" in env and "AZURE_TENANT_ID" in env) or (
        "ARM_CLIENT_ID" in env and "ARM_CLIENT_SECRET" in env and "ARM_TENANT_ID" in env
    )
    has_wi = "AZURE_FEDERATED_TOKEN_FILE" in env and "AZURE_CLIENT_ID" in env
    if not (has_sp or has_wi):
        logger.info(
            "MCP: Azure server skipped — no Service Principal or Workload Identity in env"
        )
        return {}

    # If only ARM_* was set (Terraform habit), mirror to the AZURE_* names the
    # Azure SDK expects — cheaper than teaching the MCP server two conventions.
    if "AZURE_CLIENT_ID" not in env and "ARM_CLIENT_ID" in env:
        env["AZURE_CLIENT_ID"] = env["ARM_CLIENT_ID"]
        env["AZURE_CLIENT_SECRET"] = env.get("ARM_CLIENT_SECRET", "")
        env["AZURE_TENANT_ID"] = env.get("ARM_TENANT_ID", "")
    if "AZURE_SUBSCRIPTION_ID" not in env and "ARM_SUBSCRIPTION_ID" in env:
        env["AZURE_SUBSCRIPTION_ID"] = env["ARM_SUBSCRIPTION_ID"]

    return {
        "azure": {
            "command": "npx",
            "args": ["-y", "@azure/mcp@latest", "server", "start"],
            "env": env,
            "transport": "stdio",
        }
    }
