import os
import logging

logger = logging.getLogger(__name__)


def get_gcp_config(gcp_env: dict | None = None) -> dict:
    """MCP server for GCP operations (projects, GKE, GCS, Cloud Run, VMs,
    monitoring…).

    Wraps `gcp-mcp-server` (community-maintained by startupmanch/gcp-mcp),
    spawned per-session via `npx`. Credentials come from the caller (`gcp_env`)
    or the process env; when neither has usable credentials we return `{}` and
    skip registration — same "no schemas, no token cost" convention.

    NOTE: this package is community-maintained and pre-1.0 in behaviour (the
    on-wire server reports v1.0.1 even though the npm dist is v1.4.0). Its main
    tool is `run-gcp-code`, which the LangGraph agent evaluates as JS/TS
    against the Google Cloud client libraries. Watch for a first-party GCP MCP
    server and swap when it lands.
    """
    env: dict[str, str] = {}
    if gcp_env:
        for k in (
            "GOOGLE_APPLICATION_CREDENTIALS",
            "GOOGLE_CLOUD_PROJECT",
            "GCLOUD_PROJECT",
            "CLOUDSDK_CORE_PROJECT",
        ):
            v = gcp_env.get(k)
            if v:
                env[k] = v

    # Fallback to process env. GOOGLE_APPLICATION_CREDENTIALS is a PATH to a
    # service-account JSON key; workload identity federation sets it too
    # (pointing at a token file GKE mounts into the pod). Either shape works.
    for k in (
        "GOOGLE_APPLICATION_CREDENTIALS",
        "GOOGLE_CLOUD_PROJECT",
        "GCLOUD_PROJECT",
        "CLOUDSDK_CORE_PROJECT",
        "CLOUDSDK_COMPUTE_REGION",
        "CLOUDSDK_COMPUTE_ZONE",
    ):
        if k not in env:
            v = os.getenv(k, "")
            if v:
                env[k] = v

    # ADC needs *some* credential source. On-GCE / on-GKE the metadata server
    # provides it (nothing to inject), but off-GCP a key file is required.
    creds_path = env.get("GOOGLE_APPLICATION_CREDENTIALS", "")
    has_key_file = bool(creds_path) and os.path.exists(creds_path)
    on_gce = os.path.exists("/etc/google_metadata_credential_configuration.json") or bool(
        os.getenv("GCE_METADATA_HOST")
    )
    if not (has_key_file or on_gce):
        logger.info(
            "MCP: GCP server skipped — no GOOGLE_APPLICATION_CREDENTIALS key file "
            "and no GCE metadata server detected"
        )
        return {}

    return {
        "gcp": {
            "command": "npx",
            "args": ["-y", "gcp-mcp-server"],
            "env": env,
            "transport": "stdio",
        }
    }
