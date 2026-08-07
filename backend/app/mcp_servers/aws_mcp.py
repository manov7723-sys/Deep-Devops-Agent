import os
import logging

logger = logging.getLogger(__name__)


def get_aws_config(aws_env: dict | None = None) -> dict:
    """MCP server for AWS API calls (STS, EC2, RDS, EKS, ECR, S3, CloudWatch, cost…).

    Wraps AWS Labs' `awslabs.aws-api-mcp-server`, spawned per-session via `uvx`.
    Requires credentials on the process — either passed in via `aws_env` (the
    same map the rest of agent.py already builds from `assume_role_creds`), or
    inherited from the environment (IRSA / instance profile / long-lived keys).
    When neither is present the server would start and every call would fail
    with `Unable to locate credentials`, so we return `{}` and skip the
    registration — same "no schemas, no token cost" convention as the other
    files in this folder.

    The upstream server prints a deprecation notice pointing at a newer
    `aws-mcp-server`. Fine for now; swap when it stabilises.
    """
    env: dict[str, str] = {}
    if aws_env:
        for k in (
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_SESSION_TOKEN",
            "AWS_REGION",
            "AWS_DEFAULT_REGION",
        ):
            v = aws_env.get(k)
            if v:
                env[k] = v

    # Fallback to the process env — covers IRSA (AWS_ROLE_ARN +
    # AWS_WEB_IDENTITY_TOKEN_FILE, honoured by botocore automatically), EC2
    # instance profile (nothing to inject), and long-lived keys set on the pod.
    for k in (
        "AWS_ACCESS_KEY_ID",
        "AWS_SECRET_ACCESS_KEY",
        "AWS_SESSION_TOKEN",
        "AWS_REGION",
        "AWS_DEFAULT_REGION",
        "AWS_ROLE_ARN",
        "AWS_WEB_IDENTITY_TOKEN_FILE",
        "AWS_PROFILE",
    ):
        if k not in env:
            v = os.getenv(k, "")
            if v:
                env[k] = v

    has_keys = "AWS_ACCESS_KEY_ID" in env and "AWS_SECRET_ACCESS_KEY" in env
    has_irsa = "AWS_WEB_IDENTITY_TOKEN_FILE" in env and "AWS_ROLE_ARN" in env
    has_profile = "AWS_PROFILE" in env
    if not (has_keys or has_irsa or has_profile):
        logger.info(
            "MCP: AWS server skipped — no AWS credentials in aws_env or process env"
        )
        return {}

    env.setdefault("AWS_REGION", "us-east-1")
    env.setdefault("AWS_DEFAULT_REGION", env["AWS_REGION"])

    return {
        "aws": {
            "command": "uvx",
            "args": ["awslabs.aws-api-mcp-server@latest"],
            "env": env,
            "transport": "stdio",
        }
    }
