# Reference Codebase Analysis — `devops-agent-github-app-v2`

> Living document. Updated when we revisit the reference for new patterns.
> Pair with `IMPLEMENTATION_PLAN.md` (our roadmap) and `USE_CASES.md` (what we ship to users).

---

## 1. About the reference

| Field | Value |
|---|---|
| Source | `devops-agent-github-app-v2 7.zip` (extracted under `devops-agent-github-app-v2 3/`) |
| Stack | Python (FastAPI) backend + React frontend |
| Agent | LangGraph + OpenAI gpt-4o (also supports Groq llama-3.3-70b) |
| Total code | ~5,500 lines Python |
| Target | **Single-user**, single cluster, single state bucket |
| License | (check the repo before adopting code verbatim) |

The reference is a working prototype optimized for **one developer / one customer**. DeepAgent is **multi-tenant SaaS**. Most patterns are usable; specific implementations need re-architecting for multi-tenancy.

---

## 2. File-by-file map

| File | Lines | Role |
|---|---|---|
| `agent.py` | 1,740 | Main agent — ~25 `@tool` decorated functions, LangGraph state machine, MCP wiring |
| `aws_connector.py` | 531 | AWS SDK wrapper for live calls (EC2, S3, IAM, etc.) |
| `eks_modules.py` | 522 | **Production-grade Terraform module tree generator** ★ HIGH VALUE |
| `gcp_connector.py` | 511 | GCP SDK wrapper |
| `azure_connector.py` | 507 | Azure SDK wrapper |
| `containerize.py` | 482 | **Dockerfile + GitHub Actions OIDC + ECR generator** ★ HIGH VALUE |
| `tf_async.py` | 252 | **Background terraform runner with stage tracking** ★ HIGH VALUE |
| `k8s_manifests.py` | 241 | **Deterministic K8s YAML generator** ★ MEDIUM (we use Helm instead) |
| `scheduler.py` | 190 | Cron-like task scheduler |
| `composition_engine.py` | 162 | Architecture composition (multi-resource blueprints) |
| `blueprint_engine.py` | 144 | Pre-built blueprints (e.g. "Node + Postgres + Redis") |
| `eks_terraform.py` | 94 | Simpler single-file EKS HCL (older / fallback path) |
| `app.py` / `main.py` | 153 | FastAPI bootstrap |
| `mcp_servers/*` | ~200 | One file per MCP server (aws, k8s, terraform, github, prometheus, grafana, gcp, azure) |
| `prompts/` | ? | System prompt templates |
| `knowledge_base/` | ? | RAG documents (presumably for the agent's context) |
| `core/` | ? | Shared helpers |

---

## 3. The agent's tool catalog

The reference exposes ~25 tools via Python's `@tool` decorator. Grouped:

### Terraform
```python
terraform_apply_with_creds(tf_content, aws_key, aws_secret, region)
terraform_destroy_with_creds(instance_id, region)
terraform_apply_gcp(tf_content)
terraform_apply_azure(tf_content)
```

### AWS-specific
```python
aws_action(action, resource, ...)            # generic AWS ops
cloudwatch_apply_alarms(instance_id, region, metrics_json)
cloudwatch_terraform_snippet(instance_name, ec2_resource_name, metrics_json)
```

### Containerize
```python
analyze_app_repo(owner, repo, branch="")          # detects Node/Python/Go/Java
generate_dockerfile(profile_json)                 # writes Dockerfile content
containerize_app(owner, repo, setup_ci=False)     # combines analyze + dockerfile
setup_ecr_ci(owner, repo, ecr_repo="")            # GitHub Actions OIDC → ECR
```

### EKS
```python
create_eks(name, environment="dev", region="us-east-1", k8s_version="1.30",
           instance_type="t3.medium", desired_nodes=2, ...)
check_eks_status(job_id)                          # polls background apply
connect_eks_kubeconfig(cluster_name, region)      # runs `aws eks update-kubeconfig`
```

### Kubernetes
```python
create_k8s_app(app_name, image, port=80, kind="Deployment", namespace="default",
               replicas=2, service_type="ClusterIP", with_rbac=False, ...)
kubectl_action(action, resource="", name="", namespace="", ...)   # get|describe|delete|logs|scale|rollout
```

### Architecture
```python
compose_architecture(spec)              # high-level resource composition
create_from_blueprint(resource, answers)
```

### Scheduling
```python
schedule_task(command, schedule_time, task_name="")
list_scheduled_tasks()
cancel_scheduled_task(job_id)
```

### Misc
```python
get_vault_credentials()                 # internal Vault.py
get_mcp_server_status()                 # which MCP servers active
```

**Tool grouping** is by cloud — agent only loads `AWS_BUILTINS` when user is in AWS context (saves tokens on free-tier LLMs).

---

## 4. Architecture patterns — the actual gold

### Pattern 1: Deterministic generators (NO LLM hand-writes HCL/YAML)

The agent NEVER hand-writes Terraform or Kubernetes manifests. Instead, Python functions emit them deterministically:

```python
# agent.py
@tool
async def create_k8s_app(app_name, image, ...):
    import k8s_manifests as K
    files = K.build_manifests(app_name, image, ...)
    # files = {"k8s/<app>/deployment.yaml": "...", "k8s/<app>/service.yaml": "...", ...}
    Cz.gh_put_tree(owner, repo, files, "Add K8s manifests for <app>")
```

```python
# k8s_manifests.py
def _workload(kind, app, ns, image, port, replicas, ...):
    return f"""apiVersion: apps/v1
kind: {kind}
metadata:
  name: {app}
  namespace: {ns}
...
"""

def build_manifests(app_name, image, port=80, kind="Deployment", ...) -> dict:
    files = {}
    files[f"k8s/{app_name}/deployment.yaml"] = _workload(kind, app_name, ...)
    files[f"k8s/{app_name}/service.yaml"] = _service(app_name, ...)
    # etc — Namespace, RBAC, ConfigMap, Secret, Ingress, HPA, all conditional
    return files
```

**Why it's good:**
- Reproducible (no LLM hallucination)
- Cheap (no tokens spent on YAML)
- Auditable (templates are reviewable code)
- Tested (you can unit-test the generator)

**Our equivalent:** `src/lib/scaffolds/helm-service/` — a Helm chart template. Same idea, fewer files (Helm handles the conditionals via values).

### Pattern 2: Background long-running jobs with stage tracking

`tf_async.py` runs terraform in a Python thread, tracks `init → plan → apply` as separate stages:

```python
# tf_async.py
_JOBS = {}  # in-memory: job_id -> {status, stages, output, returncode}

def _new_stages():
    return [
        {"name": "init", "status": "pending", "output": ""},
        {"name": "plan", "status": "pending", "output": ""},
        {"name": "apply", "status": "pending", "output": ""},
    ]

def _run_tree(job_id, files, run_subdir, creds, region):
    job = _JOBS[job_id]
    stages = {s["name"]: s for s in job["stages"]}
    # Write files to tmpdir
    # Run init → plan → apply sequentially
    # Update each stage's status + output as it runs
    # On any failure: mark current stage failed, mark job failed

def start_apply_tree(files, run_subdir, creds, region, name) -> str:
    job_id = uuid.uuid4().hex[:8]
    _JOBS[job_id] = {"status": "queued", "stages": _new_stages(), ...}
    threading.Thread(target=_run_tree, args=(job_id, files, ...), daemon=True).start()
    return job_id  # client polls get_status(job_id)
```

**UI side:** frontend polls `get_status(job_id)` every few seconds, renders 3 horizontal bars with status colors (Jenkins-style).

**Our equivalent (planned):** `PipelineStage` DB model (already added in Phase 1.1). We replace `_JOBS` dict with DB rows → survives restarts + multi-tenant + audit. SSE streaming instead of polling.

### Pattern 3: S3 backend injection at runtime

```python
def _backend_snippet(state_key, region):
    bucket = os.getenv("TF_STATE_BUCKET", "")
    if not bucket:
        return ""
    s3_region = os.getenv("TF_STATE_REGION", region)
    return f'''
        backend "s3" {{
            bucket = "{bucket}"
            key    = "{state_key}/terraform.tfstate"
            region = "{s3_region}"
        }}
    '''

def _inject_backend(tf, snippet):
    if "terraform {" in tf:
        return tf.replace("terraform {", "terraform {\n" + snippet, 1)
    return "terraform {\n" + snippet + "}\n\n" + tf
```

Pre-apply, the snippet is spliced into the HCL. Bucket comes from env var — single bucket for all projects.

**Our adaptation:** Per-env `tfBackendBucket / Region / Table` columns (Phase 1.1 schema). On first Terraform use, bootstrap the bucket + DynamoDB lock table for that env. Multi-tenant safe.

### Pattern 4: Cluster connection (`~/.kube/config` approach)

```python
@tool
async def connect_eks_kubeconfig(cluster_name, region="us-east-1"):
    """Run `aws eks update-kubeconfig` so kubectl can reach the cluster."""
    subprocess.run(["aws", "eks", "update-kubeconfig",
                    "--name", cluster_name, "--region", region],
                   env={**AWS_creds, ...})
    # Result: ~/.kube/config now has the cluster's context
    # The kubernetes MCP server loads lazily once the file exists
```

```python
# mcp_servers/kubernetes_mcp.py
def get_kubernetes_config():
    kubeconfig = os.getenv("KUBECONFIG") or os.path.expanduser("~/.kube/config")
    if not os.path.exists(kubeconfig):
        return {}  # MCP not registered until kubeconfig exists
    return {"kubernetes": {"command": "npx", "args": ["-y", "mcp-server-kubernetes"], ...}}
```

**Limit:** one kubeconfig per server = one cluster per install.

**Our adaptation:** Per-`Env.kubeconfigRef` encrypted blob. Decrypted to tmpfile per stage with mode 0600 (Phase 1.3 `getKubeconfigForEnv`). Cleaned up after each operation. Multi-tenant safe.

### Pattern 5: Containerize flow (Dockerfile + ECR OIDC)

The reference's "killer feature." Takes a raw repo and ships it end-to-end via 3 steps:

```python
# 1. Analyze
@tool
async def analyze_app_repo(owner, repo, branch=""):
    """Inspects package.json/requirements.txt/go.mod/etc., returns stack profile."""
    tree = _list_tree(owner, repo, branch)
    if "package.json" in tree: return {"language": "node", "port": 3000, "build_cmd": "npm run build"}
    if "requirements.txt" in tree: return {"language": "python", "port": 8000, ...}
    # ... go.mod, pom.xml, Gemfile

# 2. Generate Dockerfile
@tool
async def generate_dockerfile(profile_json):
    """Returns templated Dockerfile content per stack."""
    stack = json.loads(profile_json)
    if stack["language"] == "node":
        return NODE_DOCKERFILE_TEMPLATE.format(port=stack["port"])
    # etc

# 3. Set up GitHub Actions for ECR via OIDC
@tool
async def setup_ecr_ci(owner, repo, ecr_repo=""):
    """Generates .github/workflows/build.yml using OIDC to assume an IAM role,
       build the image, push to ECR. No stored AWS keys."""
    workflow = ECR_OIDC_WORKFLOW.format(
        ecr_repo=ecr_repo,
        aws_account_id=...,
        role_arn=...,
    )
    Cz.gh_put_tree(owner, repo, {".github/workflows/build.yml": workflow}, ...)
```

**Why it's good:** image build is offloaded to GitHub Actions runners — DeepAgent never builds containers, just consumes the resulting image tag.

**Adoption priority:** **HIGH.** Closes the "Deploy any repo end-to-end" use case without us running Docker on our server.

### Pattern 6: Production-grade Terraform layout

`eks_modules.build_eks_module_tree()` emits a real-world layout:

```
terraform/
├── modules/
│   ├── vpc/
│   │   ├── main.tf       (wraps terraform-aws-modules/vpc/aws)
│   │   ├── variables.tf
│   │   └── outputs.tf
│   ├── iam/
│   │   ├── main.tf       (cluster role + node role)
│   │   ├── variables.tf
│   │   └── outputs.tf
│   └── eks/
│       ├── main.tf       (aws_eks_cluster + aws_eks_node_group)
│       ├── variables.tf
│       └── outputs.tf
└── environments/
    ├── dev/
    │   ├── main.tf       (consumes the modules)
    │   ├── providers.tf
    │   ├── variables.tf
    │   ├── terraform.tfvars
    │   └── backend.tf    (S3 + DynamoDB lock)
    ├── staging/
    │   └── ... (same shape)
    └── prod/
        └── ... (same shape)
```

Per-env runs work like:
```bash
cd terraform/environments/dev
terraform init && terraform apply
```

**Adoption priority:** **HIGH for Phase 3.** Port the layout + module contents verbatim into `src/lib/scaffolds/terraform-modules/eks-cluster/`. Translate Python f-strings to TS template literals.

### Pattern 7: MCP servers as side processes

The agent uses HashiCorp's, Anthropic's, and community MCP servers:

```python
# mcp_servers/terraform_mcp.py
def get_terraform_config(aws_env):
    if not os.getenv("ENABLE_TERRAFORM_MCP", "").lower() == "true":
        return {}
    return {
        "terraform": {
            "command": "docker",
            "args": ["run", "-i", "--rm", "hashicorp/terraform-mcp-server"],
            "env": {**aws_env},
            "transport": "stdio",
        }
    }

# mcp_servers/kubernetes_mcp.py
def get_kubernetes_config():
    # Returns {} until kubeconfig exists — lazy registration
    if not os.path.exists(kubeconfig):
        return {}
    return {"kubernetes": {"command": "npx", "args": ["-y", "mcp-server-kubernetes"], ...}}
```

LangGraph reads tools from all active MCP servers + the agent's own `@tool` builtins, then offers them to the LLM.

**Adoption priority:** **SKIP.** MCP servers spawn subprocesses with broad cluster/cloud access. For multi-tenant DeepAgent, this is a security risk — they're not scoped by project. We get the same outcomes from hand-written, project-scoped tools.

### Pattern 8: PATH fallback for macOS/IDE-launched servers

```python
_TF_BIN_DIRS = ["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin"]

def _with_tf_path(env):
    env = dict(env)
    parts = (env.get("PATH") or os.environ.get("PATH", "")).split(os.pathsep)
    parts += [d for d in _TF_BIN_DIRS if d not in parts]
    env["PATH"] = os.pathsep.join(p for p in parts if p)
    return env
```

GUI-launched processes on macOS get a stripped PATH that misses Homebrew. This fallback fixes that.

**Adoption priority:** **DO IT NOW** — 5-minute change to `src/lib/runner/exec.ts`.

---

## 5. Comparison — them vs us

| Dimension | Reference (Python) | DeepAgent (TS/Next.js) |
|---|---|---|
| Tenancy | Single user, single org | Multi-tenant SaaS |
| Auth | env vars (`GITHUB_TOKEN`, etc.) | Per-user OAuth, multi-account |
| GitHub creds | One token | Per-user OAuth, per-repo binding |
| State backend | One S3 bucket via env | Per-env S3 + DynamoDB (planned) |
| Cluster | `~/.kube/config` shared | Per-env encrypted kubeconfig |
| Job tracking | In-memory `_JOBS` dict | `PipelineStage` DB rows |
| Audit | print() to stdout | `AuditLog` table |
| Approval gates | None | `Approval` table + UI |
| Tool surface | MCP servers + builtins | Hand-written, project-scoped tools |
| Frontend | Single-file React | Next.js 16 + React 19 + Tailwind |
| Streaming | Polling | SSE token-by-token |
| Markdown | Plain text | Full markdown + syntax highlighting |
| RBAC | None | Owner/developer/viewer roles |
| Billing | None | Stripe integration |
| Cost tracking | None | CostSnapshot model |
| Multi-cloud | Yes (AWS/GCP/Azure connectors) | Schema supports, runtime AWS-only |

---

## 6. Decision matrix — adopt / skip / defer

### ADOPT NOW (quick wins, < 1 day each)

| Pattern | Files to add/edit in DeepAgent | Effort |
|---|---|---|
| PATH fallback for binaries | `src/lib/runner/exec.ts` | 5 min |
| Lazy-hide k8s tools when no kubeconfig | `src/lib/agent/agent.ts` (filter tools) | 15 min |
| Containerize flow (3 tools) | `src/lib/agent/tools/{detect-repo-stack,generate-dockerfile,setup-ecr-workflow}.ts` | 1 day |

### ADOPT SOON (foundational for Phase 2.5+)

| Pattern | Files to add/edit in DeepAgent | Effort |
|---|---|---|
| Background pipeline executor with stage tracking | `src/lib/pipeline/run.ts` (new) + refactor `run_helm_upgrade` | 1-2 days |
| Stage-view UI (3-bar progress) | `src/components/domain/PipelineStagesBar.tsx` (new) | 2-3 hr |
| Pipeline log streaming via SSE | `src/app/api/v1/projects/[slug]/pipelines/[id]/stream/route.ts` (new) | 2-3 hr |

### ADOPT IN PHASE 3 (Terraform work)

| Pattern | Files to add/edit in DeepAgent | Effort |
|---|---|---|
| Production-grade Terraform module tree | `src/lib/scaffolds/terraform-modules/eks-cluster/` (port from `eks_modules.py`) | 1 day |
| S3 + DynamoDB state backend bootstrap | `src/lib/runner/tf-backend.ts` (new) | 4 hr |
| Background terraform apply (init/plan/apply stages) | Reuses #2 background executor + Terraform-specific stage defs | 4 hr |
| `provision_eks_cluster` tool | `src/lib/agent/tools/provision-eks-cluster.ts` (new) | 1 day |

### SKIP — don't adopt

| Pattern | Why skip |
|---|---|
| MCP servers (`mcp-server-kubernetes`, `terraform-mcp-server`) | Broad scope = security risk in multi-tenant. We write our own scoped tools. |
| `GITHUB_TOKEN` env var | We use per-user OAuth properly. |
| `~/.kube/config` shared file | We use per-env encrypted blobs. |
| `TF_STATE_BUCKET` env var | We use per-env state in DB. |
| In-memory `_JOBS` dict | We use DB-backed `PipelineStage` rows. |
| `Vault.py` for credential storage | We have `encryptSecret()`. |
| Cloud-specific tool bundles (`AWS_BUILTINS` etc.) | Only matters on free-tier LLMs. Anthropic/paid OpenAI don't care. |
| Synchronous `_run_terraform_apply` (blocks chat) | We always background long jobs. |

---

## 7. Code snippets we'd port verbatim (with adaptation)

### A. PATH fallback — adapt to TypeScript

```ts
// src/lib/runner/exec.ts — change the env block:
const FALLBACK_PATHS = [
  "/opt/homebrew/bin",
  "/usr/local/bin",
  "/usr/bin",
];

function prependPaths(existingPath: string, fallbacks: string[]): string {
  const parts = existingPath.split(":").filter(Boolean);
  for (const p of fallbacks) {
    if (!parts.includes(p)) parts.push(p);
  }
  return parts.join(":");
}

// inside runStage:
const childEnv = {
  PATH: prependPaths(process.env.PATH ?? "", FALLBACK_PATHS),
  ...(args.env ?? {}),
} as unknown as NodeJS.ProcessEnv;
```

### B. Background job + stage tracking — adapt to DB rows

```ts
// src/lib/pipeline/run.ts (new) — mirrors tf_async._run_tree
import { prisma } from "@/lib/db/prisma";
import { runStage } from "@/lib/runner/exec";

export async function runPipeline(pipelineId: string) {
  const pipeline = await prisma.pipeline.findUnique({
    where: { id: pipelineId },
    include: { env: true, repo: true, stages: { orderBy: { order: "asc" } } },
  });
  if (!pipeline) throw new Error(`pipeline_not_found`);

  for (const stage of pipeline.stages) {
    await prisma.pipelineStage.update({
      where: { id: stage.id },
      data: { status: "run", startedAt: new Date() },
    });

    try {
      const result = await runStage({
        command: stage.label, // simplified
        args: [],
        cwd: process.cwd(),
        env: {},
        onLog: async (chunk) => {
          // Append to DB or write to S3
          await prisma.pipelineStage.update({
            where: { id: stage.id },
            data: { logs: { set: chunk } },
          });
        },
      });
      await prisma.pipelineStage.update({
        where: { id: stage.id },
        data: {
          status: result.exitCode === 0 ? "ok" : "fail",
          exitCode: result.exitCode,
          finishedAt: new Date(),
        },
      });
      if (result.exitCode !== 0) break;
    } catch (err) {
      await prisma.pipelineStage.update({
        where: { id: stage.id },
        data: { status: "fail", finishedAt: new Date() },
      });
      break;
    }
  }
}
```

### C. S3 backend injection — adapt to per-env

```ts
// src/lib/runner/tf-backend.ts (new)
export function makeBackendSnippet(bucket: string, region: string, lockTable: string, stateKey: string): string {
  return `
  backend "s3" {
    bucket         = "${bucket}"
    key            = "${stateKey}/terraform.tfstate"
    region         = "${region}"
    dynamodb_table = "${lockTable}"
    encrypt        = true
  }
`;
}

export function injectBackend(tf: string, snippet: string): string {
  if (tf.includes("terraform {")) {
    return tf.replace("terraform {", `terraform {\n${snippet}`);
  }
  return `terraform {\n${snippet}}\n\n${tf}`;
}
```

### D. Dockerfile templates — port `_dockerfile_for()` Python templates

Their `containerize.py` has Dockerfile templates per stack (Node/Python/Go/Java). Port each as TypeScript template strings into `src/lib/scaffolds/dockerfile-templates.ts`.

---

## 8. Open questions to settle before adopting Phase 3 patterns

- **AWS IAM model:** Reference uses long-lived access keys. We should require an IAM role with STS AssumeRole + ExternalId from day one.
- **Cross-region state:** Reference's bucket is one region. Do we replicate? Or per-env regional?
- **State bucket lifecycle:** When a project is deleted, do we clean up the S3 bucket? (Risk: deleting state = unable to destroy infra.)
- **Default node sizes:** Reference defaults to `t3.medium`. Do we pick instance types based on the env (alpha = cheaper, release = production-grade)?
- **GitHub bot identity for PRs:** Reference commits as the user. We should commit as a clearly-labelled DeepAgent bot.

---

## 9. Estimated effort to reach full reference parity (with our improvements)

Assuming one engineer working alone:

| Phase | Includes | Effort |
|---|---|---|
| Quick wins | PATH fallback + lazy hide + containerize flow | 1-2 days |
| Phase 2.5 | Background pipeline executor + stage UI + SSE logs | 2-3 days |
| Phase 3.1 | S3 backend bootstrap + terraform_apply tool | 2-3 days |
| Phase 3.2 | EKS module tree + `provision_eks_cluster` tool | 2-3 days |
| Phase 3.3 | Approval gate integration before apply | 1 day |
| Phase 3.4 | RDS + ECR module tree | 2-3 days |
| Phase 4 | Docker sandbox isolation | 5 days |

**Total: ~3 weeks of dev work** to be at "reference parity + multi-tenant SaaS."

---

## 10. Next actions

When picking up this doc later, work through in this order:

1. ☐ Adopt PATH fallback (5 min) — `src/lib/runner/exec.ts`
2. ☐ Adopt lazy tool hiding (15 min) — `src/lib/agent/agent.ts`
3. ☐ Port containerize flow (1 day) — 3 new tool files
4. ☐ Build background pipeline executor (1-2 days) — `src/lib/pipeline/run.ts`
5. ☐ Build stage-view UI (2-3 hr) — `PipelineStagesBar.tsx`
6. ☐ Build pipeline SSE log streaming (2-3 hr)
7. ☐ Port `eks_modules.py` to scaffolds (1 day) — `src/lib/scaffolds/terraform-modules/`
8. ☐ Build S3+DynamoDB backend bootstrap (4 hr) — `src/lib/runner/tf-backend.ts`
9. ☐ Build `provision_eks_cluster` tool (1 day)
10. ☐ Wire approval gates into apply flow (1 day)

Tick items as they're completed. Update the estimated effort column with actuals to calibrate.

---

## 11. Glossary

- **MCP** — Model Context Protocol. Anthropic's open spec for tool servers. Used heavily in the reference.
- **OIDC for ECR push** — GitHub Actions assumes an AWS IAM role via OIDC tokens instead of long-lived access keys.
- **Backend block (Terraform)** — the `backend "s3" {}` config that tells Terraform where to store state.
- **Stage tracker** — pattern of breaking a long-running job into named stages (init/plan/apply, clone/build/deploy/verify) with independent statuses.
- **Deterministic generator** — code that emits HCL/YAML from typed inputs, instead of asking the LLM to write it.
- **Lazy MCP loading** — registering an MCP server only when its prerequisites (e.g. `~/.kube/config`) exist. Saves tokens.
