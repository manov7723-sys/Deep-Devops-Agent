# DeepAgent — Terraform + Kubernetes Implementation Plan

> Living document. Update as decisions are made. Mark phases as done with ✅.

## 1. Vision

```
User: "Add a Postgres database and deploy my API to release"
        │
        ▼
Agent reads code → generates Terraform for RDS → runs plan
        │
        ▼  (human approves)
        │
Agent applies Terraform → captures DB endpoint
        │
        ▼
Agent builds Docker image → pushes to ECR → deploys via Helm to EKS
        │
        ▼
Pipeline status visible in DeepAgent UI with live logs
```

One natural-language request → infra changes + app deploy + approval gate, end to end.

---

## 2. Current state

### What's already built ✅

- Agent runtime: Anthropic / OpenAI / Groq streaming with tool use
- Two tools wired: `list_project_repos`, `read_github_file`
- OAuth token resolution per-repo (`resolveTokenForRepo`)
- Schema models: `Project`, `Env`, `Repo`, `Pipeline`, `Deployment`, `ManagedResource`, `CloudProvider`, `Approval`
- Encrypted credential storage: `CloudProvider.credentialsRef`, `OAuthAccount.accessTokenRef`
- Approval gate UI + DB rows
- Pipeline UI + DB rows (mocked stages)
- Multi-account GitHub support (Phase A/B/C of the OAuth work)
- Cost endpoints, observability endpoints
- Admin UI for models, agents, OAuth providers, branding

### What's missing ❌

- A **runner** that actually executes commands (no real `git clone`, `terraform`, `kubectl` happens yet)
- Tools for **writing** files / opening PRs
- Tools for **running shell commands** in a sandbox
- Terraform **state backend** bootstrap
- **Helm chart** scaffold + deployment
- Per-stage **PipelineStage** rows + live log streaming
- Actual cloud SDK calls (AWS / GCP / Azure)

---

## 3. Decisions to make first

Settle these before writing code. Each affects the architecture significantly.

### D1 — Where Terraform code lives

| Option | Pros | Cons |
|---|---|---|
| In the customer's app repo `/terraform/` | One repo to track | Mixes infra + app; junior devs see scary HCL |
| **In a sibling `<slug>-infra` repo (recommended)** | Clean separation; agent can refactor freely | Two repos to track |

**Default**: sibling repo. DeepAgent creates `<owner>/<slug>-infra` on first Terraform use.

### D2 — Where Terraform state lives

| Option | Pros | Cons |
|---|---|---|
| **Self-operated S3+DynamoDB per project (recommended)** | Own the experience end-to-end; no extra vendor | Operator burden |
| Terraform Cloud / Spacelift | Off-the-shelf, polished UI | Vendor lock-in; per-seat cost |
| Customer brings their own backend | Maximum flexibility | Worst UX for first-time users |

**Default**: self-operated S3 + DynamoDB. One bucket per project, named `deepagent-tfstate-<projectId>`.

### D3 — Helm chart authoring

| Option | Pros | Cons |
|---|---|---|
| Agent generates from scratch each deploy | Maximum flexibility | Hallucinates, repetitive |
| **DeepAgent ships a template, agent edits `values.yaml` (recommended)** | Reliable; safe defaults | Less expressive |
| Customer brings their own chart | Power-user friendly | Bad UX for first-time |

**Default**: template chart scaffolded into the repo on first deploy. Agent only edits `values.yaml` thereafter.

### D4 — Cluster provisioning

| Option | Pros | Cons |
|---|---|---|
| **Customer brings kubeconfig (recommended v1)** | Ships fast; customer keeps control | Customer has to create cluster manually |
| DeepAgent provisions EKS per env | Best UX | Expensive; long Phase 3 |
| Shared multi-tenant cluster | Cheapest infra | Namespace isolation hard to do safely |

**Default**: BYO cluster for v1. Add EKS provisioning in Phase 3.

### D5 — Image registry

| Option | Recommended for |
|---|---|
| **ECR / GCR per project (recommended)** | AWS path |
| GHCR / Docker Hub (BYO) | Customer-self-managed |
| DeepAgent-hosted | Skip — out of scope |

**Default**: ECR repo provisioned alongside the cluster via Terraform.

---

## 4. Phased roadmap

### Phase 1 — Foundation (3-4 days)

> Goal: agent can execute commands on behalf of the user. No real Terraform yet.

#### 1.1 Schema additions

```prisma
model Env {
  // existing fields...
  kubeconfigRef    String?   // encrypted kubeconfig
  namespace        String    @default("default")
  tfBackendBucket  String?
  tfBackendRegion  String?
  tfBackendTable   String?
}

model PipelineStage {
  id         String      @id @default(uuid(7)) @db.Uuid
  pipelineId String      @db.Uuid
  ordinal    Int
  name       String      // "clone" | "tf-plan" | "tf-apply" | "build" | "deploy" | "verify"
  status     StageStatus @default(pending)
  startedAt  DateTime?
  finishedAt DateTime?
  logs       String      @default("")  // last 32KB stdout+stderr
  exitCode   Int?
  pipeline   Pipeline    @relation(fields: [pipelineId], references: [id], onDelete: Cascade)
  @@index([pipelineId, ordinal])
}

enum StageStatus { pending running success failed skipped }
```

#### 1.2 Runner primitive

**File**: `src/lib/runner/exec.ts`

```ts
export async function runStage(args: {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  onLog?: (chunk: string) => void;
  timeoutMs?: number;
}): Promise<{ exitCode: number; stdout: string; stderr: string }>;
```

v1: `child_process.spawn` on the same host. Docker isolation = Phase 4.

#### 1.3 Credential resolvers

**File**: `src/lib/runner/creds.ts`

```ts
getDecryptedCloudCreds(cloudProviderId): Promise<Record<string, string>>;
getKubeconfigPath(envId): Promise<string>;  // writes to tmpfile, returns path
```

#### 1.4 UI changes

- Env settings modal → textarea for kubeconfig + namespace input.
- "Verify cluster" button: kicks off `kubectl --kubeconfig=… get nodes`, surfaces result in UI.

#### Milestone

Paste a kubeconfig in the env settings → click "Verify cluster" → see node list in the UI. Proves the runner works end-to-end.

---

### Phase 2 — Kubernetes deploys (1 week)

> Goal: deploy a real app to a real cluster via Helm, from the chat.

#### 2.1 Helm chart template

**Location**: `src/lib/scaffolds/helm-service/`

```
chart/
  Chart.yaml
  values.yaml          ← image.tag, env vars, replicas
  templates/
    deployment.yaml
    service.yaml
    ingress.yaml       ← optional via values
    _helpers.tpl
```

Committed to the user's repo on first deploy via PR.

#### 2.2 New agent tools

```ts
list_files_in_repo({ repoFullName, path? })
write_repo_file({ repoFullName, path, content, message })  // opens a PR
list_kubernetes_resources({ envKey, kind, namespace? })
get_kubernetes_logs({ envKey, podName, namespace?, lines? })
run_helm_upgrade({ envKey, repoFullName, chartPath, valuesOverrides })
```

#### 2.3 Pipeline executor

**File**: `src/lib/pipeline/run.ts`

```
Stage 1: clone repos (using resolveTokenForRepo)
Stage 2: docker build + push to registry
Stage 3: helm upgrade --install
Stage 4: kubectl rollout status
```

Each stage writes to `PipelineStage`. UI streams via SSE.

#### 2.4 Trigger from chat

User says "deploy `acme/api` to release" → agent calls `run_helm_upgrade` tool → pipeline starts.

#### Milestone

User clicks "Deploy" in the chat. Real image lands on the real cluster. Pods come up. Logs stream live in the UI.

---

### Phase 3 — Terraform infrastructure (1-2 weeks)

> Goal: provision real infra. RDS, ECR, EKS, etc.

#### 3.1 State backend bootstrap

On first Terraform run per project:

1. Use AWS creds to create `S3 bucket: deepagent-tfstate-<projectId>` + `DynamoDB table: deepagent-tflocks-<projectId>`.
2. Save bucket/region/table to `Env.tfBackendBucket` etc.
3. Subsequent runs reference this backend in their HCL.

#### 3.2 Terraform code in a sibling repo

For each project on first Terraform use:

- GitHub API: create `<owner>/<slug>-infra` repo.
- Commit a minimal `main.tf` with the backend block.
- Save as `Repo { kind: "Terraform" }` attached to project.

#### 3.3 New agent tools

```ts
write_terraform_file({ repoFullName, path, content })
run_terraform_plan({ envKey, repoFullName, workingDir? })
run_terraform_apply({ envKey, repoFullName, workingDir?, planFile })
get_terraform_output({ envKey, repoFullName, name })
```

#### 3.4 Module library

Pre-write reusable Terraform modules in `src/lib/scaffolds/terraform-modules/`:

- `eks-cluster/` — small EKS cluster
- `rds-postgres/` — RDS Postgres instance
- `ecr-repo/` — container registry
- `vpc/` — basic VPC
- `s3-bucket/` — private bucket with sane defaults

Agent calls `write_terraform_file` to wire modules in `main.tf`.

#### 3.5 Approval gate integration

After `terraform plan`:

1. Parse plan output (count of adds/changes/destroys).
2. Create an `Approval` row with the plan as the diff.
3. Pipeline waits — UI shows "Awaiting approval".
4. Once approved, the pipeline runs `terraform apply`.

#### Milestone

User says "add a Postgres database" → agent generates HCL → opens PR → approval → apply → DB exists → agent captures `db_endpoint` output and updates the Helm values automatically.

---

### Phase 4 — Sandbox + safety (1 week)

> Goal: production-safe execution. Suitable for multi-customer deployments.

#### 4.1 Docker isolation

Replace `child_process.spawn` with `docker run --rm` inside a `deepagent/runner:latest` image preloaded with:

- `terraform`, `kubectl`, `helm`, `git`
- `aws-cli`, `gcloud`, `az`
- `docker-cli`

Mount tmpfs workspace, inject env vars, kill on timeout.

#### 4.2 Per-task secrets injection

Sandbox never sees the global `.env` — only the specific creds for the project + repo it's working on.

#### 4.3 Network policy

Sandbox can only reach:

- `api.github.com`
- the project's cloud APIs (AWS / GCP / Azure)
- the project's k8s API server

No general internet.

#### 4.4 Resource limits

- 2 CPU cgroup
- 4GB RAM
- 5-minute timeout per stage
- Kill at timeout

#### Milestone

Safe to expose to multiple customers on shared infra.

---

### Phase 5 — Polish + UX (ongoing)

Things that make it good, not just functional.

- Live log streaming per stage (SSE from server, virtual-scroll in UI)
- Rollback button on `Deployment` rows → reapplies previous SHA via Helm
- Cost estimation on Terraform plans (using `infracost`)
- Multi-region deploys
- Per-env approval rules (auto-approve alpha, gate beta + release)
- GitOps mode — agent only opens PRs, never applies directly
- Drift detection — periodic refresh, alert on unexpected changes
- Plan summarization — pretty-print + cost delta in the approval card
- Slack / PagerDuty integration on pipeline failures

---

## 5. What to skip in v1

| Skip | Why |
|---|---|
| Multi-cloud at the same time | Pick AWS only. GCP/Azure later. |
| Customer-self-hosted runner | One platform-managed runner is enough. Enterprise feature later. |
| Pulumi / CDK | Stick with Terraform HCL — simpler for the LLM. |
| Service mesh / Istio | Not needed for v1 deploys. |
| GitOps full (ArgoCD/Flux) | Direct `kubectl apply` is fine until scale demands GitOps. |
| Real-time billing API | Use the existing cost synthesizer; live billing later. |
| Drift detection | Important eventually, complex to do well — skip until customers ask. |
| OPA / policy-as-code | Add after first compliance-conscious customer asks. |

---

## 6. Timeline

| Phase | Outcome | Effort (one dev) |
|---|---|---|
| 1 | Runner + kubeconfig paste + stage UI | 3-4 days |
| 2 | Real Helm deploys to existing cluster | 1 week |
| 3 | Real Terraform provisioning + approval | 1-2 weeks |
| 4 | Sandboxed execution | 1 week |
| 5 | Polish | ongoing |

**4-5 weeks** from "agent chats" to "agent provisions infra and deploys apps end-to-end" on AWS for one customer.

---

## 7. Immediate next steps

If starting tomorrow, build in this order:

1. **`PipelineStage` model + `Env.kubeconfigRef`** — schema only, 1 hour.
2. **Runner primitive** (`src/lib/runner/exec.ts`) — 2 hours.
3. **"Verify cluster" button** on Env settings → runs `kubectl get nodes` → result in UI. Proves the runner works end-to-end.
4. **Two new tools** — `list_kubernetes_resources` + `get_kubernetes_logs`. Agent helps debug clusters.
5. **Helm chart template** + `run_helm_upgrade` tool — actual deploys.

After that, you have a working "deploy app to my cluster via chat" demo. Terraform comes after.

---

## 8. Open questions

- [ ] Which AWS regions to support out of the box? (default `us-east-1`?)
- [ ] What's the IAM policy DeepAgent needs from the customer? (minimal vs. admin)
- [ ] How are GitHub PRs signed / branded? (DeepAgent bot user vs. user's own GH identity)
- [ ] Where does the runner's Docker image live? (DockerHub? GHCR under DeepAgent's org?)
- [ ] Cost ceiling per pipeline run? (kill at $X / 1M tokens / minutes spent)

---

## 9. Glossary

- **Runner** — server process that executes shell commands (terraform, kubectl, helm) on behalf of the agent.
- **Sandbox** — isolated environment (Docker container in Phase 4) where the runner executes.
- **State backend** — where Terraform persists `terraform.tfstate`. We use S3 + DynamoDB locking.
- **Helm chart** — packaged Kubernetes manifests with templated values.
- **Approval gate** — a `Pipeline` step that pauses until a human approves the `Approval` row.
- **Tool** — a function Claude/GPT can call (`list_project_repos`, `read_github_file`, future `run_terraform_apply`).
- **PipelineStage** — one step of a pipeline (clone, build, plan, apply, deploy, verify). Multiple per Pipeline.
