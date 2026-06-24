import os
import logging
import hvac
from fastapi import APIRouter
from pydantic import BaseModel
from app.core.vault import save_aws_creds_to_vault, get_aws_creds

logger = logging.getLogger(__name__)


class VaultConfig(BaseModel):
    vault_addr: str
    vault_token: str


class AWSCredsPayload(BaseModel):
    aws_access_key_id: str
    aws_secret_access_key: str
    region: str = "us-east-1"


def get_router() -> APIRouter:
    router = APIRouter()

    @router.get("/status")
    def vault_status():
        addr  = os.getenv("VAULT_ADDR", "").strip()
        token = os.getenv("VAULT_TOKEN", "").strip()
        if not addr or not token:
            return {"connected": False, "message": "Vault not configured"}
        try:
            client = hvac.Client(url=addr, token=token)
            if client.is_authenticated():
                return {"connected": True, "addr": addr}
            return {"connected": False, "message": "Invalid or expired token"}
        except Exception as e:
            return {"connected": False, "message": str(e)}

    @router.post("/save")
    def save_vault_config(config: VaultConfig):
        """Save Vault connection config (addr + token) to .env."""
        addr  = config.vault_addr.strip()
        token = config.vault_token.strip()
        if not addr or not token:
            return {"status": "error", "message": "vault_addr and vault_token are required"}
        try:
            client = hvac.Client(url=addr, token=token)
            if not client.is_authenticated():
                return {"status": "error", "message": "Invalid or expired Vault token"}

            os.environ["VAULT_ADDR"]  = addr
            os.environ["VAULT_TOKEN"] = token

            env_path = _resolve_env_path()
            _update_env_file(env_path, "VAULT_ADDR",  addr)
            _update_env_file(env_path, "VAULT_TOKEN", token)

            logger.info(f"✅ Vault config saved (addr={addr})")
            return {"status": "saved", "addr": addr}
        except Exception as e:
            logger.error(f"Failed to save Vault config: {e}", exc_info=True)
            return {"status": "error", "message": str(e)}

    @router.post("/save-aws")
    def save_aws_creds(payload: AWSCredsPayload):
        """
        Store AWS access key + secret into Vault.
        The agent will always fetch from here — never from .env.
        """
        try:
            save_aws_creds_to_vault(
                access_key=payload.aws_access_key_id,
                secret_key=payload.aws_secret_access_key,
                region=payload.region,
            )
            return {"status": "saved", "message": "AWS credentials stored in Vault"}
        except Exception as e:
            logger.error(f"Failed to save AWS creds to Vault: {e}", exc_info=True)
            return {"status": "error", "message": str(e)}

    @router.get("/get-aws")
    def get_aws():
        """
        Verify the agent can read AWS creds from Vault.
        Returns the key ID only (never returns the secret).
        """
        try:
            creds = get_aws_creds()
            return {
                "status": "ok",
                "aws_access_key_id": creds["aws_access_key_id"],
                "region": creds["region"],
                "secret_present": bool(creds["aws_secret_access_key"]),
            }
        except Exception as e:
            return {"status": "error", "message": str(e)}

    return router


# ── Helpers ────────────────────────────────────────────────────────────────────

def _resolve_env_path() -> str:
    explicit = os.getenv("VAULT_ENV_PATH", "")
    if explicit:
        return explicit
    here = os.path.dirname(os.path.abspath(__file__))
    return os.path.join(here, "..", ".env")


def _update_env_file(path: str, key: str, value: str):
    try:
        abs_path = os.path.abspath(path)
        lines = open(abs_path).readlines() if os.path.exists(abs_path) else []
        updated = False
        for i, line in enumerate(lines):
            if line.startswith(f"{key}="):
                lines[i] = f"{key}={value}\n"
                updated = True
                break
        if not updated:
            lines.append(f"{key}={value}\n")
        with open(abs_path, "w") as f:
            f.writelines(lines)
    except Exception as e:
        logger.warning(f"Could not update .env at {path}: {e}")