import os
import boto3
from fastapi import APIRouter
from pydantic import BaseModel
from typing import Optional

from app.routers.config import _get_or_create_user_external_id


class ConnectAWSRequest(BaseModel):
    role_arn: str
    external_id: str
    region: Optional[str] = "us-east-1"


def get_router() -> APIRouter:
    router = APIRouter()

    @router.get("/external-id")
    def get_external_id():
        """Return the user's persistent ExternalId and a sample trust policy."""
        external_id = _get_or_create_user_external_id()
        account_id = os.getenv("YOUR_AWS_ACCOUNT_ID", "YOUR_ACCOUNT_ID")
        trust_policy = {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Effect": "Allow",
                    "Principal": {"AWS": f"arn:aws:iam::{account_id}:root"},
                    "Action": "sts:AssumeRole",
                    "Condition": {"StringEquals": {"sts:ExternalId": external_id}}
                }
            ]
        }
        return {
            "external_id": external_id,
            "account_id": account_id,
            "trust_policy": trust_policy,
        }

    @router.post("/generate-external-id")
    def generate_external_id():
        """Backward-compatible: returns the same persistent ExternalId."""
        external_id = _get_or_create_user_external_id()
        account_id = os.getenv("YOUR_AWS_ACCOUNT_ID", "YOUR_ACCOUNT_ID")
        trust_policy = {
            "Version": "2012-10-17",
            "Statement": [
                {
                    "Effect": "Allow",
                    "Principal": {"AWS": f"arn:aws:iam::{account_id}:root"},
                    "Action": "sts:AssumeRole",
                    "Condition": {"StringEquals": {"sts:ExternalId": external_id}}
                }
            ]
        }
        return {"external_id": external_id, "account_id": account_id, "trust_policy": trust_policy}

    @router.post("/connect-aws")
    def connect_aws(req: ConnectAWSRequest):
        try:
            region = req.region or os.getenv("AWS_DEFAULT_REGION", "us-east-1")
            sts = boto3.client("sts", region_name=region)
            response = sts.assume_role(
                RoleArn=req.role_arn,
                RoleSessionName="devops-agent-session",
                ExternalId=req.external_id,
            )
            creds = response["Credentials"]

            # Set in environment so agent picks them up
            os.environ["AWS_ACCESS_KEY_ID"] = creds["AccessKeyId"]
            os.environ["AWS_SECRET_ACCESS_KEY"] = creds["SecretAccessKey"]
            os.environ["AWS_SESSION_TOKEN"] = creds["SessionToken"]
            os.environ["AWS_DEFAULT_REGION"] = region

            return {
                "status": "connected",
                "account": req.role_arn.split(":")[4],
                "region": region,
            }
        except Exception as e:
            return {"status": "error", "message": str(e)}

    return router