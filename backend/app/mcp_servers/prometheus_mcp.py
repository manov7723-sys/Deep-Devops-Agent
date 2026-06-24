import os

def get_prometheus_config() -> dict:
    url = os.getenv("PROMETHEUS_URL", "")
    if not url:
        return {}

    return {
        "prometheus": {
            "command": "uvx",
            "args": ["prometheus-mcp-server"],
            "env": {"PROMETHEUS_URL": url},
            "transport": "stdio",
        }
    }