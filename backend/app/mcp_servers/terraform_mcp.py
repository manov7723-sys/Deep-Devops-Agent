import os
import logging

logger = logging.getLogger(__name__)

def get_terraform_config(aws_env: dict) -> dict:
    if os.getenv("ENABLE_TERRAFORM_MCP", "false").lower() != "true":
        logger.info("MCP: Terraform server skipped — ENABLE_TERRAFORM_MCP not true")
        return {}

    return {
        "terraform": {
            "command": "docker",
            "args": ["run", "-i", "--rm", "hashicorp/terraform-mcp-server"],
            "env": {**aws_env},
            "transport": "stdio",
        }
    }