# DevOps Agent — Backend

AWS-only DevOps automation backend (FastAPI + LangGraph + MCP). Generates
Terraform, pushes it to GitHub, provisions EKS, and manages Kubernetes — driven
from chat. Credentials are resolved from HashiCorp Vault; infrastructure is
applied with the AWS access key + secret.

## Structure

```
backend/
  main.py                  # uvicorn entrypoint  (uvicorn main:app)
  requirements.txt
  Dockerfile
  app/
    factory.py             # create_app() — FastAPI app + router wiring + lifespan
    agent.py               # LangGraph agent, MCP wiring, built-in tools
    aws_connector.py       # AWS (boto3) — ECR, OIDC, EC2/S3 helpers
    scheduler.py           # APScheduler task scheduler
    core/
      vault.py             # HashiCorp Vault client (AWS creds)
    routers/               # FastAPI route handlers (the HTTP API)
      onboard.py chat.py github.py vault.py aws.py
      config.py terraform.py scheduler.py eks.py
    mcp_servers/           # MCP server configs: github, terraform,
                           #   kubernetes, prometheus, grafana
    prompts/
      system_prompt.py     # the agent system prompt (AWS-only)
    services/              # deterministic infra generators
      blueprint_engine.py      # render KB blueprints -> Terraform
      composition_engine.py    # compose multi-resource architectures
      containerize.py          # analyze repo + Dockerfile + ECR CI
      eks_modules.py           # production EKS module tree
      eks_terraform.py
      k8s_manifests.py         # Kubernetes manifests
      tf_async.py              # background terraform apply
      knowledge_base/          # the KNOWLEDGE BASE (data, not code)
        eks.yaml ec2.yaml s3.yaml     # resource blueprints (wizard questions)
        modules/*.yaml                 # 20 validated architecture modules
```

## Run

```bash
python -m venv venv && source venv/bin/activate
pip install -r requirements.txt
cp .env.example .env        # fill in your keys
python -m uvicorn main:app --host 0.0.0.0 --port 8000
```

## Active MCP servers

`github`, `terraform`, `kubernetes`, `prometheus`, `grafana`.
AWS infrastructure is provisioned through Terraform using the access key +
secret (resolved from Vault). The AWS/GCP/Azure provider MCP servers were removed.
