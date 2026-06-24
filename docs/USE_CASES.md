# DeepAgent — Use Cases

> Concrete things a user can say to the agent, organized by what's possible today vs. what each implementation phase unlocks. Pair this with `IMPLEMENTATION_PLAN.md`.

## How to read this

- ✅ — **Works today** (just `list_project_repos` + `read_github_file`)
- 🚧 P2 — **After Phase 2** (Kubernetes deploy + write tools)
- 🚧 P3 — **After Phase 3** (Terraform + state backend)
- 🚧 P4 — **After Phase 4** (sandboxed exec)

---

## 1. By capability

### 1.1 Code understanding ✅

- "What repos are in this project?"
- "Summarize the README of `acme/api`"
- "Explain the architecture from `acme/api/src/index.ts`"
- "What language and framework does `acme/web` use?"
- "Find the database schema in `acme/api/prisma/schema.prisma` and list all tables"
- "Read the Dockerfile and tell me what's wrong"

### 1.2 Code review (read-only) ✅

- "Read `acme/api/package.json` — are any dependencies out of date?"
- "Read `acme/infra/main.tf` and flag security risks"
- "Compare the auth flow in `acme/web/src/auth.ts` vs `acme/mobile/src/auth.ts`"
- "Read the env vars in `.env.example` — which look like secrets in plaintext?"

### 1.3 Documentation ✅

- "Read all the README files and write a one-pager about this project"
- "Read `acme/api/src/routes/` and generate OpenAPI docs"
- "Create a CONTRIBUTING.md based on what you see in the repo"
- "Generate a Mermaid diagram of the project's data flow"

### 1.4 Debugging help (read-only) ✅

- "I'm getting `ECONNREFUSED` from `acme/api` — read the config and tell me where it's pointing"
- "Read the GitHub Actions in `.github/workflows` and explain why deploys are failing"
- "Read the package.json scripts — which one runs migrations?"

### 1.5 Architecture questions ✅

- "Which of my services would Redis help with?"
- "If I add a search feature, which repo should it go in?"
- "What's the data flow when a user signs up?"

---

## 2. Deploy flow 🚧 P2

- "Deploy `acme/api` to release"
- "Roll back `acme/api` on beta to the previous version"
- "Scale `acme/web` to 6 replicas"
- "Add `REDIS_URL=redis://...` env var to `acme/api` in alpha"
- "Deploy the latest main of all services to beta"
- "Promote what's in beta to release"

## 3. Helm chart authoring 🚧 P2

- "Add a Helm chart to `acme/api` — it's a Node service on port 3000"
- "Update the chart values for `acme/api` to use 1 CPU and 2GB RAM"
- "Add an Ingress rule routing `api.acme.com` to the api service"
- "Add a CronJob for the nightly cleanup"
- "Set up a horizontal pod autoscaler for `acme/web`"

## 4. Live cluster debugging 🚧 P2

- "What's wrong with the api deployment in release?"
- "Show me the logs from the failing pod"
- "Why is the `api-7d5b9c` pod in CrashLoopBackOff?"
- "Is my CPU usage near the limit?"
- "Which deployments don't have resource requests set?"
- "List all pods that have restarted more than 3 times today"

## 5. Day-2 operations 🚧 P2

- "Restart the api deployment without changing the image"
- "Drain node `ip-10-0-1-42` — I need to remove it"
- "Apply this manifest" (user pastes YAML, agent kubectl applies)
- "Compare my dev and prod ConfigMaps — what's different?"
- "Cordon all nodes in az us-east-1a"

## 6. Incident response 🚧 P2

- "API latency just spiked — find me the culprit"
- "Show me the last 3 deploys and their commit messages"
- "Roll back everything that deployed today"
- "Page everyone — release is down"
- "Diff the last successful deploy with the current failing one"

## 7. CI/CD 🚧 P2

- "Add a GitHub Actions workflow that runs tests on every PR"
- "Why is the CI failing on `acme/web` PR #42?"
- "Set up auto-deploy from main → alpha"
- "Add a check that blocks merging if test coverage drops"

---

## 8. Infrastructure provisioning 🚧 P3

- "Spin up a Postgres database for `acme/api`"
- "Add Redis ElastiCache to release"
- "I need an S3 bucket for user uploads — make it private"
- "Create an SQS queue between `acme/api` and `acme/worker`"
- "Add a CloudFront CDN in front of `acme/web`"
- "Set up SES for sending emails"

## 9. Cluster management 🚧 P3

- "Increase the EKS node count from 3 to 6"
- "Add a separate node pool for GPU workloads"
- "Migrate alpha to a different region — us-east-1 → us-west-2"
- "Upgrade my EKS cluster from 1.27 to 1.30"

## 10. Networking 🚧 P3

- "Add a VPC peering between this project's VPC and our internal one"
- "Restrict the RDS security group — only the api pods should access it"
- "Set up a Route53 alias for `api.acme.com` pointing at the ALB"
- "Add a NAT gateway so private subnets can pull container images"

## 11. Security 🚧 P3

- "Audit all IAM roles in this project — flag overly permissive ones"
- "Rotate the database password and update the secret"
- "Enable encryption at rest on all S3 buckets"
- "Find any security group rule open to 0.0.0.0/0"

## 12. Migration / refactor 🚧 P3

- "Move the api from EC2 to EKS"
- "Switch from ELB classic to ALB"
- "Convert manual resources to managed ones — import what you find"
- "Move our Postgres from RDS to Aurora"

## 13. Disaster recovery 🚧 P3

- "Set up RDS automated backups with 14-day retention"
- "Create a runbook for restoring the database"
- "What's our RTO for the api service?"
- "Test the restore by spinning up a parallel env from yesterday's snapshot"

---

## 14. Multi-customer support 🚧 P4

- Run the agent for Customer A and Customer B on the same DeepAgent install — secrets stay isolated.
- Self-service onboarding: customer signs up, connects GitHub + AWS, agent provisions everything for them.

## 15. Sensitive workflows 🚧 P4

- "Decrypt the production secrets and update them" — runs in sandbox, credentials never leave
- "Run `terraform apply` on prod" — sandbox enforces resource limits + audit trail
- "Rotate the IAM access keys without downtime"

---

## 16. By user role

### Solo dev / indie hacker
- "Set up everything for my new SaaS — repo + cluster + DB + CDN" (one prompt, full stack)
- "Deploy this side project for me"
- "Why is my $40/month AWS bill suddenly $400?"

### Startup CTO (2-10 engineers)
- "Onboard new hires automatically"
- "Standardize deploys across the team"
- "Handle out-of-hours rollbacks safely"
- "Write a postmortem for last night's incident"

### Mid-size engineering team (50+)
- Code reviews at PR time (catches stuff humans miss)
- Cost optimization at scale (idle resource cleanup)
- Cross-team architecture queries
- Tracking who deployed what when

### Platform / DevOps team
- Self-service for app devs (without filing tickets)
- Standardized golden paths
- Audit logs of every infra change
- Drift detection across all envs

### Enterprise / regulated
- Approval gates on every prod change
- Compliance evidence (SOC2, ISO27001)
- Drift detection + auto-remediation
- Quarterly access reviews

---

## 17. Cost & FinOps

- ✅ "Read my terraform — guess my monthly AWS bill"
- 🚧 P2 "Find idle pods that haven't received traffic in a week"
- 🚧 P3 "Suggest cheaper instance types for non-prod"
- 🚧 P3 "Set up budget alerts at $5k / month"
- 🚧 P3 "Why is my AWS bill 30% higher this month?"

---

## 18. Security & compliance

- ✅ "Read all `.env.example` files — flag plaintext secrets"
- ✅ "Read `terraform/main.tf` — find unencrypted buckets"
- 🚧 P2 "Audit who has access to prod"
- 🚧 P2 "Find secrets committed to git history"
- 🚧 P3 "Generate a SOC2 evidence pack"
- 🚧 P3 "Check if any service is missing TLS"

---

## 19. Onboarding

- ✅ "I'm new — give me a tour of this project"
- ✅ "Where do I start contributing to `acme/api`?"
- ✅ "Set up my dev environment — what do I need?"
- 🚧 P2 "Spin me up a personal dev namespace in the cluster"

---

## 20. Documentation

- ✅ Architecture diagrams (Mermaid)
- ✅ API docs
- 🚧 P2 Runbooks (with real cluster context)
- 🚧 P3 Postmortems (with actual infra state at time of incident)

---

## 21. Killer demos

If you had to show DeepAgent in 30 seconds, use these:

1. **"Add Redis to my API and ship it"** → agent writes Terraform, opens PR, applies, updates Helm values, rolls out, posts status. One prompt, full stack.
2. **"Why is the api down?"** → agent reads logs, finds the bad commit, rolls back, posts in chat.
3. **"My AWS bill jumped — find the culprit"** → agent reads CostExplorer, identifies the rogue resource, suggests fix.
4. **"Review this PR"** → agent reads the diff, runs lint/tests in sandbox, posts review comments.
5. **"Onboard me to this project"** → 60-second tour of repos, envs, current state.

---

## 22. Tool coverage matrix

What each use case needs in terms of tools:

| Use case | `read_github_file` | `list_project_repos` | `write_repo_file` | `kubectl_*` | `helm_*` | `terraform_*` |
|---|---|---|---|---|---|---|
| Code understanding | ✅ | ✅ | ✗ | ✗ | ✗ | ✗ |
| Code review (read-only) | ✅ | ✅ | ✗ | ✗ | ✗ | ✗ |
| Doc generation | ✅ | ✅ | ✗ | ✗ | ✗ | ✗ |
| Doc generation + commit | ✅ | ✅ | ✅ | ✗ | ✗ | ✗ |
| Helm chart authoring | ✅ | ✅ | ✅ | ✗ | ✗ | ✗ |
| Deploy app to k8s | ✗ | ✅ | ✗ | ✅ | ✅ | ✗ |
| Live cluster debugging | ✗ | ✗ | ✗ | ✅ | ✗ | ✗ |
| Rollback | ✗ | ✅ | ✗ | ✅ | ✅ | ✗ |
| New cloud resource | ✅ | ✅ | ✅ | ✗ | ✗ | ✅ |
| Cluster create / scale | ✗ | ✗ | ✅ | ✗ | ✗ | ✅ |
| Security audit (read) | ✅ | ✅ | ✗ | ✅ | ✗ | ✅ |

---

## 23. Anti-use-cases (intentionally not supported)

Things DeepAgent should refuse or redirect:

- **Personal repos not attached to the project** → already enforced server-side in `read_github_file`.
- **Cross-project data access** → tools scope to `ctx.projectId` only.
- **Database-level mutations** (`DROP TABLE`, etc.) outside of migrations → too easy to misuse via prompt injection.
- **Force-pushes to default branches** → require manual override.
- **Disabling audit logs** → never.

---

## 24. Open use cases to prioritize

If forced to pick three use cases to nail first:

1. **"Read X and explain Y"** — already works. Polish: streaming + markdown ✅
2. **"Deploy X to env Y"** — P2 critical path. Single demo unlocks ~60% of value prop.
3. **"Add cloud resource Z"** — P3 critical path. Unlocks the rest.

Other features (cost, security, compliance) come naturally as side effects once these three are solid.

---

## 25. Next conversation

When picking the first use case to build:

- Want a **deploy-focused** start? Build Phase 1 + Phase 2.
- Want an **infra-focused** start? Same Phase 1, then skip 2, go to 3 (you can deploy manually meanwhile).
- Want a **debug-focused** start? Phase 1 + just the read-only k8s tools (`list_kubernetes_resources`, `get_kubernetes_logs`) — no Helm needed.

Pick the one that matches your customers' loudest pain.
