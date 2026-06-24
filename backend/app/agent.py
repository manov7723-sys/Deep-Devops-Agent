"""
DevOps Agent — LangGraph + Groq + MCP Servers + APScheduler
Natural language → AWS actions via MCP (Model Context Protocol)
"""

from __future__ import annotations

import os
import re
import json
import uuid
import asyncio
import logging
import subprocess
import tempfile
from typing import AsyncGenerator, TypedDict, Annotated, List, Optional

import operator

import httpx
from langchain_groq import ChatGroq
from langchain_core.messages import HumanMessage, AIMessage, SystemMessage, ToolMessage
from langchain_core.tools import tool
from langchain_mcp_adapters.client import MultiServerMCPClient
from langgraph.graph import StateGraph, END
from langgraph.prebuilt import ToolNode

from app.scheduler import TaskScheduler
from app.aws_connector import AWSConnector

logger = logging.getLogger(__name__)

# ── Shared instances ───────────────────────────────────────────────────────────
_scheduler: TaskScheduler = None
_aws: AWSConnector = None


def _resolve_aws_creds(access_key: str = "", secret_key: str = "", region: str = "") -> dict:
    """
    Resolve AWS credentials for terraform.

    Credentials are pulled from Vault server-side so the LLM never has to carry
    real secrets (and can't break things by inventing placeholder keys like
    AKIAIOSFODNN7EXAMPLE). The values the model passes are used only as a
    fallback when Vault is unavailable.
    """
    try:
        from app.core.vault import get_aws_creds
        vault = get_aws_creds()
        if vault.get("aws_access_key_id") and vault.get("aws_secret_access_key"):
            return {
                "aws_access_key_id":     vault["aws_access_key_id"],
                "aws_secret_access_key": vault["aws_secret_access_key"],
                # user-picked region (from the UI) wins; otherwise use Vault's
                "region":                region or vault.get("region", "us-east-1"),
            }
        logger.warning("Vault returned empty AWS creds; falling back to passed values")
    except Exception as e:
        logger.warning(f"Vault credential lookup failed, using passed creds: {e}")

    return {
        "aws_access_key_id":     access_key,
        "aws_secret_access_key": secret_key,
        "region":                region or "us-east-1",
    }


def init_dependencies(scheduler: TaskScheduler, aws: AWSConnector):
    global _scheduler, _aws
    _scheduler = scheduler
    _aws = aws


# ── MCP Server Configuration ───────────────────────────────────────────────────
# MCP servers in use: github, terraform, kubernetes, prometheus, grafana.
# The cloud-provider MCP servers (aws-core / gcp / azure) were removed — AWS infra
# is provisioned through Terraform using the access key + secret resolved from Vault.
from app.mcp_servers.github_mcp import get_github_config
from app.mcp_servers.terraform_mcp import get_terraform_config
from app.mcp_servers.prometheus_mcp import get_prometheus_config
from app.mcp_servers.grafana_mcp import get_grafana_config
from app.mcp_servers.kubernetes_mcp import get_kubernetes_config

def _build_mcp_config() -> dict:
    # Terraform MCP authenticates to AWS from these env vars (access key + secret).
    aws_env = {
        "AWS_ACCESS_KEY_ID":     os.getenv("AWS_ACCESS_KEY_ID", ""),
        "AWS_SECRET_ACCESS_KEY": os.getenv("AWS_SECRET_ACCESS_KEY", ""),
        "AWS_DEFAULT_REGION":    os.getenv("AWS_DEFAULT_REGION", "us-east-1"),
    }

    return {
        **get_github_config(),
        **get_terraform_config(aws_env),
        **get_prometheus_config(),
        **get_grafana_config(),
        **get_kubernetes_config(),
    }

# ── Terraform apply helper ─────────────────────────────────────────────────────

def _run_terraform_apply(tf_content: str, creds: dict, instance_id: str = "") -> dict:
    import re

    result = {"success": False, "output": "", "instance_id": "", "public_ip": "", "resource_ids": []}

    aws_env = dict(os.environ)
    aws_env["AWS_ACCESS_KEY_ID"]     = creds["aws_access_key_id"]
    aws_env["AWS_SECRET_ACCESS_KEY"] = creds["aws_secret_access_key"]
    aws_env["AWS_DEFAULT_REGION"]    = creds["region"]
    if creds.get("aws_session_token"):
        aws_env["AWS_SESSION_TOKEN"] = creds["aws_session_token"]

    # ── Inject S3 remote backend if configured ────────────────────────────────
    s3_bucket = os.getenv("TF_STATE_BUCKET", "")
    s3_region = os.getenv("TF_STATE_REGION", creds.get("region", "us-east-1"))
    if s3_bucket and instance_id:
        backend_snippet = (
            '  backend "s3" {\n'
            f'    bucket = "{s3_bucket}"\n'
            f'    key    = "ec2/{instance_id}/terraform.tfstate"\n'
            f'    region = "{s3_region}"\n'
            '  }\n'
        )
        if 'terraform {' in tf_content:
            # Inject inside existing terraform {} block — avoids duplicate block error
            tf_content = tf_content.replace('terraform {', 'terraform {\n' + backend_snippet, 1)
        else:
            # No terraform block exists yet — prepend a fresh one
            tf_content = 'terraform {\n' + backend_snippet + '}\n\n' + tf_content

    with tempfile.TemporaryDirectory() as tmpdir:
        tf_file = os.path.join(tmpdir, "main.tf")
        with open(tf_file, "w") as f:
            f.write(tf_content)

        full_output = []

        try:
            init = subprocess.run(
                ["terraform", "init", "-no-color"],
                cwd=tmpdir, env=aws_env,
                capture_output=True, text=True, timeout=120,
            )
            full_output.append("=== terraform init ===")
            full_output.append(init.stdout)
            if init.returncode != 0:
                full_output.append(init.stderr)
                result["output"] = "\n".join(full_output)
                return result
        except FileNotFoundError:
            result["output"] = (
                "❌ terraform binary not found. "
                "Install Terraform: https://developer.hashicorp.com/terraform/install"
            )
            return result
        except subprocess.TimeoutExpired:
            result["output"] = "❌ terraform init timed out after 120s"
            return result

        try:
            apply = subprocess.run(
                ["terraform", "apply", "-auto-approve", "-no-color"],
                cwd=tmpdir, env=aws_env,
                capture_output=True, text=True, timeout=600,
            )
            full_output.append("=== terraform apply ===")
            full_output.append(apply.stdout)
            if apply.stderr:
                full_output.append(apply.stderr)

            combined = "\n".join(full_output)
            result["output"] = combined

            if apply.returncode == 0:
                result["success"] = True
                ids = re.findall(r'(i-[0-9a-f]{8,17})', combined)
                result["resource_ids"] = list(set(ids))
                result["instance_id"]  = result["resource_ids"][0] if result["resource_ids"] else ""
                ip = re.search(r'public_ip\s*=\s*"?([\d.]+)"?', combined)
                result["public_ip"] = ip.group(1) if ip else ""
        except subprocess.TimeoutExpired:
            result["output"] = "❌ terraform apply timed out after 600s"
        except Exception as exc:
            result["output"] = f"❌ terraform apply error: {exc}"

    return result


# ── Terraform destroy helper ───────────────────────────────────────────────────

def _run_terraform_destroy(instance_id: str, creds: dict) -> dict:
    result = {"success": False, "output": ""}

    s3_bucket = os.getenv("TF_STATE_BUCKET", "")
    s3_region = os.getenv("TF_STATE_REGION", creds.get("region", "us-east-1"))

    if not s3_bucket:
        result["output"] = (
            "❌ No S3 state bucket configured. "
            "Please set your Terraform state bucket in the sidebar (🪣 Terraform State) first."
        )
        return result

    aws_env = dict(os.environ)
    aws_env["AWS_ACCESS_KEY_ID"]     = creds["aws_access_key_id"]
    aws_env["AWS_SECRET_ACCESS_KEY"] = creds["aws_secret_access_key"]
    aws_env["AWS_DEFAULT_REGION"]    = creds["region"]
    if creds.get("aws_session_token"):
        aws_env["AWS_SESSION_TOKEN"] = creds["aws_session_token"]

    tf_content = (
        'terraform {\n'
        '  backend "s3" {\n'
        f'    bucket = "{s3_bucket}"\n'
        f'    key    = "ec2/{instance_id}/terraform.tfstate"\n'
        f'    region = "{s3_region}"\n'
        '  }\n'
        '}\n'
    )

    with tempfile.TemporaryDirectory() as tmpdir:
        tf_file = os.path.join(tmpdir, "main.tf")
        with open(tf_file, "w") as f:
            f.write(tf_content)

        full_output = []
        try:
            init = subprocess.run(
                ["terraform", "init", "-no-color"],
                cwd=tmpdir, env=aws_env,
                capture_output=True, text=True, timeout=120,
            )
            full_output.append("=== terraform init ===")
            full_output.append(init.stdout)
            if init.returncode != 0:
                full_output.append(init.stderr)
                result["output"] = "\n".join(full_output)
                return result

            destroy = subprocess.run(
                ["terraform", "destroy", "-auto-approve", "-no-color"],
                cwd=tmpdir, env=aws_env,
                capture_output=True, text=True, timeout=600,
            )
            full_output.append("=== terraform destroy ===")
            full_output.append(destroy.stdout)
            if destroy.stderr:
                full_output.append(destroy.stderr)
            result["output"] = "\n".join(full_output)
            result["success"] = destroy.returncode == 0

        except subprocess.TimeoutExpired:
            result["output"] = "❌ terraform destroy timed out after 600s"
        except FileNotFoundError:
            result["output"] = "❌ terraform binary not found. Install: https://developer.hashicorp.com/terraform/install"
        except Exception as exc:
            result["output"] = f"❌ terraform destroy error: {exc}"

    return result


# ── Built-in tools ─────────────────────────────────────────────────────────────

@tool
def get_vault_credentials() -> str:
    """
    Fetch AWS credentials (access key, secret key, region) that the user
    stored in the Vault via the sidebar. Always call this first before
    deploying any infrastructure to AWS. Returns JSON with aws_access_key_id,
    aws_secret_access_key, and aws_region if credentials exist.
    """
    try:
        resp = httpx.get("http://localhost:8000/vault/get-aws", timeout=10)
        resp.raise_for_status()
        return resp.text
    except httpx.HTTPStatusError as e:
        return f"HTTP {e.response.status_code}: {e.response.text}"
    except Exception as e:
        return f"❌ Vault error: {e}"


@tool
def schedule_task(command: str, schedule_time: str, task_name: str = "") -> str:
    """Schedule any DevOps task to run at a specific time."""
    if not _scheduler:
        return "Scheduler not initialized."
    job_id = _scheduler.schedule_natural_language(command, schedule_time, task_name)
    if job_id:
        return f"✅ Scheduled '{command}' at {schedule_time} | Job ID: {job_id}"
    return f"❌ Could not parse schedule time: '{schedule_time}'"


@tool
def list_scheduled_tasks() -> str:
    """List all pending scheduled tasks."""
    if not _scheduler:
        return "Scheduler not initialized."
    jobs = _scheduler.list_jobs()
    if not jobs:
        return "No scheduled tasks."
    return json.dumps(jobs, default=str)


@tool
def cancel_scheduled_task(job_id: str) -> str:
    """Cancel a scheduled task by its job ID."""
    if not _scheduler:
        return "Scheduler not initialized."
    success = _scheduler.cancel_job(job_id)
    return f"✅ Cancelled job {job_id}" if success else f"❌ Job {job_id} not found"


@tool
def get_mcp_server_status() -> str:
    """Return which MCP servers are currently active / configured."""
    config = _build_mcp_config()
    status = {}
    for name, cfg in config.items():
        status[name] = {
            "command": f"{cfg['command']} {' '.join(cfg['args'])}",
            "transport": cfg.get("transport", "stdio"),
        }
    return json.dumps({"active_servers": list(status.keys()), "details": status}, indent=2)


@tool
def terraform_apply_with_creds(
    tf_content: str,
    aws_access_key: str,
    aws_secret_key: str,
    aws_region: str,
    instance_id: str = "",
) -> str:
    """
    Run terraform init + apply using the provided AWS Access Key and Secret Key.
    If instance_id is provided and TF_STATE_BUCKET is configured, Terraform state
    is stored in S3 at ec2/<instance_id>/terraform.tfstate so it can be destroyed later.
    Returns instance IDs, public IPs, and full terraform output.
    Never log or store the credentials — use them only for this apply call.
    """
    creds = _resolve_aws_creds(aws_access_key, aws_secret_key, aws_region)

    result = _run_terraform_apply(tf_content, creds, instance_id=instance_id)

    if result["success"]:
        lines = ["✅ Terraform apply succeeded!"]
        if result["instance_id"]:
            lines.append(f"Instance ID : {result['instance_id']}")
        if result["public_ip"]:
            lines.append(f"Public IP   : {result['public_ip']}")
        if result["resource_ids"]:
            lines.append(f"Resource IDs: {', '.join(result['resource_ids'])}")
        s3_bucket = os.getenv("TF_STATE_BUCKET", "")
        key_id = instance_id or result["instance_id"]
        if s3_bucket and key_id:
            lines.append(f"State stored: s3://{s3_bucket}/ec2/{key_id}/terraform.tfstate")
        lines.append("")
        lines.append(result["output"][-3000:])
        return "\n".join(lines)
    else:
        return f"❌ Terraform apply failed:\n\n{result['output'][-3000:]}"


@tool
def terraform_destroy_with_creds(
    instance_id: str,
    aws_access_key: str,
    aws_secret_key: str,
    aws_region: str,
) -> str:
    """
    Destroy a previously created EC2 instance (or any Terraform-managed resource)
    using its instance ID. Loads the Terraform state from S3 automatically using
    the instance ID as the key — no manual state file needed.
    The S3 bucket is read from TF_STATE_BUCKET (configured in the UI sidebar).
    Requires the same AWS credentials used to create the instance.
    """
    creds = _resolve_aws_creds(aws_access_key, aws_secret_key, aws_region)
    result = _run_terraform_destroy(instance_id, creds)
    if result["success"]:
        return f"✅ Terraform destroy succeeded for {instance_id}\n\n{result['output'][-3000:]}"
    else:
        return f"❌ Terraform destroy failed:\n\n{result['output'][-3000:]}"


@tool
async def aws_action(
    service: str,
    action: str,
    name: str = "",
    instance_type: str = "t3.micro",
    os_image: str = "amazon-linux-2023",
    region: str = "us-east-1",
    bucket_name: str = "",
    enable_cw_agent: bool = False,
) -> str:
    """
    Directly create AWS resources via the SDK — used by the 'Directly Apply to Console' option.
    service='ec2', action='create': resolves the latest AMI for os_image and launches an instance
      (os_image one of: amazon-linux-2023, ubuntu-22.04, ubuntu-24.04). Requires name; optional
      instance_type, region. Pass enable_cw_agent=true when CloudWatch monitoring includes Memory or
      Disk Space — it launches the instance with an IAM profile + user-data that installs the
      CloudWatch Agent so those metrics report. After creating the instance, call cloudwatch_apply_alarms
      to create the alarms.
    service='s3', action='create': creates a bucket (requires bucket_name or name).
    For full IaC / VPC / RDS / etc. use the terraform apply path instead. Returns JSON.
    """
    from app.aws_connector import aws_connector
    try:
        if service == "ec2" and action == "create":
            if not name:
                return json.dumps({"success": False, "error": "ec2 create requires name."})
            ami = await aws_connector.get_latest_ami(os_image)
            if not ami.get("success"):
                return json.dumps(ami)
            result = await aws_connector.create_ec2(instance_type, ami["ami_id"], name, region,
                                                    enable_cw_agent=enable_cw_agent)
        elif service == "s3" and action == "create":
            b = bucket_name or name
            if not b:
                return json.dumps({"success": False, "error": "s3 create requires bucket_name."})
            result = await aws_connector.create_s3_bucket(b, region)
        else:
            result = {"success": False, "error": f"Unsupported AWS direct action: {service}/{action}. Use terraform apply for other resources."}
        return json.dumps(result, default=str)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@tool
async def cloudwatch_apply_alarms(instance_id: str, region: str, metrics_json: str) -> str:
    """Create CloudWatch alarms on an existing EC2 instance (use after a Direct-Apply EC2 create).
    metrics_json: JSON array, one object per metric with keys: metric ("CPU Utilization"|"Memory"|
    "Disk Space"|"Status Check Failed"), statistic, period (sec), comparison_operator, threshold,
    evaluation_periods, datapoints_to_alarm, treat_missing_data. Memory/Disk need enable_cw_agent=true
    on the instance. Returns JSON with alarm names."""
    from app.aws_connector import aws_connector
    try:
        metrics = json.loads(metrics_json) if isinstance(metrics_json, str) else metrics_json
        if not isinstance(metrics, list):
            return json.dumps({"success": False, "error": "metrics_json must be a JSON array."})
        result = await aws_connector.apply_cloudwatch_alarms(instance_id, region, metrics)
        return json.dumps(result, default=str)
    except json.JSONDecodeError as e:
        return json.dumps({"success": False, "error": f"Invalid metrics_json: {e}"})
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@tool
async def cloudwatch_terraform_snippet(instance_name: str, ec2_resource_name: str, metrics_json: str) -> str:
    """Build CloudWatch alarm Terraform deterministically for the Terraform actions (don't hand-write HCL).
    ec2_resource_name = the aws_instance local name in your main.tf (e.g. "web" for resource "aws_instance" "web").
    metrics_json: same shape as cloudwatch_apply_alarms. Returns JSON {terraform, needs_agent, instance_edits}:
    append "terraform" to main.tf, and if "instance_edits" is non-empty paste those lines inside the aws_instance block."""
    from app.aws_connector import aws_connector
    try:
        metrics = json.loads(metrics_json) if isinstance(metrics_json, str) else metrics_json
        if not isinstance(metrics, list):
            return json.dumps({"success": False, "error": "metrics_json must be a JSON array."})
        result = aws_connector.build_cloudwatch_terraform(instance_name, ec2_resource_name, metrics)
        result["success"] = True
        return json.dumps(result, default=str)
    except json.JSONDecodeError as e:
        return json.dumps({"success": False, "error": f"Invalid metrics_json: {e}"})
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@tool
async def analyze_app_repo(owner: str, repo: str, branch: str = "") -> str:
    """Analyze an application's GitHub repo to detect its stack (language, framework, port,
    build/start commands) so a Dockerfile can be generated. owner/repo identify the user's
    APPLICATION repo (GITHUB_TOKEN must have access to it). Returns JSON with a 'profile' object."""
    from app.services import containerize
    try:
        return json.dumps(containerize.analyze_repo(owner, repo, branch), default=str)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@tool
async def generate_dockerfile(profile_json: str) -> str:
    """Generate a Dockerfile (+ .dockerignore) from the profile returned by analyze_app_repo.
    Pass analyze_app_repo's 'profile' object (or its whole result) as JSON. Returns
    {dockerfile, dockerignore}. Then push 'dockerfile' to the app repo at path 'Dockerfile'
    via create_or_update_file."""
    from app.services import containerize
    try:
        data = json.loads(profile_json) if isinstance(profile_json, str) else profile_json
        profile = data.get("profile", data) if isinstance(data, dict) else {}
        return json.dumps(containerize.build_dockerfile(profile), default=str)
    except json.JSONDecodeError as e:
        return json.dumps({"success": False, "error": f"Invalid profile_json: {e}"})
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@tool
async def containerize_app(owner: str, repo: str, setup_ci: bool = False,
                           region: str = "us-east-1", ecr_repo: str = "", branch: str = "") -> str:
    """ONE-SHOT containerize for the WHOLE repo, including monorepos. Detects every service
    (e.g. frontend/ AND backend/), generates + pushes a Dockerfile per service, and (if
    setup_ci=true) creates one ECR repo per service + a GitHub OIDC role and pushes a single
    matrix workflow that builds & pushes all images — all in the backend, returning a short summary.
    PREFER THIS over calling analyze_app_repo / create_or_update_file separately (keeps large
    Dockerfile/YAML out of the model → far fewer tokens). owner/repo = the application repo.
    For one service ECR repo = ecr_repo or repo; for multiple, each is <repo>-<service>.
    Returns JSON {services:[{name,language,dockerfile_url,ecr_uri}], workflow_url, role_arn}.
    setup_ci requires AWS to be connected."""
    from app.services import containerize as Cz
    from app.aws_connector import aws_connector
    try:
        ana = Cz.analyze_services(owner, repo, branch)
        if not ana.get("success"):
            return json.dumps(ana)
        services = ana.get("services", [])
        if not services:
            return json.dumps({"success": False,
                               "error": "No deployable service detected (no recognized manifest or source "
                                        "files). Tell me the language/structure so I can proceed."})
        b = ana.get("branch") or branch
        multi = len(services) > 1

        built = []
        for s in services:
            prof = s["profile"]
            df = Cz.build_dockerfile(prof)
            if not df.get("success"):
                return json.dumps({"success": False, "service": s["name"], **df})
            d = s["dir"]
            df_path = f"{d}/Dockerfile" if d else "Dockerfile"
            Cz.gh_put_file(owner, repo, df_path, df["dockerfile"], f"Add Dockerfile for {s['name']} (DevOps Agent)", b)
            Cz.gh_put_file(owner, repo, f"{d}/.dockerignore" if d else ".dockerignore",
                           df["dockerignore"], f"Add .dockerignore for {s['name']} (DevOps Agent)", b)
            ecr_name = (f"{repo}-{s['name']}" if multi else (ecr_repo or repo)).lower()
            built.append({"name": s["name"], "language": prof["language"], "dir": d or "(root)",
                          "dockerfile": df_path, "ecr": ecr_name,
                          "dockerfile_url": f"https://github.com/{owner}/{repo}/blob/{b}/{df_path}"})

        out = {"success": True, "service_count": len(built),
               "services": [{"name": x["name"], "language": x["language"],
                             "dockerfile_url": x["dockerfile_url"]} for x in built]}

        if setup_ci:
            oidc = await aws_connector.ensure_github_oidc_role(owner, repo)
            if not oidc.get("success"):
                return json.dumps({**out, "ci_error": oidc.get("error")})
            for x in built:
                ecr = await aws_connector.ensure_ecr_repo(x["ecr"], region)
                if not ecr.get("success"):
                    return json.dumps({**out, "ci_error": f"{x['ecr']}: {ecr.get('error')}"})
                x["ecr_uri"] = ecr["uri"]
            wf = Cz.build_ecr_workflow_multi(
                [{"ecr": x["ecr"], "dir": x["dir"] if x["dir"] != "(root)" else "",
                  "dockerfile": x["dockerfile"]} for x in built],
                oidc["role_arn"], region, b or "main")
            wfr = Cz.gh_put_file(owner, repo, ".github/workflows/docker-ecr.yml", wf,
                                 "Add ECR CI workflow (DevOps Agent)", b)
            out.update({"role_arn": oidc["role_arn"], "workflow_url": wfr.get("html_url", ""),
                        "services": [{"name": x["name"], "language": x["language"],
                                      "dockerfile_url": x["dockerfile_url"], "ecr_uri": x.get("ecr_uri", "")}
                                     for x in built]})
        return json.dumps(out, default=str)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@tool
async def setup_ecr_ci(owner: str, repo: str, ecr_repo: str = "",
                       region: str = "us-east-1", branch: str = "main") -> str:
    """Set up CI that builds the app's Docker image and pushes it to AWS ECR via GitHub OIDC
    (no stored secrets). Creates the ECR repository + the GitHub OIDC IAM role automatically,
    then returns the workflow YAML to push to .github/workflows/docker-ecr.yml.
    owner/repo = the application repo; ecr_repo defaults to the repo name. After calling this,
    push 'workflow_yaml' to 'workflow_path' via create_or_update_file. Returns JSON with
    {ecr_uri, role_arn, workflow_path, workflow_yaml}."""
    from app.aws_connector import aws_connector
    from app.services import containerize
    try:
        name = ecr_repo or repo
        ecr = await aws_connector.ensure_ecr_repo(name, region)
        if not ecr.get("success"):
            return json.dumps(ecr)
        oidc = await aws_connector.ensure_github_oidc_role(owner, repo)
        if not oidc.get("success"):
            return json.dumps(oidc)
        wf = containerize.build_ecr_workflow(name, oidc["role_arn"], region, branch)
        return json.dumps({
            "success": True,
            "ecr_uri": ecr["uri"],
            "role_arn": oidc["role_arn"],
            "workflow_path": ".github/workflows/docker-ecr.yml",
            "workflow_yaml": wf,
        }, default=str)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@tool
async def create_eks(name: str, environment: str = "dev", region: str = "us-east-1",
                     k8s_version: str = "1.30", instance_type: str = "t3.medium",
                     desired_nodes: int = 2, min_nodes: int = 1, max_nodes: int = 3,
                     endpoint_public: bool = True, push_to_github: bool = True) -> str:
    """Create a PRODUCTION-STRUCTURED EKS cluster. Generates a full Terraform module tree —
    modules/vpc + modules/iam + modules/eks consumed by environments/dev|staging|prod — pushes
    the whole tree to GitHub in ONE commit, and applies the chosen ENVIRONMENT in the BACKGROUND
    (~15 min, non-blocking). environment is one of dev/staging/prod; the cluster is named
    <name>-<environment>. Returns a job_id — tell the user it's provisioning and they can ask to
    check status (check_eks_status). Requires AWS credentials. Call EXACTLY ONCE after the wizard."""
    from app.services import eks_modules, tf_async
    try:
        environment = (environment or "dev").lower()
        if environment not in eks_modules.ENVIRONMENTS:
            environment = "dev"
        state_bucket = os.getenv("TF_STATE_BUCKET", "")
        files = tf_async.fmt_files(eks_modules.build_eks_module_tree(
            base_name=name, k8s_version=k8s_version, selected_env=environment, region=region,
            instance_type=instance_type, desired=desired_nodes, min_nodes=min_nodes,
            max_nodes=max_nodes, endpoint_public=endpoint_public,
            state_bucket=state_bucket, state_region=os.getenv("TF_STATE_REGION", region)))
        out = {"success": True, "cluster_name": f"{name}-{environment}", "environment": environment,
               "region": region, "file_count": len(files)}
        if not state_bucket:
            out["warning"] = ("TF_STATE_BUCKET is not set — state won't persist (you couldn't destroy/"
                              "update later). Set the S3 state bucket in the UI first for production use.")
        if push_to_github:
            owner = os.getenv("GITHUB_OWNER", "")
            repo = os.getenv("GITHUB_REPO", "")
            if owner and repo:
                from app.services import containerize as Cz
                r = Cz.gh_put_tree(owner, repo, files,
                                   f"Add EKS {name} Terraform modules + environments (DevOps Agent)",
                                   os.getenv("GITHUB_BRANCH", ""))
                out["github_url"] = r.get("tree_url", "")
        creds = _resolve_aws_creds(region=region)
        if not creds.get("aws_access_key_id"):
            return json.dumps({**out, "error": "No AWS credentials found (connect AWS / Vault). "
                                                "Terraform was generated/pushed but not applied."})
        job_id = tf_async.start_apply_tree(files, f"terraform/environments/{environment}",
                                           creds, region, f"{name}-{environment}")
        out.update({"job_id": job_id, "status": "applying",
                    "note": f"EKS '{name}-{environment}' apply started in the background (~15 min). "
                            f"Check progress with check_eks_status(job_id='{job_id}')."})
        return json.dumps(out, default=str)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@tool
async def check_eks_status(job_id: str) -> str:
    """Check a background terraform apply (EKS / blueprint). Returns status
    (queued/initializing/applying/succeeded/failed) and the latest terraform output tail."""
    from app.services import tf_async
    return json.dumps(tf_async.get_status(job_id), default=str)


@tool
async def compose_architecture(spec: dict) -> str:
    """Compose a full PRODUCTION ARCHITECTURE from connected modules in the knowledge base.
    Use when the user describes a system of multiple wired resources (e.g. "a VPC with an EC2
    connected to RDS and security groups"). DO NOT write Terraform — pass a spec OBJECT (not a JSON
    string) and the engine renders it from registry modules with automatic wiring.
    spec = {"name","environment"(dev/staging/prod),"region","components":[
      {"id","type"(a KB module: vpc/ec2/rds/security_group/...),"config"{...},"connect":{slot:other_id}}]}.
    'connect' wires a slot to another component's id, e.g. {"vpc":"vpc","sg":"app_sg"}. The engine pushes
    the Terraform to GitHub and applies it in the background. Returns a job_id (use check_eks_status)."""
    from app.services import composition_engine as CE
    from app.services import tf_async
    try:
        # Accept a real object (preferred) but tolerate a JSON string for safety.
        if isinstance(spec, str):
            spec = json.loads(spec) if spec.strip() else {}
        spec = dict(spec or {})
        if not spec.get("components"):
            return json.dumps({"success": False, "error": "spec needs a non-empty 'components' list."})
        spec.setdefault("region", "us-east-1")
        if os.getenv("TF_STATE_BUCKET"):
            spec["state_bucket"] = os.getenv("TF_STATE_BUCKET")
            spec["state_region"] = os.getenv("TF_STATE_REGION", spec["region"])
        files = tf_async.fmt_files(CE.compose(spec))  # clean HCL formatting before push/apply
        appspec = CE.apply_spec(spec)
        out = {"success": True, "name": appspec["name"],
               "components": [c.get("id") for c in spec["components"]], "file_count": len(files)}
        if not spec.get("state_bucket"):
            out["warning"] = "TF_STATE_BUCKET not set — state won't persist; set the S3 state bucket for production."
        owner = os.getenv("GITHUB_OWNER", "")
        repo = os.getenv("GITHUB_REPO", "")
        if owner and repo:
            from app.services import containerize as Cz
            r = Cz.gh_put_tree(owner, repo, files, f"Add architecture {appspec['name']} (DevOps Agent)",
                               os.getenv("GITHUB_BRANCH", ""))
            out["github_url"] = r.get("tree_url", "")
        creds = _resolve_aws_creds(region=appspec["region"])
        if not creds.get("aws_access_key_id"):
            return json.dumps({**out, "error": "No AWS credentials (connect AWS / Vault). "
                                                "Terraform generated/pushed but not applied."})
        job_id = tf_async.start_apply_tree(files, appspec["run_dir"], creds, appspec["region"], appspec["name"])
        out.update({"job_id": job_id, "status": "applying",
                    "note": f"Architecture '{appspec['name']}' apply started in the background. "
                            f"Check progress with check_eks_status(job_id='{job_id}')."})
        return json.dumps(out, default=str)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@tool
async def create_from_blueprint(resource: str, answers: dict) -> str:
    """Create infrastructure from a knowledge-base blueprint (knowledge_base/<resource>.yaml).
    Use this for blueprint resources like 'eks'. `answers` is an OBJECT of the wizard answers whose
    keys match the blueprint's question keys (pass it as a real object, NOT a JSON string). The engine
    deterministically renders the Terraform, pushes the whole tree to GitHub in one commit, and applies
    it (in the BACKGROUND for slow resources like EKS). Returns a summary + (for background) a job_id
    for check_eks_status. Requires AWS creds."""
    from app.services import blueprint_engine as BP
    from app.services import tf_async
    try:
        # Accept a real object (preferred) but stay tolerant of a JSON string for safety.
        if isinstance(answers, str):
            answers = json.loads(answers) if answers.strip() else {}
        answers = dict(answers or {})
        if not BP.load(resource):
            return json.dumps({"success": False,
                               "error": f"No blueprint for '{resource}'. Available: {BP.list_resources()}"})
        answers.setdefault("region", "us-east-1")
        if os.getenv("TF_STATE_BUCKET"):
            answers["state_bucket"] = os.getenv("TF_STATE_BUCKET")
            answers["state_region"] = os.getenv("TF_STATE_REGION", answers["region"])
        rendered = BP.render(resource, answers)
        # Guard: missing wizard answers leave {{placeholders}} in the output (e.g. a cluster
        # literally named "{{name}}-{{environment}}"). Refuse to push/apply broken Terraform —
        # tell the model which answers are missing so it asks the wizard questions first.
        missing = sorted({m for c in rendered.values() for m in re.findall(r"\{\{\s*(\w+)\s*\}\}", c)})
        if missing:
            return json.dumps({"success": False,
                               "error": f"Missing required answers {missing} — the {resource} wizard "
                                        "questions were not all collected. Ask them (one at a time) "
                                        "before calling create_from_blueprint."})
        files = tf_async.fmt_files(rendered)  # clean HCL formatting
        spec = BP.apply_spec(resource, answers)
        out = {"success": True, "resource": resource, "name": spec["name"], "file_count": len(files)}
        if not answers.get("state_bucket"):
            out["warning"] = ("TF_STATE_BUCKET not set — state won't persist (can't destroy/update later). "
                              "Set the S3 state bucket in the UI for production use.")
        owner = os.getenv("GITHUB_OWNER", "")
        repo = os.getenv("GITHUB_REPO", "")
        if owner and repo:
            from app.services import containerize as Cz
            r = Cz.gh_put_tree(owner, repo, files,
                               f"Add {resource} ({spec['name']}) from blueprint (DevOps Agent)",
                               os.getenv("GITHUB_BRANCH", ""))
            out["github_url"] = r.get("tree_url", "")
        creds = _resolve_aws_creds(region=spec["region"])
        if not creds.get("aws_access_key_id"):
            return json.dumps({**out, "error": "No AWS credentials (connect AWS / Vault). "
                                                "Terraform generated/pushed but not applied."})
        if spec["background"]:
            job_id = tf_async.start_apply_tree(files, spec["run_dir"], creds, spec["region"], spec["name"])
            out.update({"job_id": job_id, "status": "applying",
                        "note": f"{spec['name']} apply started in the background. "
                                f"Check progress with check_eks_status(job_id='{job_id}')."})
        else:
            res = tf_async.apply_tree_sync(files, spec["run_dir"], creds, spec["region"])
            out["status"] = "succeeded" if res.get("success") else "failed"
            out["apply_output"] = (res.get("output") or res.get("error", ""))[-1500:]
        return json.dumps(out, default=str)
    except json.JSONDecodeError as e:
        return json.dumps({"success": False, "error": f"Invalid answers_json: {e}"})
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@tool
async def create_k8s_app(app_name: str, image: str, port: int = 80, kind: str = "Deployment",
                         namespace: str = "default", replicas: int = 2, service_type: str = "ClusterIP",
                         with_rbac: bool = False, with_configmap: bool = False, with_secret: bool = False,
                         with_ingress: bool = False, ingress_host: str = "", with_hpa: bool = False) -> str:
    """Generate Kubernetes manifests from a container image and push them to GitHub in one commit
    under k8s/<app_name>/. Always emits the workload (Deployment or StatefulSet) + Service; optionally
    Namespace (when namespace != default), RBAC (ServiceAccount+Role+RoleBinding), ConfigMap, Secret,
    Ingress, and HPA. Deterministic — keeps the YAML out of the model. service_type is one of
    ClusterIP / LoadBalancer / NodePort. Returns JSON {kind, files, tree_url}. Use after the user
    gives an image and asks to create a deployment / deploy the app."""
    from app.services import k8s_manifests as K
    try:
        files = K.build_manifests(
            app_name, image, port, kind, namespace, replicas, service_type,
            with_service=True, with_rbac=with_rbac, with_configmap=with_configmap,
            with_secret=with_secret, with_ingress=with_ingress, ingress_host=ingress_host,
            with_hpa=with_hpa, hpa_min=replicas, hpa_max=int(replicas) + 3)
        kinds = [p.rsplit("/", 1)[-1].replace(".yaml", "") for p in files]
        out = {"success": True, "app": app_name, "namespace": namespace, "workload": kind,
               "kinds": kinds, "files": list(files.keys())}
        owner = os.getenv("GITHUB_OWNER", "")
        repo = os.getenv("GITHUB_REPO", "")
        if owner and repo:
            from app.services import containerize as Cz
            r = Cz.gh_put_tree(owner, repo, files,
                               f"Add Kubernetes manifests for {app_name} (DevOps Agent)",
                               os.getenv("GITHUB_BRANCH", ""))
            out["tree_url"] = r.get("tree_url", "")
        return json.dumps(out, default=str)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@tool
async def kubectl_action(action: str, resource: str = "", name: str = "", namespace: str = "",
                         all_namespaces: bool = False, replicas: int = 0, region: str = "us-east-1") -> str:
    """Run a kubectl operation on the connected EKS cluster (call connect_eks_kubeconfig first).
    action: get | describe | delete | logs | scale | rollout.
    Examples — list nodes: action='get', resource='nodes'; list all pods: action='get',
    resource='pods', all_namespaces=true; delete/'down' a pod: action='delete', resource='pod',
    name='<pod>', namespace='<ns>'; scale: action='scale', resource='deployment', name='<app>',
    replicas=N. Returns the kubectl output. Needs kubectl + valid AWS creds + a connected kubeconfig."""
    import subprocess
    try:
        creds = _resolve_aws_creds(region=region)
        env = {**os.environ, "AWS_DEFAULT_REGION": region, "AWS_REGION": region}
        for k in ("AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_SESSION_TOKEN"):
            if not env.get(k):
                env.pop(k, None)
        if creds.get("aws_access_key_id"):
            env["AWS_ACCESS_KEY_ID"] = creds["aws_access_key_id"]
            env["AWS_SECRET_ACCESS_KEY"] = creds["aws_secret_access_key"]
            if creds.get("aws_session_token"):
                env["AWS_SESSION_TOKEN"] = creds["aws_session_token"]
        a = (action or "").lower().strip()
        args = ["kubectl"]
        if a in ("get", "list"):
            args += ["get", resource or "pods"] + ([name] if name else [])
        elif a == "describe":
            args += ["describe", resource or "pod"] + ([name] if name else [])
        elif a in ("delete", "down"):
            if not name:
                return json.dumps({"success": False, "error": "delete needs a name."})
            args += ["delete", resource or "pod", name]
        elif a == "logs":
            args += ["logs", name]
        elif a == "scale":
            args += ["scale", f"{resource or 'deployment'}/{name}", f"--replicas={int(replicas)}"]
        elif a in ("rollout", "rollout-status"):
            args += ["rollout", "status", f"{resource or 'deployment'}/{name}"]
        else:
            return json.dumps({"success": False, "error": f"Unsupported action '{action}'. "
                                                          "Use get/describe/delete/logs/scale/rollout."})
        if all_namespaces:
            args += ["-A"]
        elif namespace:
            args += ["-n", namespace]
        r = subprocess.run(args, env=env, capture_output=True, text=True, timeout=60)
        return json.dumps({"success": r.returncode == 0, "command": " ".join(args),
                           "output": (r.stdout or r.stderr)[:3000]})
    except FileNotFoundError:
        return json.dumps({"success": False, "error": "kubectl not found on the server."})
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


@tool
async def connect_eks_kubeconfig(cluster_name: str, region: str = "us-east-1") -> str:
    """Run `aws eks update-kubeconfig` so kubectl and the Kubernetes MCP server can reach the
    cluster. Call this once the EKS cluster is ready (status succeeded). Requires the aws CLI on
    the server and valid AWS credentials. Returns success + the kube context name."""
    import subprocess
    try:
        creds = _resolve_aws_creds(region=region)
        env = {**os.environ, "AWS_DEFAULT_REGION": region, "AWS_REGION": region}
        # Empty AWS_PROFILE/token vars make the AWS CLI look for a profile named "" — drop them.
        for k in ("AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_SESSION_TOKEN"):
            if not env.get(k):
                env.pop(k, None)
        if creds.get("aws_access_key_id"):
            env["AWS_ACCESS_KEY_ID"] = creds["aws_access_key_id"]
            env["AWS_SECRET_ACCESS_KEY"] = creds["aws_secret_access_key"]
            if creds.get("aws_session_token"):
                env["AWS_SESSION_TOKEN"] = creds["aws_session_token"]
        r = subprocess.run(["aws", "eks", "update-kubeconfig", "--name", cluster_name, "--region", region],
                           env=env, capture_output=True, text=True, timeout=60)
        if r.returncode != 0:
            return json.dumps({"success": False, "error": (r.stderr or r.stdout)[:400]})
        return json.dumps({"success": True, "cluster": cluster_name, "region": region,
                           "note": "kubeconfig updated. Reconnect the Kubernetes MCP server to manage the cluster."})
    except FileNotFoundError:
        return json.dumps({"success": False, "error": "aws CLI not found on the server."})
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)})


# Tools are grouped by cloud so a session only sends the schemas for its selected
# cloud — binding all clouds' tools on every request blows llama-3.3-70b's 12k TPM free tier.
COMMON_BUILTINS = [
    schedule_task,
    list_scheduled_tasks,
    cancel_scheduled_task,
    get_mcp_server_status,
]
AWS_BUILTINS = [
    terraform_apply_with_creds,
    terraform_destroy_with_creds,
    aws_action,
    cloudwatch_apply_alarms,
    cloudwatch_terraform_snippet,
    analyze_app_repo,
    containerize_app,
    compose_architecture,
    create_from_blueprint,
    check_eks_status,
    create_k8s_app,
    connect_eks_kubeconfig,
    kubectl_action,
]
# Full set — used for the ToolNode (must be able to execute any tool) and the
# no-cloud-chosen-yet fallback binding. AWS is the only cloud.
BUILTIN_TOOLS = COMMON_BUILTINS + AWS_BUILTINS


def builtins_for_cloud(cloud: str) -> list:
    """Built-in tools relevant to the selected cloud (+ the cloud-agnostic common tools)."""
    return COMMON_BUILTINS + AWS_BUILTINS


# ── LangGraph State ────────────────────────────────────────────────────────────
class AgentState(TypedDict):
    messages: Annotated[List, operator.add]
    session_id: str
    context: dict

# ----system prompt---------------------------------------------------------

from app.prompts.system_prompt import (
    SYSTEM_PROMPT, SYSTEM_PROMPT_AWS,
    build_system_prompt,
)

# ── Graph builder ──────────────────────────────────────────────────────────────

# ⚠️  Keep MAX_MCP_TOOLS at 10 — llama-3.3-70b-versatile produces malformed
# tool calls with too many tools. Do NOT raise above 10-12 without testing.
MAX_MCP_TOOLS = 4
EXCLUDE_TOOLS = {"suggest_aws_commands"}


async def build_graph_async(mcp_tools: list):
    """Build the LangGraph with MCP tools + built-in tools."""

    mcp_tools = [t for t in mcp_tools if getattr(t, "name", "") not in EXCLUDE_TOOLS]
    logger.info(f"MCP tools after exclusions: {[t.name for t in mcp_tools]}")

    if len(mcp_tools) > MAX_MCP_TOOLS:
        logger.warning(f"Capping MCP tools from {len(mcp_tools)} to {MAX_MCP_TOOLS}")
        mcp_tools = mcp_tools[:MAX_MCP_TOOLS]

    all_tools = mcp_tools + BUILTIN_TOOLS
    logger.info(f"Total tools available: {len(all_tools)}")

    # Model is configurable via GROQ_MODEL so you can switch to one with a
    # higher daily token allowance (e.g. llama-3.1-8b-instant) without code changes.
    base_llm = ChatGroq(
        model=os.getenv("GROQ_MODEL", "llama-3.3-70b-versatile"),
        api_key=os.getenv("GROQ_API_KEY"),
        streaming=True,
        temperature=0,
    )

    # Pre-bind one LLM per cloud so each request only carries that cloud's tool schemas.
    # MCP tools (capped at MAX_MCP_TOOLS) are cross-cloud, so they go in every binding.
    def _bind(builtins: list):
        return base_llm.bind_tools(mcp_tools + builtins)

    llm_by_cloud = {
        "AWS": _bind(COMMON_BUILTINS + AWS_BUILTINS),
        "": _bind(BUILTIN_TOOLS),  # no cloud chosen yet
    }
    logger.info(f"Bound tool counts — AWS:{len(mcp_tools)+len(COMMON_BUILTINS+AWS_BUILTINS)}")

    # ToolNode must be able to execute ANY tool the model picks, so it gets the full set.
    tool_node = ToolNode(all_tools)

    def _sanitize_tool_calls(response):
        """Strip sha=null from GitHub tool calls — schema requires omission not null."""
        if not hasattr(response, "tool_calls") or not response.tool_calls:
            return response
        OMIT_IF_NULL = {
            "create_or_update_file": {"sha"},
            "push_files": {"sha"},
        }
        clean_calls = []
        for tc in response.tool_calls:
            tool_name = tc.get("name", "")
            args = dict(tc.get("args", {}))
            for field in OMIT_IF_NULL.get(tool_name, set()):
                if field in args and args[field] is None:
                    logger.info(f"Stripped null '{field}' from {tool_name} args")
                    del args[field]
            clean_calls.append({**tc, "args": args})
        response.tool_calls = clean_calls
        return response

    valid_tool_names = {getattr(t, "name", "") for t in all_tools}

    def _recover_failed_tool_call(e) -> Optional[AIMessage]:
        """Recover llama's malformed tool-call syntax that Groq rejects. Two shapes:
        (a) code=tool_use_failed with failed_generation containing <function=name>{...}; and
        (b) 'tool call validation failed: attempted to call tool '<name>{...json...}'' where the
            model fused the function name and its JSON args into the tool NAME."""
        name = raw = None
        body = getattr(e, "body", None)
        if isinstance(body, dict) and body.get("code") == "tool_use_failed":
            m = re.search(r"<function=(\w+)>?\s*(\{.*)", body.get("failed_generation", ""), re.DOTALL)
            if m:
                name, raw = m.group(1), m.group(2).split("</function>")[0].strip()
        if name is None:
            # Fused name+args, parsed out of the error message itself.
            m = re.search(r"call tool '(\w+)\s*(\{.*\})'", str(e), re.DOTALL)
            if m:
                name, raw = m.group(1), m.group(2)
        if not name or name not in valid_tool_names:
            return None
        try:
            args = json.loads(raw)
        except (json.JSONDecodeError, TypeError):
            return None
        # Tolerate the now-removed JSON-string arg names if the model still emits them.
        for legacy, current in (("answers_json", "answers"), ("spec_json", "spec")):
            if legacy in args and current not in args:
                val = args.pop(legacy)
                try:
                    args[current] = json.loads(val) if isinstance(val, str) else val
                except (json.JSONDecodeError, TypeError):
                    args[current] = val
        logger.warning(f"Recovered malformed tool call: {name}")
        return AIMessage(content="", tool_calls=[{
            "name": name,
            "args": args,
            "id": f"recovered_{uuid.uuid4().hex[:8]}",
            "type": "tool_call",
        }])

    def call_model(state: AgentState):
        # Per-cloud prompt + per-resource wizard + per-cloud tool set keep requests
        # inside Groq's free-tier limits. Rebuild the system prompt every turn (strip any
        # stale one) so it shrinks to just the chosen cloud+resource as they're detected.
        ctx = state.get("context") or {}
        cloud = ctx.get("cloud", "")
        resource = ctx.get("resource", "")
        convo = [m for m in state["messages"] if not isinstance(m, SystemMessage)]
        prompt = build_system_prompt(cloud, resource)
        messages = [SystemMessage(content=prompt)] + convo

        llm = llm_by_cloud.get(cloud, llm_by_cloud[""])

        last_error = None
        for attempt in range(2):
            try:
                response = llm.invoke(messages)
                response = _sanitize_tool_calls(response)
                return {"messages": [response]}
            except Exception as e:
                last_error = e
                recovered = _recover_failed_tool_call(e)
                if recovered is not None:
                    return {"messages": [_sanitize_tool_calls(recovered)]}
                # Retrying a rate-limit (429) just wastes another call — fail fast
                code = getattr(getattr(e, "response", None), "status_code", None)
                if code == 429 or "rate_limit" in str(e).lower():
                    break
                logger.warning(f"LLM call failed (attempt {attempt + 1}/2): {e}")

        print("\n===== LLM ERROR =====")
        print(last_error)
        if hasattr(last_error, "body"):
            print("\n===== ERROR BODY =====")
            print(last_error.body)
        raise last_error

    def should_continue(state: AgentState):
        last = state["messages"][-1]
        if hasattr(last, "tool_calls") and last.tool_calls:
            return "tools"
        return END

    graph = StateGraph(AgentState)
    graph.add_node("agent", call_model)
    graph.add_node("tools", tool_node)
    graph.set_entry_point("agent")
    graph.add_conditional_edges("agent", should_continue)
    graph.add_edge("tools", "agent")
    return graph.compile()


# ── Cloud selection guard ──────────────────────────────────────────────────────
# llama-3.3-70b skips prompt-level "ask which cloud first" rules and jumps
# straight into the AWS wizards, so the question is enforced in code instead.

CLOUD_OPTIONS_BLOCK = (
    "```options\n"
    '{"question": "Which cloud provider would you like to use?", "options": ["AWS"], "key": "cloud_provider"}\n'
    "```"
)

_AWS_RE = re.compile(r"\b(aws|amazon)\b", re.IGNORECASE)
_CLOUD_RESOURCE_RE = re.compile(
    r"\b(ec2|s3|vpc|rds|lambda|ecs|eks|iam|cloudwatch|subnet|"
    r"instances?|buckets?|databases?|compute|storage|clusters?|"
    r"security groups?|load balancers?)\b",
    re.IGNORECASE,
)


def _detect_cloud_choice(message: str) -> Optional[str]:
    """AWS is the only supported cloud — name it explicitly to select it."""
    return "AWS" if _AWS_RE.search(message) else None


# Which AWS resource wizard the user wants — used to load ONLY that wizard's prompt
# section instead of all six (saves ~2,700 tokens/message). Keys match build_aws_prompt.
_AWS_RESOURCE_RES = [
    ("ec2",    re.compile(r"\b(ec2|instances?)\b", re.IGNORECASE)),
    ("s3",     re.compile(r"\b(s3|buckets?)\b", re.IGNORECASE)),
    ("rds",    re.compile(r"\b(rds|databases?|\bdb\b)\b", re.IGNORECASE)),
    ("vpc",    re.compile(r"\b(vpc|networks?|subnets?)\b", re.IGNORECASE)),
    ("lambda", re.compile(r"\b(lambda|functions?)\b", re.IGNORECASE)),
    ("eks",    re.compile(r"\b(eks|kubernetes|k8s)\b", re.IGNORECASE)),
    ("ecs",    re.compile(r"\b(ecs|fargate)\b", re.IGNORECASE)),
]

# CI/CD + containerization intent → loads the Containerize/CI-to-ECR wizard (not a resource).
_CONTAINERIZE_RE = re.compile(
    r"\b(containeri[sz]e|dockerfile|docker|ecr|ci/?cd|cicd|pipeline|workflow|github\s*action)\b",
    re.IGNORECASE,
)

# Kubernetes manifest/wizard intent (strict — avoid colliding with "create eks with 3 nodes").
_K8S_DEPLOY_RE = re.compile(
    r"\b(kubectl|statefulset|daemonset|configmap|rbac|ingress|hpa|manifests?|"
    r"deploy(?:ing)?\s+(?:the\s+|my\s+|an?\s+)?(?:app|application|image|container|service|pod)|"
    r"create\s+(?:a\s+)?(?:deployment|namespace))\b",
    re.IGNORECASE,
)

# Live K8s ops bypass pattern — permissive (any phrasing): a kubectl verb anywhere near a
# K8s resource word in the same message.  Handles "list all. the nodes", "show me the pods",
# "can you get all services", "what pods are running", etc.  Deliberately loose — it only
# bypasses the cloud-selection gate, so a false-positive is harmless (the model will just call
# kubectl_action which fails gracefully if no cluster is connected).
_K8S_VERB_RE    = re.compile(r"\b(list|get|show|describe|delete|remove|scale|restart|logs?|down|drain|cordon|exec|port.?forward|rollout|watch)\b", re.IGNORECASE)
_K8S_RESOURCE_RE = re.compile(r"\b(pods?|nodes?|deployments?|services?|namespaces?|statefulsets?|configmaps?|ingress|secrets?|replicasets?|daemonsets?|cronjobs?|jobs?|pvcs?|hpa)\b", re.IGNORECASE)

def _is_k8s_live_op(message: str) -> bool:
    """True when message is a live kubectl op (verb + k8s resource anywhere in the text)."""
    return bool(_K8S_VERB_RE.search(message) and _K8S_RESOURCE_RE.search(message))


# Architecture composition: an explicit "architecture" word, or a create/build verb plus 2+
# distinct infra resources wired together → the composition engine (not a single resource).
_ARCH_KEYWORDS = re.compile(r"\b(architecture|architect|3[\s-]?tier|three[\s-]?tier|full[\s-]?stack)\b",
                            re.IGNORECASE)
_BUILD_VERB = re.compile(r"\b(create|build|provision|deploy|set\s?up|design|spin\s?up)\b", re.IGNORECASE)
_RESOURCE_WORDS = [
    re.compile(r"\bvpc\b", re.I), re.compile(r"\b(ec2|instance)\b", re.I),
    re.compile(r"\brds\b|\bdatabase\b", re.I), re.compile(r"\bs3\b|\bbucket\b", re.I),
    re.compile(r"\b(security group|sg)\b", re.I), re.compile(r"\b(alb|load balancer)\b", re.I),
]


def _count_resource_kinds(message: str) -> int:
    return sum(1 for rx in _RESOURCE_WORDS if rx.search(message))


def _detect_resource_choice(message: str) -> Optional[str]:
    """Return the intent key: 'containerize', 'k8s_deploy', 'architecture' (multi-resource compose),
    else a single AWS resource (ec2/s3/rds/vpc/lambda/ecs/eks)."""
    if _CONTAINERIZE_RE.search(message):
        return "containerize"
    if _K8S_DEPLOY_RE.search(message) or _is_k8s_live_op(message):
        return "k8s_deploy"
    if _ARCH_KEYWORDS.search(message) or (_BUILD_VERB.search(message) and _count_resource_kinds(message) >= 2):
        return "architecture"
    hits = [key for key, rx in _AWS_RESOURCE_RES if rx.search(message)]
    return hits[0] if len(hits) == 1 else None


# ── History compaction ─────────────────────────────────────────────────────────
# Every turn resends the whole history; big tool results (instance lists, terraform
# output) eat the 12k TPM free-tier budget fast.

MAX_HISTORY_MESSAGES = 10
MAX_TOOL_RESULT_CHARS = 1000


def _compact_history(messages: list) -> list:
    compacted = []
    for m in messages[-MAX_HISTORY_MESSAGES:]:
        if isinstance(m, ToolMessage) and isinstance(m.content, str) and len(m.content) > MAX_TOOL_RESULT_CHARS:
            m = ToolMessage(
                content=m.content[:MAX_TOOL_RESULT_CHARS] + "\n…[truncated]",
                tool_call_id=m.tool_call_id,
                name=getattr(m, "name", None) or "",
            )
        compacted.append(m)
    # A ToolMessage without its preceding tool-call AIMessage is rejected by the API
    while compacted and isinstance(compacted[0], ToolMessage):
        compacted.pop(0)
    return compacted


# ── DevOpsAgent class ──────────────────────────────────────────────────────────

class DevOpsAgent:
    def __init__(self):
        self.graph = None
        self.sessions: dict[str, list] = {}
        self.session_cloud: dict[str, str] = {}
        self.session_resource: dict[str, str] = {}  # AWS resource wizard in play (ec2/s3/…)
        self._mcp_client: Optional[MultiServerMCPClient] = None
        self._mcp_tools: list = []
        self._init_lock = asyncio.Lock()

    async def _ensure_initialized(self, scheduler: TaskScheduler, aws: AWSConnector):
        if self.graph is not None:
            return
        async with self._init_lock:
            if self.graph is not None:
                return
            await self._do_init(scheduler, aws)

    async def _do_init(self, scheduler: TaskScheduler, aws: AWSConnector):
        """Internal: build MCP client + LangGraph from current os.environ."""
        init_dependencies(scheduler, aws)
        mcp_config = _build_mcp_config()
        logger.info(f"Starting {len(mcp_config)} MCP server(s): {list(mcp_config.keys())}")

        # ── Shut down any existing MCP client before rebuilding ──────────────
        if self._mcp_client is not None:
            try:
                await self._mcp_client.__aexit__(None, None, None)
            except Exception:
                pass
            self._mcp_client = None

        self._mcp_client = MultiServerMCPClient(mcp_config)
        try:
            self._mcp_tools = await self._mcp_client.get_tools()
            logger.info(f"✅ MCP loaded {len(self._mcp_tools)} tool(s)")
            for t in self._mcp_tools:
                print("TOOL:", t.name)
        except Exception as exc:
            logger.warning(f"⚠️  MCP server init partially failed: {exc}. Continuing with built-ins.")
            self._mcp_tools = []

        self.graph = await build_graph_async(self._mcp_tools)
        logger.info("✅ LangGraph compiled and ready.")

    async def reinitialize(self, scheduler: TaskScheduler, aws: AWSConnector):
        """
        Force a full teardown + rebuild of the MCP client and LangGraph.
        Call this after AWS credentials are updated so the MCP subprocess
        picks up the new keys from os.environ.
        """
        async with self._init_lock:
            logger.info("🔄 Reinitializing agent with updated credentials...")
            self.graph = None          # force rebuild
            self.sessions = {}         # clear sessions — stale tool calls would fail anyway
            await self._do_init(scheduler, aws)
            logger.info("✅ Agent reinitialized successfully.")

    async def stream_response(
        self,
        message: str,
        session_id: str,
        scheduler: TaskScheduler = None,
        aws: AWSConnector = None,
    ) -> AsyncGenerator[dict, None]:
        if scheduler is None or aws is None:
            from main import scheduler as _s, aws_connector as _a
            scheduler, aws = _s, _a

        await self._ensure_initialized(scheduler, aws)

        history = self.sessions.get(session_id, [])
        history.append(HumanMessage(content=message))

        # K8s live ops bypass cloud selection — they use the connected kubeconfig directly.
        res = _detect_resource_choice(message)
        _bypass_cloud = (res == "k8s_deploy") or _is_k8s_live_op(message)

        # Remember the detected resource wizard BEFORE any early return below. Otherwise, when the
        # first message ("create eks") triggers the cloud-selection prompt and returns early, the
        # detected resource is discarded — so after the user picks a cloud the wizard never loads
        # and the model invents its own questions.
        if res:
            self.session_resource[session_id] = res

        # Enforce cloud selection before any cloud-resource work (see CLOUD_OPTIONS_BLOCK)
        chosen = _detect_cloud_choice(message)
        if chosen:
            self.session_cloud[session_id] = chosen
        elif not _bypass_cloud and session_id not in self.session_cloud and _CLOUD_RESOURCE_RE.search(message):
            history.append(AIMessage(content=CLOUD_OPTIONS_BLOCK))
            self.sessions[session_id] = _compact_history(history)
            yield {"type": "text", "content": CLOUD_OPTIONS_BLOCK}
            return

        # Single-page form for form-enabled blueprint resources (e.g. eks): emit ALL questions at
        # once (deterministic, NO LLM) so the model never drives — and so can't drift, duplicate, or
        # invent — the wizard. The user fills the form in the UI and submits to /eks/blueprint-create.
        _resource = self.session_resource.get(session_id, "")
        if (self.session_cloud.get(session_id) == "AWS" and _resource in {"eks"}
                and (chosen or res)):
            from app.services import blueprint_engine as BP
            bp = BP.load(_resource)
            if bp:
                form_block = "```form\n" + json.dumps({
                    "resource": _resource,
                    "title": bp.get("title", _resource),
                    "questions": bp.get("questions", []),
                }) + "\n```"
                history.append(AIMessage(content=form_block))
                self.sessions[session_id] = _compact_history(history)
                yield {"type": "text", "content": form_block}
                return

        state = {
            "messages": history,
            "session_id": session_id,
            "context": {
                "cloud": self.session_cloud.get(session_id, ""),
                "resource": self.session_resource.get(session_id, ""),
            },
        }

        full_response = ""
        last_event_messages: list = []

        try:
            async for event in self.graph.astream(state, stream_mode="values"):
                messages = event.get("messages", [])
                if not messages:
                    continue

                last_event_messages = messages
                last = messages[-1]

                if isinstance(last, AIMessage):
                    if last.content and last.content != full_response:
                        delta = last.content[len(full_response):]
                        full_response = last.content
                        if delta:
                            yield {"type": "text", "content": delta}
                    if hasattr(last, "tool_calls") and last.tool_calls:
                        for tc in last.tool_calls:
                            yield {
                                "type": "tool_call",
                                "tool": tc["name"],
                                "args": tc["args"],
                                "server": _resolve_server(tc["name"], self._mcp_tools),
                            }

                elif isinstance(last, ToolMessage):
                    yield {
                        "type": "tool_result",
                        "tool": last.name,
                        "content": last.content,
                    }

            if last_event_messages:
                self.sessions[session_id] = _compact_history(last_event_messages)

        except Exception as exc:
            logger.exception("Agent stream error")
            yield {"type": "error", "content": f"Agent error: {exc}"}

    async def shutdown(self):
        if self._mcp_client is not None:
            try:
                await self._mcp_client.__aexit__(None, None, None)
                logger.info("MCP servers stopped.")
            except Exception as exc:
                logger.warning(f"MCP shutdown error: {exc}")


# ── Helper ─────────────────────────────────────────────────────────────────────

def _resolve_server(tool_name: str, mcp_tools: list) -> str:
    for t in mcp_tools:
        if getattr(t, "name", "") == tool_name:
            meta = getattr(t, "metadata", {}) or {}
            return meta.get("server", "mcp")
    return "builtin"

# ── Singleton instance ─────────────────────────────────────────────────────────
agent = DevOpsAgent()