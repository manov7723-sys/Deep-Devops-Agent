import os

from fastapi import APIRouter
from pydantic import BaseModel

from app.routers.config import _update_env_file


class S3Config(BaseModel):
    bucket: str
    region: str = "us-east-1"


def get_router() -> APIRouter:
    router = APIRouter()

    @router.get("/s3-config")
    def get_s3_config():
        """Current Terraform remote-state (S3) config used by apply/destroy."""
        bucket = os.getenv("TF_STATE_BUCKET", "")
        return {
            "configured": bool(bucket),
            "bucket": bucket,
            "region": os.getenv("TF_STATE_REGION", "us-east-1"),
        }

    @router.post("/s3-config")
    def save_s3_config(cfg: S3Config):
        """Persist the S3 bucket used for Terraform remote state (TF_STATE_BUCKET / TF_STATE_REGION)."""
        bucket = (cfg.bucket or "").strip()
        if not bucket:
            return {"status": "error", "detail": "bucket is required"}
        region = (cfg.region or "").strip() or "us-east-1"
        env_path = os.path.join(os.path.dirname(__file__), "../.env")
        for key, value in (("TF_STATE_BUCKET", bucket), ("TF_STATE_REGION", region)):
            os.environ[key] = value
            _update_env_file(env_path, key, value)
        return {"status": "saved", "bucket": bucket, "region": region}

    return router
