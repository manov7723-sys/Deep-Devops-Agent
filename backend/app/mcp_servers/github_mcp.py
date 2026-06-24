import os
import logging

logger = logging.getLogger(__name__)

def get_github_config() -> dict:
    token = os.getenv("GITHUB_TOKEN", "")
    if not token:
        logger.info("MCP: GitHub server skipped — GITHUB_TOKEN not set")
        return {}

    return {
        "github": {
            "command": "npx",
            "args": ["-y", "@modelcontextprotocol/server-github"],
            "env": {"GITHUB_PERSONAL_ACCESS_TOKEN": token},
            "transport": "stdio",
        }
    }