"""
AWSConnector — Assumes IAM roles using ExternalId pattern (Confused Deputy protection)
"""
import os
import json
import asyncio
from datetime import datetime, timedelta
from typing import Optional
import boto3
from botocore.exceptions import ClientError, NoCredentialsError

class AWSConnector:
    def __init__(self):
        self._session: Optional[boto3.Session] = None
        self._credentials: dict = {}
        self._external_ids: dict = {}  # customer_id → external_id
        self._connected = False
        self._account_id: Optional[str] = None

    def store_external_id(self, customer_id: str, external_id: str):
        self._external_ids[customer_id] = external_id

    def is_connected(self) -> bool:
        return self._connected and self._session is not None

    # ── Role Assumption ─────────────────────────────────────────────────────
    async def assume_role(self, role_arn: str, external_id: str, region: str = "us-east-1") -> dict:
        try:
            # Clear empty string env vars that confuse boto3 credential chain
            for key in ("AWS_PROFILE", "AWS_DEFAULT_PROFILE", "AWS_ACCESS_KEY_ID",
                        "AWS_SECRET_ACCESS_KEY", "AWS_SESSION_TOKEN"):
                if os.getenv(key) == "":
                    os.environ.pop(key, None)

            sts = boto3.client("sts", region_name=region)
            response = sts.assume_role(
                RoleArn=role_arn,
                RoleSessionName="DevOpsAgentSession",
                ExternalId=external_id,
                DurationSeconds=3600,
            )
            
            creds = response["Credentials"]
            self._session = boto3.Session(
                aws_access_key_id=creds["AccessKeyId"],
                aws_secret_access_key=creds["SecretAccessKey"],
                aws_session_token=creds["SessionToken"],
                region_name=region,
            )
            
            self._credentials = {
                "role_arn": role_arn,
                "external_id": external_id,
                "region": region,
                "expiration": str(creds["Expiration"]),
            }
            self._connected = True
            
            # Get account ID
            caller = self._session.client("sts").get_caller_identity()
            self._account_id = caller["Account"]
            return {"success": True, "account_id": self._account_id}
            
        except ClientError as e:
            return {"success": False, "error": str(e)}
        except Exception as e:
            return {"success": False, "error": f"Connection failed: {str(e)}"}

    def _client(self, service: str):
        """Get a boto3 client using assumed-role session, fallback to env vars."""
        if self._session:
            return self._session.client(service)
            
        # Fallback: use env vars (for local dev)
        # Explicitly checking for empty string values to prevent profile errors here too
        access_key = os.getenv("AWS_ACCESS_KEY_ID")
        secret_key = os.getenv("AWS_SECRET_ACCESS_KEY")
        region_name = os.getenv("AWS_DEFAULT_REGION", "us-east-1")
        
        if not access_key or not secret_key:
            # If no env keys, spawn an isolated session to prevent profile loading
            return boto3.Session(
                aws_access_key_id=None, 
                aws_secret_access_key=None
            ).client(service, region_name=region_name)
            
        return boto3.client(
            service,
            aws_access_key_id=access_key,
            aws_secret_access_key=secret_key,
            region_name=region_name,
        )

    # ── EC2 ─────────────────────────────────────────────────────────────────
    # OS name → AWS public SSM parameter that holds the latest AMI for the region
    _SSM_AMI_PARAMS = {
        "amazon-linux-2023": "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64",
        "ubuntu-22.04": "/aws/service/canonical/ubuntu/server/22.04/stable/current/amd64/hvm/ebs-gp2/ami-id",
        "ubuntu-24.04": "/aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id",
    }

    async def get_latest_ami(self, os_image: str) -> dict:
        """Resolve the latest AMI ID for an OS in the configured region via SSM public parameters."""
        param = self._SSM_AMI_PARAMS.get(os_image)
        if not param:
            return {"success": False, "error": f"Unknown os_image '{os_image}'. Supported: {', '.join(self._SSM_AMI_PARAMS)}"}
        try:
            ssm = self._client("ssm")
            resp = ssm.get_parameter(Name=param)
            return {"success": True, "ami_id": resp["Parameter"]["Value"]}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def create_ec2(self, instance_type: str, ami_id: str, name: str, region: str,
                         enable_cw_agent: bool = False) -> dict:
        try:
            ec2 = self._client("ec2")
            run_args = dict(
                ImageId=ami_id,
                InstanceType=instance_type,
                MinCount=1,
                MaxCount=1,
                TagSpecifications=[{
                    "ResourceType": "instance",
                    "Tags": [{"Key": "Name", "Value": name}, {"Key": "CreatedBy", "Value": "DevOpsAgent"}]
                }]
            )
            # For Memory/Disk metrics the CloudWatch Agent must run on the box: attach an
            # instance profile with CloudWatchAgentServerPolicy and install the agent via user-data.
            if enable_cw_agent:
                profile = self._ensure_cw_agent_profile()
                if profile:
                    run_args["IamInstanceProfile"] = {"Name": profile}
                run_args["UserData"] = self._cw_agent_user_data()

            response = ec2.run_instances(**run_args)
            inst = response["Instances"][0]
            return {
                "success": True,
                "instance_id": inst["InstanceId"],
                "state": inst["State"]["Name"],
                "instance_type": inst["InstanceType"],
                "ami": inst["ImageId"],
                "cw_agent": enable_cw_agent,
                "launch_time": str(inst["LaunchTime"]),
            }
        except Exception as e:
            return {"success": False, "error": str(e), "simulated": True, "instance_id": "i-0SIMULATED123", "note": "Mock response (AWS not configured)"}

    async def list_ec2(self, region: str) -> dict:
        try:
            ec2 = self._client("ec2")
            response = ec2.describe_instances()
            instances = []
            for reservation in response["Reservations"]:
                for inst in reservation["Instances"]:
                    name = next((t["Value"] for t in inst.get("Tags", []) if t["Key"] == "Name"), "N/A")
                    instances.append({
                        "instance_id": inst["InstanceId"],
                        "name": name,
                        "state": inst["State"]["Name"],
                        "instance_type": inst["InstanceType"],
                        "public_ip": inst.get("PublicIpAddress", "N/A"),
                        "launch_time": str(inst.get("LaunchTime", "")),
                    })
            return {"success": True, "instances": instances, "count": len(instances)}
        except Exception as e:
            return {"success": False, "error": str(e), "instances": [], "simulated": True}

    async def stop_ec2(self, instance_id: str, region: str) -> dict:
        try:
            ec2 = self._client("ec2")
            ec2.stop_instances(InstanceIds=[instance_id])
            return {"success": True, "instance_id": instance_id, "state": "stopping"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def terminate_ec2(self, instance_id: str, region: str) -> dict:
        try:
            ec2 = self._client("ec2")
            ec2.terminate_instances(InstanceIds=[instance_id])
            return {"success": True, "instance_id": instance_id, "state": "shutting-down"}
        except Exception as e:
            return {"success": False, "error": str(e)}

    # ── S3 ──────────────────────────────────────────────────────────────────
    async def create_s3_bucket(self, bucket_name: str, region: str) -> dict:
        try:
            s3 = self._client("s3")
            if region == "us-east-1":
                s3.create_bucket(Bucket=bucket_name)
            else:
                s3.create_bucket(Bucket=bucket_name, CreateBucketConfiguration={"LocationConstraint": region})
            return {"success": True, "bucket": bucket_name, "region": region}
        except Exception as e:
            return {"success": False, "error": str(e)}

    async def list_s3_buckets(self) -> dict:
        try:
            s3 = self._client("s3")
            response = s3.list_buckets()
            buckets = [{"name": b["Name"], "created": str(b["CreationDate"])} for b in response["Buckets"]]
            return {"success": True, "buckets": buckets, "count": len(buckets)}
        except Exception as e:
            return {"success": False, "error": str(e), "buckets": []}

    # ── Security Groups ─────────────────────────────────────────────────────
    async def create_security_group(self, name: str, description: str, ports: list, region: str) -> dict:
        try:
            ec2 = self._client("ec2")
            sg = ec2.create_security_group(GroupName=name, Description=description)
            sg_id = sg["GroupId"]
            for port in ports:
                ec2.authorize_security_group_ingress(
                    GroupId=sg_id,
                    IpPermissions=[{
                        "IpProtocol": "tcp",
                        "FromPort": port,
                        "ToPort": port,
                        "IpRanges": [{"CidrIp": "0.0.0.0/0"}]
                    }]
                )
            return {"success": True, "security_group_id": sg_id, "ports": ports}
        except Exception as e:
            return {"success": False, "error": str(e)}

    # ── CloudWatch ──────────────────────────────────────────────────────────
    # Maps the UI metric labels to their CloudWatch namespace + metric name. Memory and
    # disk come from the CloudWatch Agent (CWAgent); CPU and status checks are native (AWS/EC2).
    _CW_METRIC_MAP = {
        "CPU Utilization":     {"namespace": "AWS/EC2", "metric_name": "CPUUtilization", "agent": False},
        "Memory":              {"namespace": "CWAgent", "metric_name": "mem_used_percent", "agent": True},
        "Disk Space":          {"namespace": "CWAgent", "metric_name": "disk_used_percent", "agent": True},
        "Status Check Failed": {"namespace": "AWS/EC2", "metric_name": "StatusCheckFailed", "agent": False},
    }

    _CW_AGENT_ROLE = "DevOpsAgent-CWAgent-Role"
    _CW_AGENT_PROFILE = "DevOpsAgent-CWAgent-Profile"

    def _cw_agent_user_data(self) -> str:
        """Bash user-data that installs the CloudWatch Agent and publishes mem/disk metrics to CWAgent."""
        return (
            "#!/bin/bash\n"
            "set -e\n"
            "if command -v yum >/dev/null 2>&1; then\n"
            "  yum install -y amazon-cloudwatch-agent || true\n"
            "else\n"
            "  apt-get update -y && apt-get install -y wget\n"
            "  wget -q https://s3.amazonaws.com/amazoncloudwatch-agent/ubuntu/amd64/latest/amazon-cloudwatch-agent.deb\n"
            "  dpkg -i -E amazon-cloudwatch-agent.deb\n"
            "fi\n"
            "cat > /opt/aws/amazon-cloudwatch-agent/bin/config.json <<'CFG'\n"
            '{"metrics":{"append_dimensions":{"InstanceId":"${aws:InstanceId}"},'
            '"metrics_collected":{"mem":{"measurement":["mem_used_percent"]},'
            '"disk":{"measurement":["used_percent"],"resources":["/"]}}}}\n'
            "CFG\n"
            "/opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl "
            "-a fetch-config -m ec2 -s -c file:/opt/aws/amazon-cloudwatch-agent/bin/config.json\n"
        )

    def _ensure_cw_agent_profile(self) -> Optional[str]:
        """Idempotently create the IAM role + instance profile that lets the agent publish metrics."""
        try:
            iam = self._client("iam")
            assume = (
                '{"Version":"2012-10-17","Statement":[{"Action":"sts:AssumeRole","Effect":"Allow",'
                '"Principal":{"Service":"ec2.amazonaws.com"}}]}'
            )
            try:
                iam.create_role(RoleName=self._CW_AGENT_ROLE, AssumeRolePolicyDocument=assume)
            except iam.exceptions.EntityAlreadyExistsException:
                pass
            try:
                iam.attach_role_policy(
                    RoleName=self._CW_AGENT_ROLE,
                    PolicyArn="arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy",
                )
            except Exception:
                pass
            try:
                iam.create_instance_profile(InstanceProfileName=self._CW_AGENT_PROFILE)
            except iam.exceptions.EntityAlreadyExistsException:
                pass
            try:
                iam.add_role_to_instance_profile(
                    InstanceProfileName=self._CW_AGENT_PROFILE, RoleName=self._CW_AGENT_ROLE
                )
            except iam.exceptions.LimitExceededException:
                pass  # role already attached
            return self._CW_AGENT_PROFILE
        except Exception:
            return None  # fall back to launching without the profile

    async def create_cloudwatch_alarm(
        self,
        instance_id: str,
        metric_label: str,
        region: str = "us-east-1",
        statistic: str = "Average",
        period: int = 300,
        comparison_operator: str = "GreaterThanThreshold",
        threshold: float = 80.0,
        evaluation_periods: int = 1,
        datapoints_to_alarm: int = 1,
        treat_missing_data: str = "missing",
        alarm_name: str = "",
    ) -> dict:
        """Create one CloudWatch alarm for an EC2 instance using a UI metric label."""
        meta = self._CW_METRIC_MAP.get(metric_label)
        if not meta:
            return {"success": False, "error": f"Unknown metric '{metric_label}'. "
                    f"Supported: {', '.join(self._CW_METRIC_MAP)}"}
        try:
            cw = self._client("cloudwatch")
            slug = meta["metric_name"].lower().replace("_", "-")
            name = alarm_name or f"{instance_id}-{slug}"
            cw.put_metric_alarm(
                AlarmName=name,
                Namespace=meta["namespace"],
                MetricName=meta["metric_name"],
                Statistic=statistic,
                Period=int(period),
                EvaluationPeriods=int(evaluation_periods),
                DatapointsToAlarm=int(datapoints_to_alarm),
                Threshold=float(threshold),
                ComparisonOperator=comparison_operator,
                TreatMissingData=treat_missing_data,
                Dimensions=[{"Name": "InstanceId", "Value": instance_id}],
                AlarmDescription=f"{metric_label} alarm for {instance_id} (created by DevOpsAgent)",
            )
            return {"success": True, "alarm_name": name, "metric": metric_label,
                    "namespace": meta["namespace"], "needs_agent": meta["agent"]}
        except Exception as e:
            return {"success": False, "error": str(e), "metric": metric_label}

    def build_cloudwatch_terraform(self, instance_name: str, ec2_resource_name: str, metrics: list) -> dict:
        """Deterministically build the CloudWatch alarm (+ agent) HCL so a small model never has to.
        Returns {"terraform": <hcl>, "needs_agent": bool, "instance_edits": <hcl to add to the instance>}."""
        alarms, needs_agent = [], False
        for m in metrics:
            label = m.get("metric") or m.get("metric_label")
            meta = self._CW_METRIC_MAP.get(label)
            if not meta:
                continue
            if meta["agent"]:
                needs_agent = True
            slug = meta["metric_name"].lower().replace("_", "-")
            alarms.append(
                f'resource "aws_cloudwatch_metric_alarm" "{slug}" {{\n'
                f'  alarm_name          = "{instance_name}-{slug}"\n'
                f'  namespace           = "{meta["namespace"]}"\n'
                f'  metric_name         = "{meta["metric_name"]}"\n'
                f'  statistic           = "{m.get("statistic", "Average")}"\n'
                f'  period              = {int(m.get("period", 300))}\n'
                f'  comparison_operator = "{m.get("comparison_operator", "GreaterThanThreshold")}"\n'
                f'  threshold           = {m.get("threshold", 80)}\n'
                f'  evaluation_periods  = {int(m.get("evaluation_periods", 1))}\n'
                f'  datapoints_to_alarm = {int(m.get("datapoints_to_alarm", 1))}\n'
                f'  treat_missing_data  = "{m.get("treat_missing_data", "missing")}"\n'
                f'  dimensions = {{ InstanceId = aws_instance.{ec2_resource_name}.id }}\n'
                f'}}'
            )
        hcl = "\n\n".join(alarms)
        instance_edits = ""
        if needs_agent:
            user_data = self._cw_agent_user_data()
            indented = "\n".join("    " + ln for ln in user_data.splitlines())
            hcl += (
                "\n\n"
                f'resource "aws_iam_role" "cw_agent" {{\n'
                f'  name = "{instance_name}-cw-agent-role"\n'
                '  assume_role_policy = jsonencode({\n'
                '    Version = "2012-10-17",\n'
                '    Statement = [{ Action = "sts:AssumeRole", Effect = "Allow", Principal = { Service = "ec2.amazonaws.com" } }]\n'
                '  })\n'
                '}\n\n'
                'resource "aws_iam_role_policy_attachment" "cw_agent" {\n'
                '  role       = aws_iam_role.cw_agent.name\n'
                '  policy_arn = "arn:aws:iam::aws:policy/CloudWatchAgentServerPolicy"\n'
                '}\n\n'
                f'resource "aws_iam_instance_profile" "cw_agent" {{\n'
                f'  name = "{instance_name}-cw-agent-profile"\n'
                '  role = aws_iam_role.cw_agent.name\n'
                '}'
            )
            instance_edits = (
                "  iam_instance_profile = aws_iam_instance_profile.cw_agent.name\n"
                "  user_data = <<-EOF\n" + indented + "\n  EOF"
            )
        return {"terraform": hcl, "needs_agent": needs_agent, "instance_edits": instance_edits}

    async def apply_cloudwatch_alarms(self, instance_id: str, region: str, metrics: list) -> dict:
        """Create alarms for a list of metric config dicts. Each dict needs at least 'metric'."""
        results = []
        for m in metrics:
            label = m.get("metric") or m.get("metric_label")
            res = await self.create_cloudwatch_alarm(
                instance_id=instance_id,
                metric_label=label,
                region=region,
                statistic=m.get("statistic", "Average"),
                period=m.get("period", 300),
                comparison_operator=m.get("comparison_operator", "GreaterThanThreshold"),
                threshold=m.get("threshold", 80.0),
                evaluation_periods=m.get("evaluation_periods", 1),
                datapoints_to_alarm=m.get("datapoints_to_alarm", 1),
                treat_missing_data=m.get("treat_missing_data", "missing"),
            )
            results.append(res)
        created = [r["alarm_name"] for r in results if r.get("success")]
        return {"success": all(r.get("success") for r in results),
                "alarms": results, "created": created, "count": len(created)}

    # ── ECR + GitHub OIDC (for CI/CD) ───────────────────────────────────────
    def _account_id_now(self) -> Optional[str]:
        try:
            return self._client("sts").get_caller_identity()["Account"]
        except Exception:
            return self._account_id

    async def ensure_ecr_repo(self, name: str, region: str = "us-east-1") -> dict:
        """Create the ECR repository if it doesn't exist (idempotent). Returns its URI."""
        try:
            ecr = self._client("ecr")
            try:
                resp = ecr.create_repository(
                    repositoryName=name,
                    imageScanningConfiguration={"scanOnPush": True},
                    imageTagMutability="MUTABLE",
                )
                uri = resp["repository"]["repositoryUri"]
            except ecr.exceptions.RepositoryAlreadyExistsException:
                resp = ecr.describe_repositories(repositoryNames=[name])
                uri = resp["repositories"][0]["repositoryUri"]
            return {"success": True, "repository": name, "uri": uri, "region": region}
        except Exception as e:
            return {"success": False, "error": str(e)}

    _GITHUB_OIDC_URL = "token.actions.githubusercontent.com"

    async def ensure_github_oidc_role(
        self, github_owner: str, github_repo: str,
        role_name: str = "", policy_arns: Optional[list] = None,
    ) -> dict:
        """Idempotently create the GitHub OIDC provider + an IAM role the repo's Actions
        can assume (no stored secrets). policy_arns defaults to ECR-push permissions."""
        try:
            iam = self._client("iam")
            account = self._account_id_now()
            if not account:
                return {"success": False, "error": "Could not resolve AWS account id (check credentials)."}

            provider_arn = f"arn:aws:iam::{account}:oidc-provider/{self._GITHUB_OIDC_URL}"
            # 1. OIDC provider (idempotent)
            try:
                iam.create_open_id_connect_provider(
                    Url=f"https://{self._GITHUB_OIDC_URL}",
                    ClientIDList=["sts.amazonaws.com"],
                    ThumbprintList=["6938fd4d98bab03faadb97b34396831e3780aea1"],
                )
            except iam.exceptions.EntityAlreadyExistsException:
                pass

            # 2. Role with a trust policy scoped to THIS repo
            role_name = role_name or f"gha-{github_repo}-deploy"[:64]
            trust = {
                "Version": "2012-10-17",
                "Statement": [{
                    "Effect": "Allow",
                    "Principal": {"Federated": provider_arn},
                    "Action": "sts:AssumeRoleWithWebIdentity",
                    "Condition": {
                        "StringEquals": {f"{self._GITHUB_OIDC_URL}:aud": "sts.amazonaws.com"},
                        "StringLike": {f"{self._GITHUB_OIDC_URL}:sub": f"repo:{github_owner}/{github_repo}:*"},
                    },
                }],
            }
            try:
                iam.create_role(
                    RoleName=role_name,
                    AssumeRolePolicyDocument=json.dumps(trust),
                    Description=f"GitHub Actions OIDC deploy role for {github_owner}/{github_repo}",
                )
            except iam.exceptions.EntityAlreadyExistsException:
                # keep the trust policy current in case the repo/condition changed
                iam.update_assume_role_policy(RoleName=role_name, PolicyDocument=json.dumps(trust))

            # 3. Permissions — default to ECR push
            arns = policy_arns or ["arn:aws:iam::aws:policy/AmazonEC2ContainerRegistryPowerUser"]
            for arn in arns:
                try:
                    iam.attach_role_policy(RoleName=role_name, PolicyArn=arn)
                except Exception:
                    pass

            role_arn = f"arn:aws:iam::{account}:role/{role_name}"
            return {"success": True, "role_arn": role_arn, "role_name": role_name,
                    "provider_arn": provider_arn, "policies": arns}
        except Exception as e:
            return {"success": False, "error": str(e)}

    # ── Cost ────────────────────────────────────────────────────────────────
    async def get_cost_estimate(self, days: int) -> dict:
        try:
            ce = self._client("ce")
            end = datetime.utcnow().date()
            start = (datetime.utcnow() - timedelta(days=days)).date()
            response = ce.get_cost_and_usage(
                TimePeriod={"Start": str(start), "End": str(end)},
                Granularity="MONTHLY",
                Metrics=["UnblendedCost"]
            )
            total = sum(
                float(r["Total"]["UnblendedCost"]["Amount"]) for r in response["ResultsByTime"]
            )
            return {"success": True, "total_usd": round(total, 2), "days": days}
        except Exception as e:
            return {"success": False, "error": str(e), "simulated": True, "total_usd": 0}

    async def list_resources(self) -> dict:
        ec2 = await self.list_ec2("us-east-1")
        s3 = await self.list_s3_buckets()
        return {
            "connected": self._connected,
            "account_id": self._account_id,
            "ec2": ec2,
            "s3": s3,
        }

# ── Singleton instance ─────────────────────────────────────────────────────────
aws_connector = AWSConnector()
