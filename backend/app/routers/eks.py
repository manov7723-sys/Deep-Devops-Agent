"""
EKS cluster connection — lets the user connect a running EKS cluster from the UI (runs
`aws eks update-kubeconfig`). Once connected, the agent's kubectl_action tool (and the
Kubernetes MCP server) can list/manage pods, nodes, deployments, etc.
"""
import os
import subprocess

import boto3
from fastapi import APIRouter
from pydantic import BaseModel

# Remembers the last connected cluster (kubeconfig is written to ~/.kube/config).
_state = {"cluster": "", "region": ""}


class EKSConnect(BaseModel):
    cluster_name: str
    region: str = "us-east-1"


class BlueprintCreate(BaseModel):
    resource: str = "eks"
    answers: dict


def _aws_creds() -> dict:
    """Resolve AWS creds from Vault, falling back to env."""
    try:
        from app.core.vault import get_aws_creds
        v = get_aws_creds()
        if v.get("aws_access_key_id") and v.get("aws_secret_access_key"):
            return {"aws_access_key_id": v["aws_access_key_id"],
                    "aws_secret_access_key": v["aws_secret_access_key"]}
    except Exception:
        pass
    if os.getenv("AWS_ACCESS_KEY_ID") and os.getenv("AWS_SECRET_ACCESS_KEY"):
        return {"aws_access_key_id": os.getenv("AWS_ACCESS_KEY_ID"),
                "aws_secret_access_key": os.getenv("AWS_SECRET_ACCESS_KEY")}
    return {}


def _kubeconfig_path() -> str:
    return os.getenv("KUBECONFIG") or os.path.expanduser("~/.kube/config")


def get_router() -> APIRouter:
    router = APIRouter()

    @router.get("/clusters")
    def list_clusters(region: str = "us-east-1"):
        """List the EKS clusters in a region (to populate the connect dropdown)."""
        creds = _aws_creds()
        if not creds:
            return {"clusters": [], "error": "No AWS credentials. Connect AWS first."}
        try:
            session = boto3.Session(region_name=region, **creds)
            names = session.client("eks").list_clusters().get("clusters", [])
            return {"clusters": names, "region": region}
        except Exception as e:  # noqa: BLE001
            return {"clusters": [], "error": str(e)}

    @router.post("/connect")
    def connect(body: EKSConnect):
        """Run `aws eks update-kubeconfig` so kubectl / the agent can reach the cluster."""
        creds = _aws_creds()
        env = {**os.environ, "AWS_DEFAULT_REGION": body.region, "AWS_REGION": body.region}
        for k in ("AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_SESSION_TOKEN"):
            if not env.get(k):
                env.pop(k, None)
        if creds:
            env["AWS_ACCESS_KEY_ID"] = creds["aws_access_key_id"]
            env["AWS_SECRET_ACCESS_KEY"] = creds["aws_secret_access_key"]
        try:
            r = subprocess.run(
                ["aws", "eks", "update-kubeconfig", "--name", body.cluster_name, "--region", body.region],
                env=env, capture_output=True, text=True, timeout=60,
            )
            if r.returncode != 0:
                return {"connected": False, "error": (r.stderr or r.stdout)[:300].strip()}
            _state.update(cluster=body.cluster_name, region=body.region)
            return {"connected": True, "cluster": body.cluster_name, "region": body.region}
        except FileNotFoundError:
            return {"connected": False, "error": "aws CLI not found on the server."}
        except Exception as e:  # noqa: BLE001
            return {"connected": False, "error": str(e)}

    @router.get("/status")
    def status():
        connected = bool(_state["cluster"]) and os.path.exists(_kubeconfig_path())
        return {"connected": connected, "cluster": _state["cluster"], "region": _state["region"]}

    @router.get("/form")
    def form(resource: str = "eks"):
        """Return a blueprint's questions so the UI can render a single-page form
        (deterministic — no LLM). Powers the one-page 'Create EKS' wizard."""
        from app.services import blueprint_engine as BP
        bp = BP.load(resource)
        if not bp:
            return {"resource": resource, "error": f"No blueprint for '{resource}'."}
        return {"resource": resource,
                "title": bp.get("title", resource),
                "questions": bp.get("questions", [])}

    @router.get("/job/{job_id}")
    def job_status(job_id: str):
        """Poll a background Terraform job's stage-wise status (init → plan → apply) for the UI."""
        from app.services import tf_async
        return tf_async.get_status(job_id)

    @router.post("/blueprint-create")
    async def blueprint_create(body: BlueprintCreate):
        """Create infra straight from a submitted form (no LLM in the loop). The answers
        object maps blueprint question keys → chosen values; the engine renders + pushes + applies."""
        import json
        from app import agent
        try:
            result = await agent.create_from_blueprint.ainvoke(
                {"resource": body.resource, "answers": body.answers})
            try:
                return json.loads(result)
            except (json.JSONDecodeError, TypeError):
                return {"success": True, "raw": result}
        except Exception as e:  # noqa: BLE001
            return {"success": False, "error": str(e)}

    return router
