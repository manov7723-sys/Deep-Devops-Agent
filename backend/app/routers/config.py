import os
import uuid
from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional


def _get_or_create_user_external_id() -> str:
    """Return the user's persistent ExternalId, creating one if it doesn't exist yet."""
    eid = os.getenv("USER_EXTERNAL_ID")
    if eid:
        return eid
    # Generate a new UUID and persist it
    eid = str(uuid.uuid4())
    os.environ["USER_EXTERNAL_ID"] = eid
    env_path = os.path.join(os.path.dirname(__file__), "../../.env")
    _append_env_file(env_path, "USER_EXTERNAL_ID", eid)
    return eid


def _append_env_file(path: str, key: str, value: str):
    """Append a key=value line to the .env file (or update if it already exists)."""
    try:
        with open(path, "r") as f:
            lines = f.readlines()
        updated = False
        for i, line in enumerate(lines):
            if line.startswith(f"{key}="):
                lines[i] = f"{key}={value}\n"
                updated = True
                break
        if not updated:
            lines.append(f"{key}={value}\n")
        with open(path, "w") as f:
            f.writelines(lines)
    except Exception:
        pass


class ConfigUpdate(BaseModel):
    groq_api_key: Optional[str] = None
    openai_api_key: Optional[str] = None
    aws_account_id: Optional[str] = None
    aws_region: Optional[str] = None
    github_owner: Optional[str] = None
    github_repo: Optional[str] = None
    github_branch: Optional[str] = None


def get_router() -> APIRouter:
    router = APIRouter()

    @router.get("/status")
    def config_status():
        # Ensure the user always has a persistent ExternalId
        user_external_id = _get_or_create_user_external_id()
        return {
            "groq_configured":   bool(os.getenv("GROQ_API_KEY")),
            "openai_configured": bool(os.getenv("OPENAI_API_KEY")),
            "aws_configured":    bool(os.getenv("AWS_ACCESS_KEY_ID")),
            "aws_account_id":    os.getenv("YOUR_AWS_ACCOUNT_ID", ""),
            "aws_region":        os.getenv("AWS_DEFAULT_REGION", "us-east-1"),
            "user_external_id":  user_external_id,
            "github_app_configured": bool(os.getenv("GITHUB_TOKEN")),
            "github_owner":      os.getenv("GITHUB_OWNER", ""),
            "github_repo":       os.getenv("GITHUB_REPO", ""),
            "github_branch":     os.getenv("GITHUB_BRANCH", ""),
            "mcp_servers": {
                "github": bool(os.getenv("GITHUB_TOKEN")),
                "terraform": bool(os.getenv("AWS_ACCESS_KEY_ID")),
                "kubernetes": bool(os.getenv("KUBECONFIG")) or os.path.exists(os.path.expanduser("~/.kube/config")),
                "prometheus": bool(os.getenv("PROMETHEUS_URL")),
                "grafana": bool(os.getenv("GRAFANA_URL")),
            }
        }

    @router.post("/update")
    def config_update(config: ConfigUpdate):
        env_path = os.path.join(os.path.dirname(__file__), "../../.env")
        mapping = {
            "GROQ_API_KEY":          config.groq_api_key,
            "OPENAI_API_KEY":        config.openai_api_key,
            "YOUR_AWS_ACCOUNT_ID":   config.aws_account_id,
            "AWS_DEFAULT_REGION":    config.aws_region,
            "GITHUB_OWNER":          config.github_owner,
            "GITHUB_REPO":           config.github_repo,
            "GITHUB_BRANCH":         config.github_branch,
        }
        for key, value in mapping.items():
            if value:
                os.environ[key] = value
                _update_env_file(env_path, key, value)
        return {"status": "saved"}

    return router


def _update_env_file(path: str, key: str, value: str):
    try:
        with open(path, "r") as f:
            lines = f.readlines()
        updated = False
        for i, line in enumerate(lines):
            if line.startswith(f"{key}="):
                lines[i] = f"{key}={value}\n"
                updated = True
                break
        if not updated:
            lines.append(f"{key}={value}\n")
        with open(path, "w") as f:
            f.writelines(lines)
    except Exception:
        pass