import os
import logging
import hvac

logger = logging.getLogger(__name__)


def _get_client() -> hvac.Client:
    addr = os.getenv("VAULT_ADDR", "").strip()
    token = os.getenv("VAULT_TOKEN", "").strip()

    if not addr or not token:
        raise RuntimeError("VAULT_ADDR or VAULT_TOKEN is not set")

    return hvac.Client(url=addr, token=token)


def get_aws_creds() -> dict:
    """
    Called by the agent whenever it needs AWS credentials.
    Always fetches fresh from Vault — never relies on env vars or cache.
    Returns: { aws_access_key_id, aws_secret_access_key, region }
    """
    mount_point = os.getenv("VAULT_MOUNT", "secret")
    secret_path = os.getenv("VAULT_SECRET_PATH", "aws")

    client = _get_client()

    if not client.is_authenticated():
        raise RuntimeError("Vault token is invalid or expired")

    try:
        secret = client.secrets.kv.v2.read_secret_version(
            path=secret_path,
            mount_point=mount_point,
            raise_on_deleted_version=True,
        )

        data = secret["data"]["data"]

    except Exception as e:
        raise RuntimeError(
            f"Failed to read secret '{mount_point}/{secret_path}' from Vault: {e}"
        )

    if not data:
        raise RuntimeError(
            f"Secret '{mount_point}/{secret_path}' is empty or deleted"
        )

    return {
        "aws_access_key_id": data.get("aws_access_key_id", ""),
        "aws_secret_access_key": data.get("aws_secret_access_key", ""),
        "region": data.get("region", "us-east-1"),
    }


def save_aws_creds_to_vault(
    access_key: str,
    secret_key: str,
    region: str = "us-east-1",
) -> None:
    """
    Save (or update) AWS creds in Vault.
    Called from the /vault/save API endpoint.
    """

    mount_point = os.getenv("VAULT_MOUNT", "secret")
    secret_path = os.getenv("VAULT_SECRET_PATH", "aws")

    client = _get_client()

    print("========== VAULT DEBUG ==========")
    print("VAULT_ADDR =", os.getenv("VAULT_ADDR"))
    print("VAULT_TOKEN EXISTS =", bool(os.getenv("VAULT_TOKEN")))
    print("MOUNT_POINT =", mount_point)
    print("SECRET_PATH =", secret_path)
    print("AUTHENTICATED =", client.is_authenticated())
    print("=================================")

    if not client.is_authenticated():
        raise RuntimeError("Vault token is invalid or expired")

    try:
        client.secrets.kv.v2.create_or_update_secret(
            path=secret_path,
            secret={
                "aws_access_key_id": access_key,
                "aws_secret_access_key": secret_key,
                "region": region,
            },
            mount_point=mount_point,
        )

        logger.info(
            f"✅ AWS credentials saved to Vault at {mount_point}/{secret_path}"
        )

    except Exception as e:
        import traceback

        traceback.print_exc()
        print("VAULT ERROR:", repr(e))
        raise



async def load_aws_creds_from_vault():
    """
    Called once at startup — loads creds from Vault into env vars
    so existing boto3 code that reads env vars keeps working.
    """

    vault_addr = os.getenv("VAULT_ADDR", "").strip()
    vault_token = os.getenv("VAULT_TOKEN", "").strip()

    if not vault_addr or not vault_token:
        logger.info("Vault not configured, skipping credential load.")
        return

    try:
        creds = get_aws_creds()

        os.environ["AWS_ACCESS_KEY_ID"] = creds["aws_access_key_id"]
        os.environ["AWS_SECRET_ACCESS_KEY"] = creds["aws_secret_access_key"]
        os.environ["AWS_DEFAULT_REGION"] = creds["region"]

        logger.info("✅ AWS credentials loaded from Vault into environment.")

    except Exception as e:
        logger.warning(f"⚠️ Could not load Vault credentials: {e}")