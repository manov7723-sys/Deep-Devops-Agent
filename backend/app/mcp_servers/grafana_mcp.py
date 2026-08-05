import os

def get_grafana_config() -> dict:
    url   = os.getenv("GRAFANA_URL", "")
    token = os.getenv("GRAFANA_SERVICE_ACCOUNT_TOKEN", "")
    if not url or not token:
        return {}

    return {
        "grafana": {
            "command": "uvx",
            "args": ["mcp-grafana"],
            "env": {
                "GRAFANA_URL": url,
                "GRAFANA_SERVICE_ACCOUNT_TOKEN": token,
            },
            "transport": "stdio",
        }
    }