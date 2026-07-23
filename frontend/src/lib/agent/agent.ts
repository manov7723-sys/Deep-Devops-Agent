/**
 * Deep Agent — conversational LLM with tool use.
 *
 * v1 — one Anthropic call per message (runAgentTurn)
 * v2 — streaming via SSE (runAgentTurnStream)
 * v3 — tool-use loop: Claude can call list_project_repos, read_github_file,
 *      etc. The stream keeps running across multiple Claude turns until
 *      `stop_reason !== "tool_use"`.
 *
 * Required env:
 *   ANTHROPIC_API_KEY — your Anthropic console key
 *
 * Model selection — driven by the admin UI, NOT hardcoded:
 *   1. ProjectSetting.defaultModel   (project owner picks in /p/<slug>/settings)
 *   2. Model.isDefault=true          (super-admin picks in /admin/models)
 *   3. DDA_AGENT_MODEL env           (server bootstrap override)
 *   4. FALLBACK_MODEL                (compiled-in safety net)
 */
import Anthropic from "@anthropic-ai/sdk";
import type { MessageParam, ContentBlockParam } from "@anthropic-ai/sdk/resources/messages";
import OpenAI from "openai";
import { prisma } from "@/lib/db/prisma";
import {
  ALL_TOOLS,
  executeTool,
  toAnthropicTools,
  toolsForClouds,
  toolsForProject,
  type Tool,
} from "./tools";

export type ResolvedModel = {
  name: string;
  provider: "Anthropic" | "OpenAI" | "SelfHosted" | "Google" | "Groq";
};

const FALLBACK_MODEL: ResolvedModel = { name: "claude-sonnet-4-5", provider: "Anthropic" };
// How many past messages to feed the model. Lower it (env override) to fit a
// tight per-minute token budget like Groq's free tier.
const HISTORY_LIMIT = Number(process.env.DDA_AGENT_HISTORY_LIMIT) || 20;
// Max completion tokens we reserve. Providers like Groq count this RESERVATION
// against the per-minute token limit (TPM), so on the free tier a big value
// (4096) alone can push a request over the cap. Override via DDA_MAX_OUTPUT_TOKENS.
const MAX_OUTPUT_TOKENS = Number(process.env.DDA_MAX_OUTPUT_TOKENS) || 4096;

/**
 * Standing infra workflow the agent must follow for every cloud/AWS request:
 * ask requirements first, then always offer the three execution modes, then act
 * with the right tools. Kept in the system prompt so the behaviour is consistent
 * across every chat turn.
 */
const OPTIONS_RULE =
  'For any question with choices, emit EXACTLY one fenced ```options``` block — a single-line JSON object and nothing after it, e.g. {"question":"Which AWS region?","options":["us-east-1","us-west-2","Custom"],"key":"region"}. One question per message; WAIT for the answer; add "Custom" when free text is OK; never list choices as bullets or output raw JSON outside the block.';

const INFRA_PLAYBOOK = [
  "## Infrastructure (AWS/cloud) requests",
  "MANAGED DATABASES (RDS, 'add a database', 'create postgres/mysql') ARE NOT HANDLED HERE — that trigger belongs EXCLUSIVELY to the '## Managed database' playbook below (its own batch options-form + its own approval flow). Do NOT apply this playbook's 'ask one at a time' / 'Generate & push vs Submit for approval' flow to a database request — that is a DIFFERENT, incompatible flow and mixing the two is exactly what causes the form to get skipped or asked one field at a time.",
  "S3 BUCKETS ('create s3 bucket', 'new bucket') ARE NOT HANDLED HERE EITHER — that trigger belongs EXCLUSIVELY to the '## S3 bucket' playbook below (its own batch options-form + its own approval flow). Same reason as RDS: mixing the two flows breaks the form.",
  "VPC creation ('create vpc', 'new vpc') is handled EXCLUSIVELY by the '## VPC' playbook below. EC2 creation ('create ec2', 'new ec2 instance', 'launch an ec2') is handled EXCLUSIVELY by the '## EC2' playbook below. Same reason as RDS/S3: mixing flows breaks the batch form.",
  "CROSS-REGION VPC PEERING ('peer two vpcs', 'connect vpc to vpc', 'link vpcs across regions', 'cross region peering') ARE NOT HANDLED HERE EITHER — that trigger belongs EXCLUSIVELY to the '## Cross-region VPC peering' playbook below.",
  "To create/change ANY OTHER cloud infra (EKS, IAM, Lambda, standalone security groups…), run a guided wizard:",
  `- Ask requirements ONE at a time. ${OPTIONS_RULE} Gather: resource specifics, name (globally-unique where needed), region, environment, repo (for push), prod settings (encryption, HA, tags).`,
  "- COST FIRST: before showing the create/apply options, call estimate_infra_cost with the chosen specs (cloud, instanceType, nodeCount, managedK8s for EKS/AKS/GKE, storageGb, loadBalancers) and show the user the estimated MONTHLY cost + line-item breakdown. Say it's an approximate on-demand estimate. Only proceed once they've seen it.",
  '- Then show a short SUMMARY and ask the mode: ```options``` {"question":"How should I create it?","options":["Generate & push to GitHub","Submit for approval & apply","Cancel"],"key":"mode"}.',
  "- APPROVAL GATE (MANDATORY — never apply directly): to APPLY any infra, do NOT call run_terraform action='apply'. First run_terraform action='plan' to preview, then call request_infra_approval with the SAME files/stack + the cloud/region/instanceType/nodeCount so it runs policy checks + cost and creates a PENDING approval. If it returns status='blocked', STOP — tell the user exactly which policy rule failed (public storage, oversized/GPU instance, non-allowed region, admin port open to the world) and how to fix it; do NOT retry until they change the spec. If status='pending_approval', respond with a fenced ```approval-card``` block containing {\"approvalId\":\"<the returned approvalId>\"} (JSON inside the fence) so the user can approve/reject right there in chat — do NOT tell them to go find an Approvals page, and do NOT try to apply it yourself.",
  "- EKS → ALWAYS provision_eks; AKS → ALWAYS provision_aks; GKE → ALWAYS provision_gke — each is the console-style wizard for its cloud (Azure Portal: env → resource group → location → node pool → security → optional app pool → mode; GCP Console: env → project → location → node pool → network → security → optional app pool → mode). NEVER hand-write cluster Terraform. Other resources → write production-grade Terraform (encryption, least-privilege, remote state). Push = write_repo_file openPullRequest=true. The apply ALWAYS goes through request_infra_approval (the gate), never run_terraform apply directly. Use a stable descriptive `stack` name and REUSE it across runs.",
  "- APPLYING TERRAFORM THAT ALREADY EXISTS IN A REPO — TRIGGERS: 'apply the terraform in <repo>/<path>', 'apply the file in the connected repo', 'run the terraform I pushed', or the user references files an earlier create-cluster form pushed. THIS IS NOT A CREATE-WIZARD REQUEST — do NOT run the 'ask requirements one at a time' flow above, do NOT ask for region/instance type/name/environment settings, do NOT ask 'which action do you want' or 'confirm you want to proceed' more than once, and NEVER ask the user to paste, share, provide, confirm access to, or otherwise re-supply the file contents — the tool reads them itself with the OAuth identity the project already stored. The ONLY thing you may ask is: (a) the target env, and ONLY if the project has more than one env AND no default is set in the system context; (b) the single correct path, and ONLY if the given path is ambiguous or looks like a segment repeated twice (e.g. 'terraform/eks/x/terraform/eks/x') — in that case say so plainly and stop, do NOT silently try both variants. Everything else is ONE tool call: apply_repo_terraform(repoFullName, path, envKey, action). It lists + reads every .tf file at the path with the connected repo's OAuth identity, then plan previews or apply submits to the approval gate. If it errors 'no .tf files found', relay that message verbatim and STOP — do NOT retry with a guessed nearby path and do NOT fall back to asking the user for contents. When action='apply' returns status='pending_approval', respond with a fenced ```approval-card``` block containing {\"approvalId\":\"<the returned approvalId>\"} — the human approves inline and the apply runs automatically; do NOT send them to a separate Approvals page and do NOT claim the apply has started before that.",
  "- FABRICATION IS FORBIDDEN for repo-existing Terraform. Never chain list_files_in_repo + read_github_file + run_terraform/request_infra_approval yourself for the trigger above — that multi-step path is what causes you to (a) loop asking permission, and (b) synthesize plausible-looking planSummary lines / HCL that the user never actually wrote. Every planSummary line, every cost input, every policy input for a repo-existing apply MUST come from bytes apply_repo_terraform actually read from the repo. If you catch yourself composing 'EKS cluster module with version ~> 20.0' or similar without having read the file, STOP — you are hallucinating; call apply_repo_terraform instead. Do NOT narrate 'Terraform plan has started' or 'submitted for approval' unless the corresponding tool call returned successfully in this same turn.",
].join("\n");

/**
 * Manifest wizard the agent runs when asked to create a Kubernetes YAML file —
 * the chat equivalent of the static manifest builder. Deterministic generation
 * via tools; the agent only drives the Q&A and the push.
 */
const MANIFEST_PLAYBOOK = [
  "## Kubernetes manifest requests (deployment, service, configmap, secret, ingress, hpa, serviceaccount…)",
  "1. list_k8s_manifest_kinds for supported apiVersions/kinds/fields.",
  "2. Ask via ```options``` one at a time: apiVersion, kind, then each field (name, namespace, image, replicas, port…). WAIT for each.",
  "3. generate_k8s_manifest with the values — NEVER hand-write YAML. Show the result.",
  '4. Ask what to do next via ```options``` ["Apply to cluster","Push to GitHub","Both","Cancel"]. Apply → ask which env (if >1 connected) then apply_k8s_manifest with that envKey + the generated YAML (offer dryRun=true first to validate); report what changed. Push → ask repo + path (default k8s/<ns>/<kind>-<name>.yaml), then write_repo_file openPullRequest=true; share the PR link.',
].join("\n");

/**
 * Helm chart wizard — the chat equivalent of the static Helm chart builder.
 * Deterministic generation via tools; the agent drives the Q&A, the push, and
 * the optional deploy.
 */
const HELM_PLAYBOOK = [
  "## Helm chart requests (build/package/deploy a Helm chart)",
  "1. list_helm_chart_fields for fields/types/options/defaults.",
  "2. Ask via ```options``` one at a time: at least app name + image repository; offer to accept defaults for the rest (tag, port, replicas, service type, ingress, autoscaling, env, resources). WAIT for each.",
  "3. generate_helm_chart with the values — NEVER hand-write chart YAML. Summarise the files.",
  "4. Ask next via ```options``` ['Push to GitHub','Push & deploy','Deploy directly','Cancel']. Push → write_repo_file per file under charts/<name> (openPullRequest=true on the FIRST file only = one PR); share the link. Deploy → run_helm_upgrade (env, chart repo+dir, releaseName, image repo/tag); report rollout.",
].join("\n");

/**
 * CI playbook — the chat flow for "set up CI / containerize my repo / build &
 * push to ECR". The agent READS and ANALYSES the connected repo, then AUTHORS
 * the Dockerfile, docker-compose, and GitHub Actions workflow itself (LLM
 * generation), wiring keyless ECR pushes via the setup_github_oidc_ecr tool.
 */
const CI_PLAYBOOK = [
  "## CI / containerization (Docker + GitHub Actions → ECR)",
  "For 'set up CI / containerize / write a Dockerfile / build & push to ECR':",
  "1. Analyse the repo (ask which if >1). list_files_in_repo + read_github_file on package.json / requirements.txt / go.mod / pom.xml / etc. to detect language+version, framework, build & start commands, and the PORT. If a Dockerfile/workflow exists, ask before overwriting.",
  "2. Generate Docker files: list_dockerfile_stacks, then generate_dockerfile with the matched stack + detected params (buildDir, buildCommand, port, startCommand, version) → vetted Dockerfile/.dockerignore/compose/nginx.conf. NEVER hand-write a Dockerfile a template covers (the LLM reproduces broken patterns). If NO stack fits (Java, Rails, Rust, .NET, PHP…), hand-write a production Dockerfile (multi-stage, pinned base, non-root, correct EXPOSE, exec-form CMD) + .dockerignore + compose. Confirm the build output dir (Vite=dist, CRA=build) via ```options``` if unsure.",
  "3. verify_docker_build with the generated files — runs a real docker build, no commit/tokens. If built=false, read `log`, fix, verify again until it builds. If docker isn't on the server, warn and proceed carefully.",
  "4. setup_github_oidc_ecr (repoFullName, optional ecrRepoName/region) → creates the OIDC provider + repo-scoped IAM role + ECR push policy + ECR repo; returns roleArn + ecrRepositoryUri + region. Report `steps`. Needs an AWS account connected.",
  "5. generate_ecr_workflow with those values (NEVER hand-write the YAML) → .github/workflows/build-and-push.yml. Explain the flow (checkout → OIDC assume-role → ECR login → build → push) and ASK: are you satisfied — save this to the CI/CD pipeline?",
  "6. Do NOT push to GitHub without asking. Ask via ```options``` whether to commit now (opens a PR) or save it and commit later. On 'commit now', call write_repo_file for each generated file with openPullRequest=true on the first file — share the PR link. On 'save for later', call save_pipeline_to_project (repoFullName, a short name, ALL generated files) and tell the user it's saved — they can ask you to 'run the saved pipeline' anytime and you'll commit it then (write_repo_file, same as above).",
].join("\n");

/**
 * CI → cloud registry playbook for GCP (Artifact Registry) and Azure (ACR),
 * both keyless. Included only when the matching cloud is connected. The agent
 * MUST ask new-vs-existing registry, then set up keyless auth, then generate.
 */
const CI_REGISTRY_PLAYBOOK = [
  "## CI workflow → cloud container registry (GCP Artifact Registry / Azure ACR), keyless",
  "When the user wants a CI workflow that builds & PUSHES the image to GCP or Azure (not AWS/ECR):",
  "1. FIRST ASK the user: create a NEW registry, or use an EXISTING one? Do not assume.",
  "GCP (Artifact Registry):",
  "  - Existing → list_artifact_registries(location) and let them pick (ask the location, default us-central1).",
  "  - New → create_artifact_registry(location, repository).",
  "  - Then setup_gcp_github_wif(repoFullName) → keyless Workload Identity Federation; returns workloadIdentityProvider + serviceAccount.",
  "  - Then generate_gar_workflow(workloadIdentityProvider, serviceAccount, location, repository, image, branch) → the workflow YAML. NEVER hand-write it.",
  "Azure (ACR):",
  "  - Existing → list_acr() and let them pick.",
  "  - New → create_acr(resourceGroup, name, location). (ACR names: global, lowercase, alphanumeric.)",
  "  - Then setup_azure_github_oidc(repoFullName, acrName, resourceGroup). This tool AUTO-FALLBACKS: it prefers keyless federated OIDC, and if the Azure connection is OAuth (can't create AD apps), it enables the ACR admin user and stores its credentials as GitHub Actions secrets — same call, works either way. Read the returned `mode`. DO NOT tell the user to reconnect Azure as a service principal — that's the RBAC path this fallback exists to avoid.",
  "  - Then generate_acr_workflow with `mode` equal to what setup_azure_github_oidc returned. mode='keyless' → pass clientId/tenantId/subscriptionId. mode='secret' → pass secretPrefix. NEVER hand-write the YAML.",
  "  - SELF-HEAL: if any ACR CI run later fails with wait_for_workflow_run's failureKind='acr_secrets_missing' (or the log shows docker/login-action's 'Username and password required' / DEEPAGENT_ACR_SECRETS_MISSING), call repair_azure_acr_push_auth(repoFullName) YOURSELF — it discovers every ACR the repo pushes to, rotates the admin credential, rewrites the three GitHub secrets under the exact prefix the workflow references, and re-runs the failed jobs. Do NOT ask the user to add secrets, reconnect Azure, or click anything in the GitHub UI.",
  "  - AZURE OAUTH IS THE INTENDED CONNECTION SHAPE — NEVER tell the user to 'reconnect Azure as a Service Principal', 'switch to keyless OIDC', 'add ARM_CLIENT_ID/SECRET', or paraphrase any tool error that mentions those. If a tool error text contains 'Keyless ACR setup needs a SERVICE-PRINCIPAL' it is an INTERNAL fallback marker, not a user recommendation — the app auto-falls back to the secret-mode ACR push, and if that fails call repair_azure_acr_push_auth yourself. If deploy_my_app or setup_azure_github_oidc still fails with any credential-shape error after that repair, tell the user the exact underlying error verbatim (e.g. 'the running server hasn't picked up the latest Prisma schema — restart it') — do NOT invent a 'reconnect Azure' recommendation.",
  "2. Show the generated workflow, explain the keyless flow (GitHub OIDC → cloud, no stored secret), and ASK before committing. On 'yes' commit with write_repo_file (PR) or save_pipeline_to_project per the user's preference.",
].join("\n");

/**
 * Quick-deploy playbook: the DIRECT "deploy my app" path when an image already
 * exists. The agent asks only what the manifest needs, then deploys and watches.
 */
const DEPLOY_APP_PLAYBOOK = [
  "## Deploy an app (quick) — triggers: 'deploy my app', 'deploy the application', 'get my app running', 'deploy <image>'",
  "This is the DIRECT deploy path for when an image already exists. (If the user has NOT built/pushed an image yet, offer the full build pipeline instead — see the full deploy pipeline playbook.) Start immediately, asking only what's needed:",
  "0. TIMING FIRST — before anything else, ASK '''Deploy now, or schedule it for later?''' via an ```options``` block (options: 'Deploy now', 'Schedule for later'). If they pick 'Schedule for later', ALSO ask when (```options``` with e.g. 'In 1 hour', 'Tonight 9 PM', 'Tomorrow 9 AM', 'Custom'). Remember the choice; still collect all the same deploy settings below either way.",
  "1. Environment: use the DEFAULT deploy environment from your system context and say so — do NOT ask (only deviate if the user explicitly names another env). If the context has no default env, call list_deploy_targets; none → respond with an empty fenced ```cluster-connect``` block so they can connect an existing cluster right there in chat (or the eks-create/gke-create/aks-create/proxmox-vm fence if they want to provision a NEW one).",
  "2. Image: if the user named one, use it. Otherwise list_registry_images and ASK which to deploy (```options```, default the newest). If the registry is empty, say so and offer to set up the full build+push pipeline.",
  "3. Ask the settings the manifest needs, one at a time via ```options``` (WAIT for each), offering sensible defaults so the user can accept quickly: app name (default the repo/image name), namespace (default the env's), container port (default 8080 or the detected port), replicas (default 1), expose publicly? (+ host if yes). Keep it short.",
  "4. Optionally ask which EXTRA files beyond Deployment+Service they want (Ingress if exposing, ConfigMap/Secret/HPA) — default to just Deployment+Service if they don't care.",
  "5. RUN IT — respect the timing choice from step 0: if 'Deploy now', call deploy_app(envKey, appName, image, containerPort, replicas, env, expose, host). IMPORTANT — deploy_app does NOT deploy immediately: EVERY deploy goes through an APPROVAL GATE. deploy_app returns pendingApproval=true with an approvalId; respond with a fenced ```approval-card``` block containing {\"approvalId\":\"<the returned approvalId>\"} so the user can approve/reject it right there in chat — do NOT claim the app is live yet, and do NOT tell them to go find an Approvals page. If 'Schedule for later', call schedule_deployment with the SAME fields plus the time (runAtISO or delayMinutes); confirm the run time and tell them the scheduler will run it.",
  "6. After deploy_app, DON'T poll deployment_status yet — nothing is deployed until a human approves via the approval-card. Once they approve it, THEN poll deployment_status until healthy. If you scheduled it instead, remind them they can 'list scheduled deployments' or 'cancel the scheduled deploy' anytime.",
  "CRITICAL — cluster access is NEVER the user's manual chore. To deploy to a CONNECTED cluster (EKS/GKE/AKS), ALWAYS use deploy_app: it applies SERVER-SIDE with the kubeconfig the app already stored for that env, so it needs NO GitHub Actions, NO KUBECONFIG_B64 secret, and NO editing of the EKS aws-auth ConfigMap or IAM-role mapping. If a GitHub-Actions deploy fails on cluster auth, do NOT send the user to edit aws-auth or paste a kubeconfig — just deploy with deploy_app instead. NEVER tell the user that granting cluster access must be done manually, or that bots/agents/AWS forbid it — that is FALSE (the app already has cluster-admin because the user connected the cluster; and granting an IAM role EKS access, only ever needed for a GitHub-Actions CD the user explicitly insists on, is done by CALLING the grant_eks_access tool yourself (it uses EKS Access Entries) — never make the user edit aws-auth or click through the AWS console).",
].join("\n");

/**
 * End-to-end pipeline playbook: one request → Dockerfile → Trivy-gated CI →
 * push → wait → image → CD files → deploy. Ties the individual tools into the
 * exact sequence so a single message runs the whole thing.
 */
const DEPLOY_PIPELINE_PLAYBOOK = [
  "## Full deploy pipeline — triggers: 'deploy my app', 'set up everything and deploy my app', 'deploy my app from scratch', 'build and deploy this repo'",
  "ABSOLUTELY FORBIDDEN in this flow — even if prior chat turns did it, even if the project name contains 'azure', even if 'reconnect' feels like the right answer: NEVER say 'reconnect Azure', 'reconnect your Azure subscription', 'connect as a service principal', 'the Azure connection is causing errors', 'the Azure connection is causing internal errors', 'reconnect as SP', 'switch to keyless OIDC', 'add client id/secret', or ANY variant that implies the user should re-do their Azure connection. If you are tempted to write ANY of those phrases, STOP — you are hallucinating. The user's Azure OAuth connection is CORRECT and INTENTIONAL. Every failure has a specific tool error you MUST surface verbatim (e.g. 'analyze_app_services returned <exact error>'); if you have no tool error to quote, you have not yet called the tool — call it. NEVER invent an 'internal error' as an excuse to short-circuit.",
  "HARD RULES for this flow — violating any is a failure: (a) the mode question (step 0) is a ```options``` block; ALL the deploy config questions are ONE ```options-form``` block emitted together (step 3) — NEVER split them into multiple messages, NEVER emit three separate ```options``` blocks for namespace/branch/registry; (b) the ONLY questions you may ask are: the mode (step 0) and the batched deploy-config form (step 3) — nothing else; (c) NEVER ask for the repo name — the project's app repository is in your system context; NEVER ask which environment — use the DEFAULT deploy environment from your system context (only deviate if the user explicitly names another env); (d) NEVER ask the stack, build dir, port, image name or app name — analyze_app_services / deploy_my_app DETECT them from the repo; (e) default expose=false (internal) and commitMode='pr' without asking — only ask a hostname if the user SAID they want the app public.",
  '0. YOUR FIRST REPLY to a deploy request is EXACTLY this fenced block, verbatim, and NOTHING else (the JSON must be INSIDE the fence — never print it as plain text, and never print it twice):\n```options\n{"question":"How should I set this up?","options":["Fully automated — analyze my repo and generate everything","Form — let me fill the settings myself"],"key":"setupMode"}\n```\nWAIT for the answer. FORM → emit the empty ```cicd-setup``` fence and stop (resume at step 5 once the user says the PR is merged). FULLY AUTOMATED → step 1.',
  "1. Repo = the project's app repository from your system context; env = the DEFAULT deploy environment from your system context. Both are known — ask NOTHING here, just proceed (you'll state them in your step-5 report).",
  "2. Call analyze_app_services(repoFullName = the app repository). It returns every deployable service — a SINGLE app, OR a monorepo with a separate FRONTEND and BACKEND (each has a path, stackTitle and suggestedImageName). Then call list_kubernetes_resources(envKey, kind:'namespaces') to fetch the existing namespaces on the cluster. ALSO call the registry lister for the env's connected cloud — list_ecr_repos (AWS), list_artifact_registries (GCP), or list_acr (Azure) — to fetch the EXISTING container registries; this is NOT optional and is just as mandatory as the namespaces call. Do these silently — do not narrate tool calls.",
  '3. BATCH FORM — MANDATORY, NO ALTERNATIVE. After silently running analyze_app_services + list_kubernetes_resources(envKey,kind:\'namespaces\') + list_ecr_repos/list_artifact_registries/list_acr IN THIS TURN, your NEXT MESSAGE is EXACTLY the ```options-form``` fenced block below and NOTHING ELSE. No preamble like \'I detected a single deployable service…\'. No trailing text like \'Please provide your choices\'. No numbered list of questions in prose. No prose describing what will happen. NO PROSE OF ANY KIND. If you catch yourself typing \'I detected\', \'Now I need you\', \'Please choose\', \'Which namespace to deploy\', \'Please provide your choices\', or ANY human-readable question — STOP — you are violating the rule. Delete everything and emit ONLY the fence. The fence renders as a form the user fills in and submits with ONE button — the intro field inside the JSON is the ONLY summary allowed, and it\'s ONE short line. HARD BAN: you MAY NOT ask about the branch — the agent ALWAYS commits directly to the repo\'s default branch (main/master); NEVER offer a branch picker, NEVER open a PR. You MAY NOT emit ```options``` blocks (not ```options-form```) for namespace, registry, manifest type, or CI/CD system. You MAY NOT ask these questions one at a time. Emit this EXACT shape (4 questions — namespace, one registry per service, manifestType, cicdSystem — NO branch question), filling the bracketed slots from the tool results above (nothing else in the message, no leading or trailing text):\n```options-form\n{"intro":"Detected <N> service(s): <serviceName(stackTitle)>. Commits go to the repo\'s default branch. Pick a namespace, registry, manifest type and CI/CD system to continue.","questions":[{"key":"namespace","question":"Which namespace should I deploy to?","options":[<existing namespace strings>,"Create new: <repo-name default>"]},{"key":"registry_<serviceName>","question":"Which container registry for the <serviceName> service (<stackTitle>)?","options":[<existing repo name strings>,"Create new: <suggestedImageName>"]}<one such registry entry PER detected service — 1 for a single-app repo, 2 for a monorepo>,{"key":"manifestType","question":"How should I package this app for Kubernetes?","options":["Raw manifests (kubectl apply)","Helm chart (helm upgrade --install)"],"default":"Raw manifests (kubectl apply)"},{"key":"cicdSystem","question":"Which CI/CD system should run the pipeline?","options":["GitHub Actions (keyless via OIDC)","Jenkins (uses your connected Jenkins server)"],"default":"GitHub Actions (keyless via OIDC)"}],"submitLabel":"Deploy"}\n```\nWAIT for the user to submit. The chat surface sends their answers back as ONE message shaped like "namespace: X, registry_app: Z, manifestType: W, cicdSystem: V" — parse it to extract each value. Approval gates apply to APPLYING infra (Terraform apply against prod) and to PRODUCTION deploys — never to file commits.',
  "4. Parse the form: manifestType = 'helm' if the answer contains 'Helm' (case-insensitive) else 'manifests'; cicdSystem = 'jenkins' if the answer contains 'Jenkins' else 'github-actions'. Branch is ALWAYS the repo's default branch (main / master) — take it from your system context or from the repo record; NEVER derive it from a user answer. commitMode is ALWAYS 'direct' — the agent commits straight to that default branch, NEVER opens a PR. Approval gates only fire when Terraform APPLY runs against prod or when a deploy targets a production env — commits themselves are never gated. Then branch by cicdSystem. GITHUB ACTIONS path: call deploy_my_app(repoFullName, envKey, namespace, branch=<repo.defaultBranch>, commitMode='direct', manifestType, services:[{name, path, imageName, expose}]) with the values the user submitted. namespace, branch, manifestType, services are REQUIRED; services = one entry per detected service with name+path from analyze_app_services, imageName = the form's `registry_<serviceName>` answer for that service (strip any \"Create new: \" prefix), expose=false. Generates Dockerfile(s), GitHub Actions CI + CD workflow(s), and (for helm) the chart under charts/<appName>/ — commits DIRECTLY to <repo.defaultBranch>. JENKINS path: first verify a Jenkins connection exists — if none, emit a ```options-form``` block asking for url/username/apiToken and then call connect_jenkins with the answers; do NOT proceed to build steps until it succeeds. Then for EACH detected service: (a) generate_jenkinsfile(appName, context, registryUri, cloud, namespace, env, credentials:{cloud:<matching credential id>, kubeconfig:<matching credential id>}, manifestType, chartPath, releaseName) — write the returned content as `Jenkinsfile` in the service's context via write_repo_file(commitMode='direct', branch=<repo.defaultBranch>); (b) generate + commit the Dockerfile + K8s manifests exactly as the GitHub Actions path does (reuse generate_dockerfile + generate_k8s_manifest + write_repo_file with commitMode='direct'); (c) ensure_jenkins_job(repoFullName, jobName=<appName>-<env>, branch=<repo.defaultBranch>, jenkinsfilePath); (d) trigger_jenkins_build(jobName); (e) wait_for_jenkins_build(jobName, buildNumber). If Jenkins credentials with the required ids don't exist yet, TELL the user which ids to create in Jenkins UI (they're one-time per Jenkins server) and pause. Either way, report what was generated, the commit link (NOT a PR link — there is no PR), the manifest style used, the CI/CD system used, and (for Jenkins) each service's Jenkins job URL + build result.",
  "5. Once the files are committed to the default branch (deploy_my_app always uses commitMode='direct' now — no PRs), STOP and report deploy_my_app's `next` message verbatim in your own words — do NOT call wait_for_workflow_run yet. The generated CI workflows trigger on workflow_dispatch ONLY, never on push, BY DESIGN: this lets the files land on GitHub immediately while the actual build/deploy stays gated behind an explicit trigger. Tell the user the files are committed and that each service now has a pipeline in the CI/CD → Pipelines tab with a 'Run' button — nothing builds until they click it (or ask you to run it). Do NOT say 'CI is starting' or imply anything is building — nothing is, yet.",
  "5b. If the user says they ALREADY clicked Run in the CI/CD tab, skip straight to watching. If instead they ask YOU to run/trigger/start it (e.g. 'run the pipeline', 'trigger it', 'start the build'), call run_ci_pipeline(repoFullName, name=<service name> if multi-service) for EACH service FIRST — this is the exact same action as clicking Run in the UI (commits any pending edits, then fires workflow_dispatch). If it returns needsDisambiguation, ask ONE ```options``` question with the candidates. Either way, once a run exists, begin the build+deploy: for EACH service, wait_for_workflow_run(that service's workflowFile) — on conclusion='failure' inspect `failureKind` FIRST. failureKind='acr_secrets_missing' → the ACR docker-login secrets are missing/empty; call repair_azure_acr_push_auth(repoFullName) YOURSELF (do NOT ask the user, do NOT tell them to add secrets in Settings, do NOT tell them to reconnect Azure), then wait_for_workflow_run again — the repair rewrites the three secrets and re-runs the failed jobs. Only after two consecutive failures with the same kind, tell the user and stop. failureKind='cd_no_aws_creds' OR 'cd_no_gcp_creds' → the env's stored kubeconfig points at a cluster on a cloud the project isn't connected to (or is stale), so the runner's kubectl exec-plugin has nothing to auth with. Call repair_cd_kubeconfig(repoFullName, envKey, cdWorkflowFile) YOURSELF — do NOT ask the user, do NOT tell them to click Connect cluster, do NOT ask them to run set_kubeconfig_secret, do NOT suggest reconnecting any cloud. The tool auto-lists the AKS/EKS/GKE clusters on the env's connected cloud, if EXACTLY one exists it connects that cluster to the env (writes a fresh kubeconfig via ARM), pushes it to the repo as KUBECONFIG_B64, and reruns the failed CD workflow — all server-side. If the tool returns `candidates` (multiple clusters found → needs the user's choice), ask ONE ```options``` question with the candidates and re-invoke with the chosen cluster; otherwise wait for the rerun to complete and check status. If the tool returns error 'No AKS clusters exist…', THEN and only then tell the user + offer to create one via the aks-create flow. failureKind='cd_role_missing_eks_describe' → the CD role assumed correctly, but its inline policy lacks eks:DescribeCluster so `aws eks update-kubeconfig` fails with 'is not authorized to perform: eks:DescribeCluster'. This is an older role that predates the EKS-describe grant in setup_github_oidc_ecr. Call setup_github_oidc_ecr(repoFullName) YOURSELF to refresh the role's inline policy (put-role-policy overwrites — idempotent), then rerun the failed CD workflow. Do NOT tell the user to edit IAM in the AWS console, do NOT ask them to reconnect AWS, and do NOT reject the deploy. failureKind='ci_wif_binding_missing' → the CI's docker-push can't impersonate the GCP service account (WIF binding missing for this repo, or IAM hasn't propagated). Call repair_gcp_wif_binding(repoFullName, ciWorkflowFile) YOURSELF — do NOT ask the user to open the GCP console or add a binding manually. The tool re-runs the WIF setup (idempotent — adds this repo's SA impersonation binding + patches the provider's attribute condition), waits ~60s for IAM to propagate, and reruns the failed CI. Only after two consecutive failures with the same kind, tell the user and stop. Other failureKind values (Trivy HIGH/CRITICAL gate, build error) need a Dockerfile/app fix — report them and stop for that service. On success wait_for_workflow_run(that service's cdWorkflowFile).",
  "6. When the CD run succeeds, confirm with deployment_status(envKey, appName=service.appName) and report the result. If a CD run FAILS: on 'Unauthorized' / 'must be logged in to the server', fix it YOURSELF with grant_eks_access(envKey, roleArn=that service's AWS role) and re-run; otherwise fall back to the server-side deploy_app(envKey, appName, image=service.imageRef, containerPort=service.containerPort) — it goes through the APPROVAL GATE (respond with a fenced ```approval-card``` block containing the returned approvalId; after approval, poll deployment_status until healthy).",
  "CRITICAL — cluster access is NEVER the user's manual chore. The CD workflow is keyless (no KUBECONFIG_B64 on EKS) and deploy_my_app grants the role access automatically. If cluster auth still fails, call grant_eks_access yourself — never send the user to edit aws-auth, paste a kubeconfig, or click the AWS console.",
  "CUSTOMIZE PATH (only when the user explicitly wants to hand-pick manifests/fields): use the interactive tools — generate_dockerfile / verify_docker_build, setup_github_oidc_ecr → generate_ecr_workflow, list_k8s_manifest_kinds → generate_k8s_manifest per kind (never hand-write YAML), write_repo_file to commit (one PR), then steps 5–6 above for build + server-side deploy.",
].join("\n");

/**
 * Rollback playbook — both the manual path (user asks) and the promise that
 * deploys auto-revert. Included whenever a cloud is connected.
 */
const ROLLBACK_PLAYBOOK = [
  "## Rollback a deployment — triggers: 'rollback <app>', 'revert the deploy', 'undo the last deploy', 'go back to the previous version'",
  "AUTOMATIC: every deploy already self-heals — deploy_app / schedule_deployment watch the rollout and, if the new version doesn't become healthy in time, AUTOMATICALLY roll back to the previous version and email + notify the team. So if a deploy tool reports it 'was automatically rolled back', tell the user that plainly and suggest checking pod logs (image pull, wrong port, missing env var) — do NOT roll back again.",
  "MANUAL (user asks to revert a version that deployed fine but misbehaves):",
  "1. Identify the app + env. If unclear, list_deploy_targets for the env and ask which app.",
  "2. Optionally list_rollout_history(envKey, appName) to show the revisions and let the user pick one (```options```). Default is the immediately previous version.",
  "3. CONFIRM before rolling back a PRODUCTION env. Then rollback_deployment(envKey, appName, [toRevision]). It reverts via `kubectl rollout undo` and waits for the rollout to settle, then notifies the team.",
  "4. Report the result. If it failed because there's no previous revision (a first-ever deploy), explain there's nothing to roll back to and offer to fix-forward instead.",
].join("\n");

/**
 * Managed database (AWS RDS) — either provision a NEW one wired to the
 * project's EKS cluster, or CONNECT an existing DB by pasting its URL. Either
 * path ends the same way: a Kubernetes Secret (`DATABASE_URL` + DB_* keys) is
 * created in the app's namespace and the caller is told how to wire it into
 * the app Deployment. Included only for projects with AWS connected — Azure
 * (Flexible Postgres) and GCP (Cloud SQL) equivalents ship later.
 */
const DATABASE_PLAYBOOK = [
  "## Managed database — triggers: 'add a database', 'create an RDS', 'set up postgres for my app', 'connect my existing database', 'give my app a postgres/mysql'",
  "FIRST ask ONE ```options``` question: {\"question\":\"How do you want to add the database?\",\"options\":[\"Create a NEW managed database (AWS RDS)\",\"CONNECT an existing database (paste connection URL)\",\"Cancel\"],\"key\":\"dbMode\"} and WAIT.",
  "",
  "### CREATE path (AWS RDS) — TWO gates only, in this exact order: (gate A) the batch form in step 1 collects the specifics from the USER — you may NEVER fabricate/default your way past it; (gate B) the approval-card in step 4 is the ONE click that authorizes the actual `terraform apply` on the console. NOTHING else in between ever asks the user anything — no cost preamble, no 'shall I proceed?', no separate estimate step. The approval-card already displays cost + plan diff on its own; a standalone cost message is pure friction.",
  '1. BATCH FORM — MANDATORY, NO ALTERNATIVE, NOT SKIPPABLE. The MOMENT the user picks "Create a NEW managed database", your VERY NEXT MESSAGE is EXACTLY the ```options-form``` fenced block below and NOTHING ELSE. THREE forbidden failure modes, all equally wrong: (a) asking about name/env/engine/etc. ONE AT A TIME in prose ("Let\'s start with the database name…", "What name would you like?"); (b) skipping the form ENTIRELY and silently using the defaults below to go straight to generating/submitting — the defaults exist to PRE-FILL the form for the user to review and one-click accept, NOT for you to decide on their behalf without showing them anything; (c) any preamble/summary before the fence. If you catch yourself doing (a), (b), or (c) — STOP, delete it, and emit ONLY the fence below, filling only the bracketed defaults from context (env from the system context\'s default deploy env; name from the repo name):\n```options-form\n{"intro":"Let\'s set up your AWS RDS database.","questions":[{"key":"name","question":"Database name (lowercase, dns-safe)","kind":"text","default":"<repo-name>-db"},{"key":"env","question":"Environment","options":["dev","staging","prod"],"default":"<context default env>"},{"key":"engine","question":"Database engine","options":["postgres","mysql"],"default":"postgres"},{"key":"engineVersion","question":"Engine version (AWS rotates these; if apply-time errors say the version is unavailable, retry with a newer minor from the list AWS returns)","options":["17.5","17.4","16.9","16.8","15.13","15.12","14.18","14.17","8.0.42","8.0.41"],"default":"16.9"},{"key":"instanceClass","question":"RDS instance class","options":["db.t4g.micro","db.t4g.medium","db.t4g.large"],"default":"db.t4g.micro"},{"key":"allocatedStorage","question":"Allocated storage (GB)","kind":"number","default":"20"},{"key":"multiAz","question":"Multi-AZ deployment?","options":["Yes","No"],"default":"No"},{"key":"initialDbName","question":"Initial database name","kind":"text","default":"<same as name>"}],"submitLabel":"Generate and commit to repo"}\n```\nTHE FORM RENDERER ONLY SUPPORTS TWO QUESTION SHAPES — every question MUST be one of: (a) fixed-choice: {"key":..,"question":..,"options":[...],"default":..} (renders as pills), or (b) free input: {"key":..,"question":..,"kind":"text"|"number","default":..} (renders as a real text/number box). NEVER invent any other field name like "type" — a question missing both "options" and a valid "kind" fails validation and the WHOLE form silently renders as unusable raw JSON text instead of a form. WAIT for the user to actually submit it — they answer as ONE message like "name: X, env: Y, ...". Do NOT proceed to step 2 until that submission message has arrived.',
  "2. ONLY AFTER the user's step-1 submission arrives: call generate_rds_terraform(name, region, envKey, engine, engineVersion, instanceClass, allocatedStorage, multiAz, initialDbName) using the values THEY submitted (never defaults they didn't confirm). OMIT eksClusterName/vpcId entirely — the tool derives them from the env's own connected kubeconfig itself; NEVER ask the user for a VPC id or cluster name. It returns .tf files (main/outputs/versions) that gate inbound Postgres/MySQL to the EKS worker SG only — no 0.0.0.0/0. NEVER hand-write RDS HCL. If the tool errors that the env has no EKS cluster connected, say so plainly and offer to connect one — don't ask the user to supply a VPC id manually. If the tool errors that the engine version is unavailable ('AWS RDS in <region> does not have <engine> version <x> available…'), it lists currently-valid versions in that same error message; re-emit the batch form with those valid versions swapped into the engineVersion pills' options — do NOT just re-run with a guess. NO cost estimate call — the approval-card in step 4 shows cost natively; a separate estimate message is redundant friction.",
  "3. IMMEDIATELY commit the returned files to the project's app repo — write_repo_file each file under `terraform/rds/<name>/` on the repo's default branch, commitMode direct (no PR, no branch question — matches the rest of this app's Terraform convention). This is NOT gated; committing files to a repo isn't the risky step, applying them is. Tell the user in ONE short line that the files are committed and link the path, then immediately proceed to step 4 in the SAME turn (do NOT ask 'shall I plan/apply?', do NOT wait for user confirmation before continuing).",
  "4. GATE the actual APPLY — this is the ONE and ONLY approval in this flow, AND it is what runs terraform apply. Call run_terraform action='plan' with the SAME files/stack, then request_infra_approval with those files/stack + cloud='aws'/region/instanceType. When it returns status='pending_approval', respond with a fenced ```approval-card``` block containing {\"approvalId\":\"<returned id>\"} and STOP. That card IS the confirmation — the user clicking Approve on it IS what runs `terraform apply`. Do NOT ALSO ask 'shall I apply?' in prose.",
  "4a. ABSOLUTE ANTI-FABRICATION CONTRACT — this is where every prior attempt has failed, so read it carefully. Between emitting the approval-card and the user actually approving it: (a) you MUST NOT say 'the Terraform has been applied', 'the apply is running', 'the process is running now', 'provisioning has started', or any variant claiming the apply is in progress — the apply does NOT start until the click. (b) you MUST NOT proceed to step 5, 6, 7, or 8 in the same turn as the approval-card. STOP after the fence. The user's NEXT message (arriving after they've clicked Approve and the apply finished) is what unblocks continuation. (c) you MUST NOT call create_rds_k8s_secret in this turn — you have zero real outputs; guessing values (empty strings, `<host>`, `example.com`, etc.) is banned and the tool now rejects them anyway. (d) Only proceed to step 5+ once you can point at an ACTUAL completed terraform run whose stdout you just read in this same turn — not a claim, an actual tool result with real host/port/database/username/password values in it. If you don't have those, you're not done with step 4 yet — stop.",
  "5. AFTER the user's post-approval message arrives AND you have read the completed Terraform run's outputs (real host / port / database / username / password / connection_string values, not guesses), continue. If you don't have them, ask them for the terraform run id or call the run's status tool to fetch outputs — do NOT proceed to K8s Secret creation without them.",
  "6. Ask ```options``` which app namespace to wire this into (default = the env's default namespace) and what the Kubernetes Secret should be named (default '<app>-db').",
  "7. Call create_rds_k8s_secret(envKey, namespace, secretName, host, port, database, username, password, engine, alsoStoreInAppSecret=true) with the REAL output values from step 5 only. The tool will REJECT empty strings, placeholders like `<host>`, or any obviously-fake input — if you get that rejection, it means you skipped step 5 (there ARE no real outputs yet); go back and get them. It returns a Secret manifest. Apply it with apply_k8s_manifest(envKey, yaml=<manifest>). NEVER print the password in your reply.",
  "8. Tell the user the Secret is applied and give them the exact envFrom snippet to add to their app Deployment: `envFrom: [{ secretRef: { name: \"<secretName>\" } }]`, then remind them to roll pods (kubectl rollout restart deployment/<app> -n <namespace>). Offer to run the rollout via apply_k8s_manifest or a subsequent deploy.",
  "",
  "### CONNECT path (existing DB — RDS, Neon, Supabase, self-hosted, anywhere)",
  "1. Emit an empty fenced ```secret-entry``` block so the user pastes the full connection URL (postgres://user:pass@host:5432/dbname or mysql://…) WITHOUT it leaking into the chat transcript. WAIT.",
  "2. Once the app secret is set, ask ```options``` for the target env (if >1), namespace (default env's default), and secretName (default '<app>-db').",
  "3. Call connect_existing_rds(envKey, namespace, secretName, connectionString=<the secret value>, alsoStoreInAppSecret=true). It validates the URL shape and returns the Secret manifest. Apply it with apply_k8s_manifest(envKey, yaml=<manifest>).",
  "4. Tell the user the Secret is applied and give the same envFrom snippet + rollout reminder as the CREATE path. Note that the tool does NOT test connectivity from the cluster — if pods can't reach the DB after the rollout, check get_kubernetes_logs and the DB's own security-group / firewall rules.",
  "",
  "CRITICAL — never ask the user to hand-craft SG rules, VPC peering, or subnet groups. The CREATE path's Terraform builds them; the CONNECT path assumes the user's DB is already reachable (say so plainly if pods can't connect and offer to help update the DB's SG to allow the EKS worker SG).",
].join("\n");

/**
 * S3 bucket playbook — AWS-only. Same shape as DATABASE (form → generate →
 * commit → single approval → apply). Secure defaults are baked into the
 * generator (public blocked, SSE, versioning), so the form is short.
 */
const S3_PLAYBOOK = [
  "## S3 bucket — triggers: 'create s3 bucket', 'make an s3 bucket', 'i need an s3 bucket', 'new bucket'",
  "SINGLE-BOX WIZARD FLOW — the dedicated `s3-create` chat fence renders a paged, console-style bucket-creation wizard (same UX shape as `ec2-create` / `eks-create`): name + region + env, then encryption + versioning + lifecycle + random-suffix, then a review page, then one Create button that commits HCL + creates an approval and renders an ApprovalCard inline. The box owns the ENTIRE flow — you don't ask any questions, you don't emit any options-form, you don't call any tools. Just emit the empty fence and stop.",
  "1. YOUR VERY NEXT MESSAGE after the trigger is EXACTLY this — no prose, no preamble, no 'let me help you create an S3 bucket':\n```s3-create\n```",
  "2. STOP after emitting the fence. The S3CreateBox component takes over — it validates the name, submits to /aws/s3 (which commits + creates the approval), and renders an ApprovalCard inline on approval. The user's next message to you happens AFTER they've approved and the apply completed.",
  "3. AFTER the apply completes, report the bucket name + ARN + region (the real values from the completed run's outputs). Never claim 'the bucket has been created' before the user's post-approval message actually arrives.",
].join("\n");

/**
 * VPC playbook — VPC-ONLY, no EC2 attached. Users who want an EC2 too should
 * create the VPC first, then use the EC2 flow (or the Network > EC2 page) to
 * place an EC2 inside it. Same console model as AWS itself.
 */
const VPC_PLAYBOOK = [
  "## VPC — triggers: 'create vpc', 'new vpc', 'set up a vpc', 'give me a vpc'",
  "SINGLE-BOX WIZARD FLOW — the dedicated `vpc-create` chat fence renders a paged, console-style VPC creation wizard (same UX shape as `ec2-create` / `s3-create`): name + region + env + VPC CIDR, then AZ count + DNS toggles, then a subnets page (private-subnets checkbox + NAT strategy dropdown), then a review page, then one Create button that commits HCL + creates an approval and renders an ApprovalCard inline. The box owns the ENTIRE flow — you don't ask any questions, you don't emit any options-form, you don't call any tools. Just emit the empty fence and stop.",
  "IMPORTANT: this flow creates ONLY a VPC (with N public subnets, optional N private subnets, IGW, route tables, and optional NAT gateways). It does NOT include an EC2 instance. If the user asked for both a VPC AND an EC2 in one go, emit the vpc-create fence first, and after the VPC is created (their next message) emit the ec2-create fence for the second half. If they only asked for a VPC, just emit vpc-create and stop.",
  "1. YOUR VERY NEXT MESSAGE after the trigger is EXACTLY this — no prose, no preamble, no 'let me help you create a VPC':\n```vpc-create\n```",
  "2. STOP after emitting the fence. The VpcCreateBox component takes over — it validates the CIDR, submits to /aws/vpc (which commits + creates the approval), and renders an ApprovalCard inline on approval. The user's next message to you happens AFTER they've approved and the apply completed.",
  "3. AFTER the apply completes, report vpc_id + vpc_cidr + public_subnet_ids (and private_subnet_ids / nat_gateway_ips if they exist) from the real outputs. Offer next steps: launch an EC2 into it (say 'create ec2'), or peer it across regions. Never claim 'the VPC has been created' before the user's post-approval message actually arrives.",
].join("\n");

/**
 * Azure VNet playbook — Azure's answer to AWS VPC. Same wizard shape as
 * the AWS VPC flow (name/basics → subnets → review).
 */
const AZURE_VNET_PLAYBOOK = [
  "## Azure VNet — triggers: 'create vnet', 'create azure vpc', 'new virtual network', 'give me an azure network'",
  "SINGLE-BOX WIZARD FLOW — the `azure-vnet-create` chat fence renders a paged, console-style Azure VNet creation wizard: name/location/env + CIDR, then subnets + NAT + NSGs, then a review page, then one Create button that commits HCL + creates an approval and renders an ApprovalCard inline. Just emit the empty fence and stop.",
  "1. YOUR VERY NEXT MESSAGE after the trigger is EXACTLY this — no prose, no preamble:\n```azure-vnet-create\n```",
  "2. STOP after emitting the fence. AzureVnetCreateBox owns the whole flow.",
  "3. AFTER the apply completes, report resource_group_name / vnet_id / vnet_cidr / public_subnet_ids from the real outputs. Offer next steps: launch an Azure VM (say 'create azure vm').",
].join("\n");

/**
 * GCP VPC playbook — network + regional subnets + firewall + optional
 * Cloud NAT. GCP's answer to AWS VPC.
 */
const GCP_VPC_PLAYBOOK = [
  "## GCP VPC — triggers: 'create gcp vpc', 'new gcp network', 'give me a gcp network'",
  "SINGLE-BOX WIZARD FLOW — the `gcp-vpc-create` chat fence renders a paged, console-style GCP VPC creation wizard: name/region/env + CIDR, then subnets + Cloud NAT toggles, then review, then Create.",
  "1. YOUR VERY NEXT MESSAGE after the trigger is EXACTLY this:\n```gcp-vpc-create\n```",
  "2. STOP after emitting the fence. GcpVpcCreateBox owns the whole flow.",
  "3. AFTER the apply completes, report vpc_name / subnet_names from the real outputs. Offer next steps: launch a GCP VM (say 'create gcp vm').",
].join("\n");

/**
 * GCP VM playbook — Compute Engine VM in an EXISTING network/subnet.
 */
const GCP_VM_PLAYBOOK = [
  "## GCP VM — triggers: 'create gcp vm', 'launch gcp vm', 'new compute engine instance', 'spin up a gce vm'",
  "SINGLE-BOX WIZARD FLOW — the `gcp-vm-create` chat fence renders a paged, console-style GCP VM launcher: name/region/zone/env, then network + subnet (live from GCP), then image + login, then size + firewall tags, then review, then Launch.",
  "1. YOUR VERY NEXT MESSAGE after the trigger is EXACTLY this:\n```gcp-vm-create\n```",
  "2. STOP after emitting the fence. GcpVmCreateBox owns the whole flow.",
  "3. AFTER the apply completes, report vm_name / public_ip / ssh_command (or rdp_command for Windows).",
].join("\n");

/**
 * Azure VM playbook — VM-in-EXISTING-VNet. Assumes the user has a VNet
 * ready (via azure-vnet-create or manually). If they don't, tell them to
 * run azure-vnet-create first.
 */
/**
 * GCP OpenVPN playbook — self-hosted OpenVPN on a Compute Engine VM. GCP has
 * no managed Client VPN equivalent to AWS's, so this stands up an e2-small
 * VM running OpenVPN with the same auto-generated CA/server/client cert flow
 * as the AWS wizard.
 */
const GCP_VPN_PLAYBOOK = [
  "## GCP VPN — triggers: 'create gcp vpn', 'create gcp openvpn', 'gcp client vpn', 'gcp vpn', 'let me connect to gcp vpc from my laptop', 'openvpn into gcp'",
  "SINGLE-BOX WIZARD FLOW — the `gcp-vpn-create` chat fence renders a paged, console-style wizard: name + region + zone + env, then network + subnet (live from GCP) + auto-filled subnet CIDR, then cert owner name + VM size + client CIDR + transport/port + split/full tunnel + source IP allowlist, then Review, then one Create button that commits HCL + creates an approval and renders an ApprovalCard inline.",
  "IMPORTANT: GCP has NO managed Client VPN service. Cloud VPN is site-to-site only, IAP TCP-forwarding requires gcloud + a Google account per user. This wizard self-hosts OpenVPN on a small e2-small Compute Engine VM so the .ovpn download UX is identical to AWS Client VPN. Cost is ~$8-15/mo per endpoint. Don't confuse with `create client vpn` (AWS) or `create gcp vm` (a generic VM).",
  "1. YOUR VERY NEXT MESSAGE after the trigger is EXACTLY this — no prose, no preamble:\n```gcp-vpn-create\n```",
  "2. STOP after emitting the fence. GcpVpnCreateBox owns the whole flow.",
  "3. AFTER the apply completes (~3-5 min: the VM's startup script installs OpenVPN + generates DH params on first boot), report client_vpn_dns_name (the static public IP) + vpn_port + vpn_transport from the real outputs. Tell the user: (a) build a .ovpn file with remote=<client_vpn_dns_name> <vpn_port>, proto=<vpn_transport>, (b) LOCALLY run `terraform output -raw client_certificate_pem`, `terraform output -raw client_private_key_pem`, `terraform output -raw ca_certificate_pem` and paste them between <cert></cert>, <key></key>, <ca></ca> tags — NEVER print the private key output in chat. (c) The startup script takes ~2-3 min after the VM boots — if connection fails immediately after apply, wait then retry. (d) To add per-user certs later, run `create vpn certificates` (works for both AWS and GCP VPNs).",
].join("\n");

/**
 * Azure OpenVPN playbook — self-hosted OpenVPN on a Standard_B1s VM. Azure's
 * managed VPN Gateway P2S costs ~$140/mo minimum; this self-hosted variant
 * runs ~$13/mo for the same .ovpn download UX.
 */
const AZURE_VPN_PLAYBOOK = [
  "## Azure VPN — triggers: 'create azure vpn', 'create azure openvpn', 'azure client vpn', 'azure vpn', 'let me connect to azure vnet from my laptop', 'openvpn into azure'",
  "SINGLE-BOX WIZARD FLOW — the `azure-vpn-create` chat fence renders a paged, console-style wizard: name + location + env, then VNet + subnet (live from Azure) + auto-filled subnet CIDR (RG auto-fills from the VNet pick), then cert owner name + VM size + client CIDR + transport/port + split/full tunnel + source IP allowlist + admin SSH creds, then Review, then one Create button that commits HCL + creates an approval.",
  "IMPORTANT: Azure's managed VPN Gateway P2S costs ~$140/mo minimum. This wizard SKIPS the managed gateway and self-hosts OpenVPN on a Standard_B1s VM (~$13/mo) for cost parity with the GCP flow. Don't confuse with `create azure vm` (a generic VM) or `create client vpn` (AWS Client VPN).",
  "1. YOUR VERY NEXT MESSAGE after the trigger is EXACTLY this — no prose, no preamble:\n```azure-vpn-create\n```",
  "2. STOP after emitting the fence. AzureVpnCreateBox owns the whole flow.",
  "3. AFTER the apply completes (~3-5 min: the VM's cloud-init installs OpenVPN + generates DH params on first boot), report client_vpn_dns_name (the static public IP) + vpn_port + vpn_transport from the real outputs. Tell the user: (a) build a .ovpn file with remote=<client_vpn_dns_name> <vpn_port>, proto=<vpn_transport>, (b) LOCALLY run `terraform output -raw client_certificate_pem`, `terraform output -raw client_private_key_pem`, `terraform output -raw ca_certificate_pem` and paste them between <cert></cert>, <key></key>, <ca></ca> tags — NEVER print the private key output in chat. (c) Startup script takes ~2-3 min after the VM boots — if connection fails immediately after apply, wait then retry. (d) To reach VMs on the subnet, ensure the target VM's NSG allows inbound from the client CIDR (added by the wizard's user, not this stack).",
].join("\n");

const AZURE_VM_PLAYBOOK = [
  "## Azure VM — triggers: 'create azure vm', 'launch azure vm', 'new azure virtual machine', 'spin up a windows/linux vm in azure'",
  "SINGLE-BOX WIZARD FLOW — the `azure-vm-create` chat fence renders a paged, console-style Azure VM launcher: name/location/env, then VNet + subnet dropdowns (live from Azure), then image + login, then size + firewall, then a review page, then one Launch button that commits HCL + creates an approval and renders an ApprovalCard inline. Just emit the empty fence and stop.",
  "1. YOUR VERY NEXT MESSAGE after the trigger is EXACTLY this:\n```azure-vm-create\n```",
  "2. STOP after emitting the fence. AzureVmCreateBox owns the whole flow.",
  "3. AFTER the apply completes, report vm_name / public_ip / ssh_command from the real outputs (or 'Use Remote Desktop to <ip>' for Windows). Never claim 'the VM is running' before the user's post-approval message arrives.",
].join("\n");

/**
 * One-click Jenkins on EC2 — provision a self-configuring Jenkins on a
 * brand-new VM (vs the BYO Jenkins path inside deploy_my_app, which
 * assumes the user already has a running Jenkins server).
 */
const JENKINS_PROVISION_PLAYBOOK = [
  "## Jenkins (provision from scratch) — triggers: 'provision jenkins', 'create jenkins', 'set up jenkins from scratch', 'i want a new jenkins server', 'spin up jenkins'",
  "SINGLE-BOX WIZARD FLOW — the `jenkins-provision` chat fence renders a paged, console-style Jenkins provisioning wizard: name/region/env, then VPC + public subnet, then instance size + admin credentials, then a review page, then one Provision button that commits HCL + creates an approval. The box owns the ENTIRE flow — don't ask questions, don't emit options-form, don't call tools. Just emit the empty fence and stop.",
  "IMPORTANT: use THIS flow when the user wants a fresh Jenkins server. Do NOT use it when the user says 'connect Jenkins' or 'wire up my existing Jenkins' — that's the BYO path (call connect_jenkins tool with URL/username/apiToken).",
  "1. YOUR VERY NEXT MESSAGE after the trigger is EXACTLY this — no prose, no preamble:\n```jenkins-provision\n```",
  "2. STOP after emitting the fence. JenkinsProvisionBox takes over — fetches VPCs/subnets live, generates a random admin password (user can override), submits to /aws/jenkins/provision (which also writes a starter Jenkinsfile.deepagent-starter to the repo).",
  "3. AFTER the apply completes, report jenkins_url + jenkins_admin_username from the real outputs. NEVER print jenkins_admin_password in chat — tell the user it's a sensitive Terraform output they extract locally via `terraform output -raw jenkins_admin_password`. Also mention: (a) Jenkins takes ~2 min after the instance boots to accept HTTP, (b) they should rotate the admin password from Manage Jenkins → Users at first login (currently visible in EC2 user-data metadata), (c) if they picked an EC2 key pair at wizard time AND opened port 22, they SSH in with the .pem they already downloaded from the AWS EC2 console when they created that key pair — the app never generates/holds pem files, (d) if no key pair, use `aws ssm start-session --target <instance_id>`, (e) if they want a working pipeline, rename Jenkinsfile.deepagent-starter → Jenkinsfile and configure a pipeline job pointing at their repo.",
].join("\n");

/**
 * AWS Client VPN playbook — laptop-to-VPC OpenVPN endpoint. Requires ACM
 * certs the user has to generate off-cluster with easy-rsa (there's no way
 * around this — AWS Client VPN needs proper PKI, not self-signed inline).
 * The wizard shows the exact commands on the certs page so users can copy
 * them into their own terminal.
 */
/**
 * Standalone VPN certificate set playbook — creates PKI (CA + server + N
 * clients) INDEPENDENT of the Client VPN endpoint. Use when the user wants
 * to manage certificates as a separate lifecycle (rotate certs without
 * touching the VPN, hand distinct client certs to team members, reuse the
 * same PKI across multiple endpoints).
 */
const VPN_CERTIFICATES_PLAYBOOK = [
  "## VPN Certificates (per-user certs for an existing Client VPN) — triggers: 'create vpn certificates', 'create vpn certs', 'generate vpn certs', 'make client vpn certificates', 'create user certs for the vpn', 'issue certs for vpn users', 'add users to my vpn', 'create vpn user certs'",
  "SINGLE-BOX WIZARD FLOW — the `vpn-certificates-create` chat fence renders a paged wizard: page 1 dropdown of EXISTING Client VPN endpoints (picks which VPN's CA to sign against), page 2 a dynamic list of team-member names (1-50), page 3 review + Issue. On submit the wizard calls /aws/client-vpn/[approvalId]/issue-users-batch which mints one cert per user, saves each to the DB (encrypted), and streams back a single zip with per-user folders — each containing a self-contained .ovpn (cert + key + ca already embedded). Emit the empty fence and STOP.",
  "IMPORTANT: this flow is for ADDING USERS to an existing VPN. Do NOT confuse with `create client vpn` (which provisions a whole new endpoint + its own CA). Every user cert lands in the sidebar Client VPN page's 'Issued user certs' list for later re-download or revocation. AWS Connection Log will show each user's Common Name in per-session records.",
  "1. YOUR VERY NEXT MESSAGE after the trigger is EXACTLY this — no prose, no preamble:\n```vpn-certificates-create\n```",
  "2. STOP after emitting the fence. VpnCertificatesCreateBox takes over — lists Client VPNs, validates user names, POSTs to /aws/client-vpn/[approvalId]/issue-users-batch, streams the zip.",
  "3. AFTER the user reports the zip downloaded: tell them (a) distribute the per-user `.ovpn` from `users/<name>/<name>.ovpn` to each team member, (b) they import it into AWS VPN Client / Tunnelblick and connect, (c) AWS Connection Log then shows each user's real name in the Common Name column per session, (d) certs are also saved in the app — sidebar Client VPN page → 'Issued user certs' for re-download / revoke. NEVER print any private key in chat.",
].join("\n");

/**
 * Issue a per-user VPN certificate against an EXISTING Client VPN endpoint.
 * Wraps the sidebar page's per-row button in a wizard entry point so users
 * can start from chat.
 */
const ISSUE_VPN_USER_CERT_PLAYBOOK = [
  "## Issue VPN user cert — triggers: 'issue vpn user cert', 'add vpn user', 'add user to vpn', 'new user cert', 'issue user cert', 'give someone vpn access', 'generate cert for a team member'",
  "SINGLE-BOX WIZARD FLOW — the `issue-vpn-user-cert` chat fence renders a paged wizard: pick from a dropdown of the project's Client VPNs, then type a user name (CN), then Review + Issue. The wizard calls the /aws/client-vpn/[approvalId]/issue-user endpoint, downloads the zip (self-contained .ovpn + cert + key + ca) automatically, AND persists the cert to the DB so it appears in the Client VPN sidebar's 'Issued user certs' list for re-download / revoke later. Emit the empty fence and STOP.",
  "IMPORTANT: use THIS flow when the user wants to add a person to an existing VPN. Do NOT use `create client vpn` (which creates a new endpoint) or `create vpn certificates` (which creates a whole new PKI). Use those only when explicitly asked.",
  "1. YOUR VERY NEXT MESSAGE after the trigger is EXACTLY this — no prose, no preamble:\n```issue-vpn-user-cert\n```",
  "2. STOP after emitting the fence. IssueVpnUserCertBox takes over — lists existing Client VPNs (applied only), validates the user name, POSTs to the issue-user endpoint, and streams a zip download.",
  "3. AFTER the user reports the cert was issued: tell them (a) hand the .ovpn file to that team member, (b) the AWS Connection Log will show the user's name in the Common Name column per session, (c) they can re-download or revoke this cert any time from the Client VPN sidebar page's 'Issued user certs' section. NEVER print any private key in chat.",
].join("\n");

const CLIENT_VPN_PLAYBOOK = [
  "## Client VPN — triggers: 'create vpn', 'client vpn', 'aws vpn', 'let me connect to rds from my laptop', 'openvpn into the vpc'",
  "SINGLE-BOX WIZARD FLOW — the `client-vpn-create` chat fence renders a paged, console-style Client VPN creation wizard: name + region + env + VPC, then subnets + client CIDR, then auth mode + cert mode (defaults to AUTO — Terraform generates the CA/server/client certs and imports into ACM, no easy-rsa needed), then tunnel options, then a review page, then one Create button that commits HCL + creates an approval. The box owns the ENTIRE flow — don't ask questions, don't emit options-form, don't call tools. Just emit the empty fence and stop.",
  "1. YOUR VERY NEXT MESSAGE after the trigger is EXACTLY this — no prose, no preamble:\n```client-vpn-create\n```",
  "2. STOP after emitting the fence. ClientVpnCreateBox takes over — VPC/subnet dropdowns are live, the cert-mode picker offers 'auto' (generate everything via Terraform tls provider) vs 'manual' (bring your own ACM ARNs), and it submits to /aws/client-vpn.",
  "3. AFTER the apply completes, report client_vpn_endpoint_id + client_vpn_dns_name + client_vpn_security_group_id + download_config_command from the real outputs. Tell the user: (a) run the download command to get the .ovpn file, (b) install AWS VPN Client or Tunnelblick, (c) for AUTO cert mode: run 'terraform output -raw client_certificate_pem', 'terraform output -raw client_private_key_pem', 'terraform output -raw ca_certificate_pem' LOCALLY and paste them into the .ovpn file between <cert></cert>, <key></key>, and <ca></ca> tags. NEVER print the private key output in chat — always tell the user to run terraform output locally. For MANUAL cert mode: hand out the client cert/key from easy-rsa. (d) IMPORTANT: to let VPN clients reach RDS/EC2 in the VPC, add an ingress rule on each target SG with source_security_group_id set to client_vpn_security_group_id (e.g. RDS SG: allow TCP/3306 from VPN SG; EC2 SG: allow TCP/22 from VPN SG). Prefer this SG-as-source pattern over CIDR-based rules.",
].join("\n");

/**
 * EC2 playbook — EC2-in-EXISTING-VPC, no VPC creation. Assumes the user has
 * a VPC ready. If they don't, tell them to run the VPC flow first (or use
 * the Network > VPCs page). Same split as AWS console — launching an EC2
 * requires picking an existing VPC + subnet.
 */
const EC2_PLAYBOOK = [
  "## EC2 — triggers: 'create ec2', 'new ec2 instance', 'launch an ec2', 'spin up an ec2', 'i need a linux box in aws'",
  "SINGLE-BOX WIZARD FLOW — the dedicated `ec2-create` chat fence renders a paged, console-style launch wizard (same UX as `eks-create` / `gke-create` / `aks-create`): stepper header, Back/Next between pages, real dropdowns for region + VPC + subnet + AMI + instance type + SSH, review page, one Launch button that commits HCL + creates an approval, then an ApprovalCard renders inline. The box owns the ENTIRE flow — you don't ask any questions, you don't emit any options-form, you don't call any tools. Just emit the empty fence and stop.",
  "1. YOUR VERY NEXT MESSAGE after the trigger is EXACTLY this — nothing else, no prose, no preamble, no gatekeeping, no 'let me help you launch an EC2 instance':\n```ec2-create\n```",
  "2. STOP after emitting the fence. The Ec2CreateBox component takes over — it fetches VPCs/subnets live, does field validation, submits to /aws/ec2 (which commits + creates the approval), and renders an ApprovalCard inline on approval. The user's next message to you happens AFTER they've approved and the apply completed.",
  "3. AFTER the apply completes (the user's next chat turn tells you or you can check deployment_status if they ask), report instance_id + public_ip + ssm_command from the real outputs — that command is a one-liner the user pastes into a terminal to shell in with no SSH port open. Never claim 'the EC2 is running' before the user's post-approval message actually arrives.",
].join("\n");

/**
 * Cross-region VPC peering playbook — AWS-only, same account. Wires two
 * EXISTING VPCs in different regions together. Assumes the user has already
 * created both VPCs (via generate_vpc_terraform or manually) and has
 * their ids + CIDRs ready.
 */
const VPC_PEERING_PLAYBOOK = [
  "## Cross-region VPC peering — triggers: 'peer two vpcs', 'connect vpc x to vpc y', 'cross region vpc peering', 'link vpcs across regions', 'set up vpc peering'",
  "TWO gates only: (gate A) the batch form in step 1 collects the two VPCs from the USER — NEVER guess or default them; (gate B) the approval-card in step 4 is the ONE click that runs terraform apply. Nothing else asks anything in between.",
  "PRECONDITIONS — verify BEFORE emitting the form: (a) the two VPCs must already exist (usually created via generate_vpc_terraform earlier — their outputs vpc_id / vpc_cidr / region are exactly what the user needs to paste), (b) they must be in DIFFERENT regions (same-region peering is a different resource shape, refuse it and tell the user), (c) their CIDRs must NOT overlap (identical or overlapping CIDRs can't route peered traffic — 10.0.0.0/16 vs 10.1.0.0/16 is a good split). If the user just created two vpc-ec2 stacks in this session, you can paraphrase their outputs to fill the defaults in the form.",
  '1. BATCH FORM — MANDATORY, NOT SKIPPABLE. The MOMENT the user asks to peer two VPCs, your VERY NEXT MESSAGE is EXACTLY the ```options-form``` fenced block below and NOTHING ELSE. Forbidden: asking one field at a time in prose; using defaults you invented without user confirmation; any preamble/summary before the fence. Fill only the bracketed defaults from context (from prior vpc-ec2 outputs in this session if available; otherwise leave the field empty so the user must fill it in):\n```options-form\n{"intro":"Peer two VPCs in different regions. Both VPCs must already exist and have non-overlapping CIDRs.","questions":[{"key":"name","question":"Peering name (short, dashes)","kind":"text","default":"cross-region-peer"},{"key":"env","question":"Environment","options":["dev","staging","prod"],"default":"<context default env>"},{"key":"leftRegion","question":"LEFT (requester) region","options":["us-east-1","us-east-2","us-west-2","eu-west-1","eu-central-1","ap-south-1","ap-southeast-1"],"default":"<first prior vpc region if any>"},{"key":"leftVpcId","question":"LEFT VPC id (vpc-<hex>)","kind":"text","default":"<first prior vpc_id if any>"},{"key":"leftCidr","question":"LEFT VPC CIDR","kind":"text","default":"<first prior vpc_cidr if any, else 10.0.0.0/16>"},{"key":"rightRegion","question":"RIGHT (accepter) region — MUST differ from LEFT","options":["us-east-1","us-east-2","us-west-2","eu-west-1","eu-central-1","ap-south-1","ap-southeast-1"],"default":"<second prior vpc region if any>"},{"key":"rightVpcId","question":"RIGHT VPC id","kind":"text","default":"<second prior vpc_id if any>"},{"key":"rightCidr","question":"RIGHT VPC CIDR (must not overlap LEFT)","kind":"text","default":"<second prior vpc_cidr if any, else 10.1.0.0/16>"}],"submitLabel":"Generate and commit to repo"}\n```\nTHE FORM RENDERER ONLY SUPPORTS TWO QUESTION SHAPES: fixed-choice pills OR free input {kind:"text"|"number"}. WAIT for the user to submit — they answer as ONE message.',
  "2. ONLY AFTER the user's submission arrives: call generate_vpc_peering_terraform(name, envKey, leftRegion, leftVpcId, leftCidr, rightRegion, rightVpcId, rightCidr) using their values. The tool validates the VPC-id shape, the CIDR shape, and refuses same-region + identical-CIDR cases — surface any error message plainly. NEVER hand-write peering HCL.",
  "3. IMMEDIATELY commit the returned files to the project's app repo — write_repo_file each file under `terraform/vpc-peering/<name>/` on the repo's default branch, commitMode direct (no PR). Tell the user in ONE line where the files landed, then proceed to step 4 in the SAME turn.",
  "4. GATE the actual APPLY — the ONE and ONLY approval. Call run_terraform action='plan' with the SAME files/stack, then request_infra_approval with those files/stack + cloud:'aws'. Note: the stack uses TWO aws providers (one per region) — that's normal and Terraform handles it. When status='pending_approval', respond with a fenced ```approval-card``` containing {\"approvalId\":\"<returned id>\"} and STOP. Do NOT also ask 'shall I apply?' in prose.",
  "4a. ANTI-FABRICATION CONTRACT — same as RDS/S3/VPC-EC2. Between emitting the approval-card and the user's post-approval message: NEVER say 'the peering is active', 'the connection has been established', 'apply is running', etc. Do NOT proceed to step 5 in the same turn as the approval-card.",
  "5. AFTER the apply completes and outputs are actually available, report peering_connection_id + peering_status (should be 'active') + the verify_command. Tell the user that instances in one VPC can now reach instances in the other by IP once each side's security groups also allow the peer CIDR — offer to open the SGs if they want.",
].join("\n");

/**
 * Azure context playbook — included only for projects with Azure connected.
 * Drives the subscription → resource group → region selection so the agent
 * always has the right scope before running any Azure command.
 */
const AZURE_PLAYBOOK = [
  "## Azure requests (VMs, resource groups, deploys) — establish context FIRST",
  "Before ANY Azure action, make sure you know the subscription, resource group, and (if creating) the region. Never guess them.",
  "0. If the 'Active Azure context' section above already has the values you need, USE them directly — do NOT re-run the selection. Only run the steps below for a value that's missing or when the user asks to change it.",
  "1. Subscription: call list_azure_subscriptions. If more than one, ask the user which via an ```options``` block (one option per subscription, label = name, plus 'Custom'). If only one, use it and say so.",
  "2. Resource group: call list_azure_resource_groups for the chosen subscription, then ask which via an ```options``` block (skip only for subscription-wide reads like 'list all VMs'). Offer 'Create new' + 'Custom' when relevant.",
  "3. Region (only when CREATING a resource): ask via an ```options``` block — East US, West Europe, Southeast Asia, Central US, Custom.",
  "4. As soon as the user picks subscription / resource group / region, call set_azure_context to SAVE them so you (and future chats) remember. Then for list_azure_vms pass the chosen resourceGroup (omit it only for a subscription-wide list).",
  "5. If no Azure account is connected, respond with an empty fenced ```cloud-connect``` block so the user can sign in with Microsoft right there in chat — don't guess.",
].join("\n");

/** GCP context playbook — included only for projects with GCP connected. */
const GCP_PLAYBOOK = [
  "## GCP requests (Compute instances, deploys) — establish the project FIRST",
  "GCP work always targets a specific GCP PROJECT. Never guess it.",
  "0. If the 'Active GCP context' above already has the project you need, USE it — don't re-ask. Only run selection when it's missing or the user wants to switch projects.",
  "1. Call list_gcp_projects. If more than one, ask the user which via an ```options``` block (label = name, value = projectId, plus 'Custom'). If only one, use it.",
  "2. Region (only when CREATING a resource): ask via an ```options``` block — us-central1, us-east1, europe-west1, asia-south1, Custom.",
  "3. As soon as the user picks the project/region, call set_gcp_context to SAVE it. Then list_gcp_instances uses that project automatically.",
  "4. If a tool reports the Compute Engine API is disabled, tell the user to enable it at console.cloud.google.com/apis/library/compute.googleapis.com for that project, then retry.",
  "5. If no GCP account is connected, respond with an empty fenced ```cloud-connect``` block so the user can sign in with Google right there in chat — don't guess.",
].join("\n");

/**
 * Compact knowledge-base context for a project. Token-budget-conscious: a few
 * recent docs, each truncated. Empty string when the project has no KB docs.
 */
async function loadKnowledgeContext(projectId: string): Promise<string> {
  try {
    const docs = await prisma.knowledgeDoc.findMany({
      where: { projectId },
      orderBy: { createdAt: "desc" },
      take: 8,
      select: { title: true, body: true, type: true },
    });
    const withBody = docs.filter((d) => (d.body ?? "").trim()).slice(0, 6);
    if (withBody.length === 0) return "";
    const parts = withBody.map(
      (d) =>
        `### ${d.title}${d.type ? ` (${d.type})` : ""}\n${(d.body ?? "").slice(0, 600).trim()}`,
    );
    return (
      "## Project knowledge base\n" +
      "Use these project docs/conventions when answering and when generating infrastructure:\n\n" +
      parts.join("\n\n")
    );
  } catch {
    return "";
  }
}

/**
 * Build the agent's system prompt: identity + project context + the standing
 * infra playbook + the project's knowledge base. Shared by the streaming and
 * non-streaming paths so they never drift.
 */
/**
 * List the project's environments that have a Kubernetes cluster connected, so
 * the agent knows which env key to pass to list_kubernetes_resources /
 * get_kubernetes_logs when the user says "list pods", "list nodes", etc.
 */
async function loadClusterContext(projectId: string): Promise<string> {
  try {
    const envs = await prisma.env.findMany({
      where: { projectId, kubeconfigRef: { not: null } },
      select: { key: true, name: true, namespace: true },
    });
    if (envs.length === 0) return "";
    const lines = envs.map(
      (e) => `- env "${e.key}"${e.name ? ` (${e.name})` : ""}, default namespace "${e.namespace}"`,
    );
    return (
      "## Connected Kubernetes clusters\n" +
      "These environments have a live cluster connected. When the user asks to list pods/nodes/services, get logs, etc., call list_kubernetes_resources / get_kubernetes_logs with the matching env key (no need to ask which env if there's only one):\n" +
      lines.join("\n")
    );
  } catch {
    return "";
  }
}

/**
 * The project's attached repo(s) — injected so the agent NEVER asks the user
 * for a repo name. One attached repo (the overwhelmingly common case) means
 * every repo-taking tool call uses it silently.
 */
async function loadRepoContext(projectId: string): Promise<string> {
  try {
    const repos = await prisma.repo.findMany({
      where: { deletedAt: null, projectRepos: { some: { projectId } } },
      select: { fullName: true, defaultBranch: true },
      orderBy: { createdAt: "asc" },
    });
    if (repos.length === 0) return "";
    if (repos.length === 1) {
      const r = repos[0];
      return (
        `## This project's app repository: ${r.fullName} (default branch "${r.defaultBranch || "main"}").\n` +
        `Every tool that takes repoFullName uses "${r.fullName}" — NEVER ask the user for the repo name; it is this one.`
      );
    }
    return (
      "## Attached repositories:\n" +
      repos
        .map((r) => `- ${r.fullName} (default branch "${r.defaultBranch || "main"}")`)
        .join("\n") +
      "\nIf the task needs ONE repo and the user didn't name it, ask which via an ```options``` block (one option per repo) — never free-text."
    );
  } catch {
    return "";
  }
}

/**
 * The project's DEFAULT deploy environment — the env with BOTH a cluster and a
 * cloud account connected. Injected so the agent deploys to it silently instead
 * of asking, even when other (non-deployable or cloud-less) envs exist.
 */
async function loadDeployEnvContext(projectId: string): Promise<string> {
  try {
    const envs = await prisma.env.findMany({
      where: { projectId },
      select: {
        key: true,
        name: true,
        namespace: true,
        kubeconfigRef: true,
        cloudProviderId: true,
      },
      orderBy: { createdAt: "asc" },
    });
    const deployable = envs.filter((e) => e.kubeconfigRef);
    if (deployable.length === 0) return "";
    // Fully wired = cluster + cloud account. That's where "deploy my app" goes.
    const full = deployable.filter((e) => e.cloudProviderId);
    const primary = full[0] ?? deployable[0];
    const others = deployable.filter((e) => e.key !== primary.key);
    return (
      `## DEFAULT deploy environment: "${primary.key}"${primary.name ? ` (${primary.name})` : ""}, namespace "${primary.namespace}".\n` +
      `It has the cluster${primary.cloudProviderId ? " AND the cloud account" : ""} connected — for every deploy/CI/CD flow use envKey "${primary.key}" SILENTLY and just state it; do NOT ask which environment.` +
      (others.length
        ? ` Only deploy to ${others.map((e) => `"${e.key}"`).join("/")} if the user EXPLICITLY names it${full.length < deployable.length ? " (note: envs without a cloud account can't do ECR/registry setup)" : ""}.`
        : "")
    );
  } catch {
    return "";
  }
}

/**
 * The project's SAVED Azure context (subscription / resource group / region).
 * Surfaced so the agent already knows the scope and doesn't re-ask every time.
 */
async function loadAzureContext(projectId: string): Promise<string> {
  try {
    const cp = await prisma.cloudProvider.findFirst({
      where: { projectId, kind: "azure" },
      select: { accountRef: true, resourceGroup: true, region: true, cloudEnvironment: true },
    });
    if (!cp) return "";
    return [
      "## Active Azure context for this project",
      `- Subscription: ${cp.accountRef}`,
      `- Resource group: ${cp.resourceGroup ?? "(not set — ask the user to pick one)"}`,
      `- Region: ${cp.region}`,
      `- Cloud environment: ${cp.cloudEnvironment}`,
      "Use this saved context for Azure commands without re-asking. Only run the subscription/resource-group/region selection flow if a value is missing or the user wants to change it — and call set_azure_context after they pick.",
    ].join("\n");
  } catch {
    return "";
  }
}

/** The project's SAVED GCP context (project + region). */
async function loadGcpContext(projectId: string): Promise<string> {
  try {
    const cp = await prisma.cloudProvider.findFirst({
      where: { projectId, kind: "gcp" },
      select: { accountRef: true, region: true },
    });
    if (!cp) return "";
    return [
      "## Active GCP context for this project",
      `- GCP project: ${cp.accountRef}`,
      `- Region: ${cp.region}`,
      "Use this saved project for GCP commands without re-asking. Only run the project/region selection flow if the user wants to switch — and call set_gcp_context after they pick.",
    ].join("\n");
  } catch {
    return "";
  }
}

async function buildSystemPrompt(projectId: string): Promise<string> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { name: true, slug: true, description: true },
  });
  const kb = await loadKnowledgeContext(projectId);
  const clusters = await loadClusterContext(projectId);
  const repoCtx = await loadRepoContext(projectId);
  const deployEnvCtx = await loadDeployEnvContext(projectId);

  // ISOLATION: tell the agent which clouds THIS project is connected to. Only
  // the matching cloud tools are exposed, so it must not offer/assume others.
  const clouds = await getProjectClouds(projectId);
  const cloudLine =
    clouds.size > 0
      ? `## Connected clouds for this project: ${[...clouds].map((c) => c.toUpperCase()).join(", ")}. Only act on these. You have tools ONLY for the connected cloud(s); this project is NOT connected to the others, so don't try them or ask for their accounts.`
      : "## This project has NO cloud account connected yet. If the user asks about cloud resources (VMs, EC2, etc.), respond with an empty fenced ```cloud-connect``` block so they can connect an account right there in chat — don't guess.";
  const azureCtx = clouds.has("azure") ? await loadAzureContext(projectId) : "";
  const gcpCtx = clouds.has("gcp") ? await loadGcpContext(projectId) : "";

  // ISOLATION: which git host(s) this project's repos live on. GitLab repos use
  // merge requests + .gitlab-ci.yml, and keyless cloud-registry OIDC isn't wired
  // for GitLab yet — so a GitLab-only project must not be offered GitHub OIDC.
  const gitProviders = await getProjectGitProviders(projectId);
  const hasGitlab = gitProviders.has("gitlab");
  const hasGithub = gitProviders.has("github");
  const gitlabOnly = hasGitlab && !hasGithub;
  const gitLine =
    gitProviders.size === 0
      ? ""
      : `## Source control for this project: ${[...gitProviders].map((p) => (p === "gitlab" ? "GitLab" : "GitHub")).join(", ")}.` +
        (hasGitlab
          ? " For GitLab repos, write_repo_file opens a MERGE REQUEST (not a pull request), and generate_ci_workflow produces a single .gitlab-ci.yml (build/test + Trivy). Keyless cloud-registry (ECR/GAR/ACR) OIDC federation is NOT available for GitLab yet — if the user needs registry push from GitLab CI, tell them to add registry credentials as CI/CD variables (or use a GitHub repo for that flow); don't offer the GitHub OIDC tools for GitLab repos."
          : "") +
        (hasGithub && !hasGitlab ? " Use pull requests and GitHub Actions workflows." : "");

  return [
    "You are Deep Agent, an AI assistant inside a DevOps platform called DeepAgent.",
    "You help engineers reason about their infrastructure, repositories, deployments and cloud resources.",
    project
      ? `Current project: "${project.name}" (slug: ${project.slug}). ${project.description ?? ""}`.trim()
      : "",
    "Be concise. When you don't know something specific about the user's infra, say so plainly rather than guess.",
    cloudLine,
    clouds.has("proxmox")
      ? "## This project runs on Proxmox (on-prem). When the user asks to CREATE A VM, respond with an empty fenced block ```proxmox-vm``` on its own lines — the UI renders an interactive VM-creation form in the chat there (env, name, cores, memory, disk, template/ISO, repo). Don't hand-write VM Terraform in chat; that form (and the provision_proxmox_vm tool) generate + apply it. Every VM the tool creates boots deploy-ready — cloud-init adds the project's `deploy` user + SSH key and installs Docker."
      : "",
    clouds.has("proxmox") && hasGithub
      ? "## DEPLOYING AN APP TO A PROXMOX VM. When the user says 'deploy my app to the Proxmox VM' (or similar): ASK via ```options``` for the missing pieces one at a time — which repo (if >1 attached), which VM (host IP/DNS), app name, container port. Then call deploy_to_proxmox_vm(repoFullName, appName, port, vmHost, optional branch/dockerfile/dockerContext/extraDockerArgs) — it (a) mints/reuses the project deploy keypair, (b) sets VM_HOST + VM_SSH_KEY repo secrets, (c) opens ONE PR with the GitHub Actions workflow + systemd unit + deploy.sh. On merge (or workflow_dispatch), the workflow builds the image, pushes to GHCR (uses the built-in GITHUB_TOKEN — no cloud registry needed), SSHes into the VM, and restarts the systemd-managed container. NEVER hand-write the workflow or systemd unit — the tool is deterministic. For one-off ops on the VM (docker ps, journalctl -u <app>, systemctl status), use run_vm_command(host, command)."
      : "",
    clouds.has("aws")
      ? "## When the user asks to CREATE a brand-new EKS cluster, respond with an empty fenced ```eks-create``` block on its own lines — an interactive create-cluster form renders in chat. Don't hand-write EKS Terraform in chat."
      : "",
    clouds.has("gcp")
      ? "## When the user asks to CREATE a brand-new GKE cluster, respond with an empty fenced ```gke-create``` block on its own lines — an interactive create-cluster form renders in chat. Don't hand-write GKE Terraform in chat."
      : "",
    clouds.has("azure")
      ? "## When the user asks to CREATE a brand-new AKS cluster, respond with an empty fenced ```aks-create``` block on its own lines — an interactive create-cluster form renders in chat. Don't hand-write AKS Terraform in chat."
      : "",
    clouds.size > 0
      ? "## When the user wants to CONNECT an EXISTING Kubernetes cluster (not provision a new one), respond with an empty fenced ```cluster-connect``` block on its own lines — an interactive connect form (cloud, environment, region/resource-group/project, cluster name, or paste-kubeconfig fallback) renders in chat."
      : "",
    "## App secrets (DATABASE_URL, API keys, etc.): NEVER call set_app_secret with a value the user typed in chat — that value would leak into the chat transcript. Instead respond with an empty fenced ```secret-entry``` block on its own lines; the UI renders a masked key/value form that posts the value directly, bypassing the model entirely. Use list_app_secrets / sync_app_secrets as normal (those never touch a raw value).",
    "## Environments: use list_environments / create_environment / update_environment / delete_environment to manage them from chat — ask the key/name/production-flag via ```options``` if not given, everything else has defaults. Cluster wiring for an environment happens separately via ```cluster-connect``` or a create-cluster fence, not through these tools.",
    "## Repos: use list_available_repos to show repos not yet attached to this project (offer them via ```options```), then attach_project_repo to wire the chosen one in. Pass asOnly=true only when the user is REPLACING the project's repo, not adding an additional one.",
    "## Manually triggering a pipeline run (repo + branch + env, outside the normal CI workflow) uses trigger_pipeline. If it returns an approvalId, respond with a fenced ```approval-card``` block containing that id so the user can approve it in chat.",
    hasGithub
      ? '## CI/CD & deploy setup — ASK THE MODE FIRST. When the user asks to set up CI/CD or deploy their app end-to-end, FIRST ask exactly ONE question via an ```options``` block: {"question":"How should I set this up?","options":["Fully automated — analyze my repo and generate everything","Form — let me fill the settings myself"],"key":"setupMode"} and WAIT. If they pick the FORM (or explicitly ask for the form/box), respond with an EMPTY fenced block ```cicd-setup``` on its own lines — the UI renders the deterministic setup form in chat (repo, stack, image name, branch, files to write, Trivy gate, deploy env); it generates everything production-style and opens ONE PR. If they pick FULLY AUTOMATED, follow the full-pipeline playbook (deploy_my_app analyzes the repo and writes all the files itself) — do NOT emit the fence. In BOTH modes, after the user merges the PR, continue with the build + server-side deploy steps of the full-pipeline playbook. NEVER ask the settings one-by-one and never hand-write the files.'
      : "",
    hasGithub
      ? "## GitHub secrets are automatable: you CAN create/update GitHub Actions repository secrets yourself with the set_github_actions_secret tool (it encrypts the value with the repo's public key and PUTs it via GitHub's Secrets API — the same mechanism the app already uses for KUBECONFIG_B64). If a workflow needs a secret (e.g. AWS_ROLE_ARN, a registry token, KUBECONFIG_B64), SET IT with that tool and tell the user it's done. NEVER tell the user that secrets must be added manually, or that bots/agents/GitHub don't allow programmatic secret creation — that is FALSE. (Still prefer keyless OIDC — an inline role-to-assume in the workflow, no stored secret — when the registry/cloud supports it, which the generated ECR/GAR/ACR workflows already do.)"
      : "",
    gitLine,
    repoCtx,
    deployEnvCtx,
    azureCtx,
    gcpCtx,
    INFRA_PLAYBOOK,
    MANIFEST_PLAYBOOK,
    HELM_PLAYBOOK,
    CI_PLAYBOOK,
    (clouds.has("gcp") || clouds.has("azure")) && !gitlabOnly ? CI_REGISTRY_PLAYBOOK : "",
    clouds.size > 0 ? DEPLOY_APP_PLAYBOOK : "",
    clouds.size > 0 ? DEPLOY_PIPELINE_PLAYBOOK : "",
    clouds.size > 0 ? ROLLBACK_PLAYBOOK : "",
    clouds.has("aws") ? DATABASE_PLAYBOOK : "",
    clouds.has("aws") ? S3_PLAYBOOK : "",
    clouds.has("aws") ? VPC_PLAYBOOK : "",
    clouds.has("aws") ? EC2_PLAYBOOK : "",
    clouds.has("aws") ? VPC_PEERING_PLAYBOOK : "",
    clouds.has("aws") ? CLIENT_VPN_PLAYBOOK : "",
    clouds.has("aws") ? VPN_CERTIFICATES_PLAYBOOK : "",
    clouds.has("aws") ? ISSUE_VPN_USER_CERT_PLAYBOOK : "",
    clouds.has("aws") ? JENKINS_PROVISION_PLAYBOOK : "",
    clouds.has("azure") ? AZURE_PLAYBOOK : "",
    clouds.has("azure") ? AZURE_VNET_PLAYBOOK : "",
    clouds.has("azure") ? AZURE_VM_PLAYBOOK : "",
    clouds.has("azure") ? AZURE_VPN_PLAYBOOK : "",
    clouds.has("gcp") ? GCP_PLAYBOOK : "",
    clouds.has("gcp") ? GCP_VPC_PLAYBOOK : "",
    clouds.has("gcp") ? GCP_VM_PLAYBOOK : "",
    clouds.has("gcp") ? GCP_VPN_PLAYBOOK : "",
    clusters,
    kb,
  ]
    .filter(Boolean)
    .join("\n\n");
}

/**
 * Resolve which Claude model to use for this project.
 *
 * Priority:
 *   1. Project's `ProjectSetting.defaultModel.name`         (per-project pick)
 *   2. `Model` row with `isDefault=true && enabled=true`    (admin default)
 *   3. `DDA_AGENT_MODEL` env var                            (server override)
 *   4. FALLBACK_MODEL                                       (hardcoded)
 *
 * Disabled / soft-deleted models are skipped — the chain advances. This
 * means the admin can flip `enabled=false` on a model and the next-in-line
 * automatically takes over without anyone editing code.
 */
async function resolveModel(projectId: string): Promise<ResolvedModel> {
  try {
    const setting = await prisma.projectSetting.findUnique({
      where: { projectId },
      select: {
        defaultModel: { select: { name: true, provider: true, enabled: true } },
      },
    });
    if (setting?.defaultModel?.enabled && setting.defaultModel.name) {
      return {
        name: setting.defaultModel.name,
        provider: setting.defaultModel.provider,
      };
    }
    const platformDefault = await prisma.model.findFirst({
      where: { isDefault: true, enabled: true },
      select: { name: true, provider: true },
    });
    if (platformDefault?.name) {
      return { name: platformDefault.name, provider: platformDefault.provider };
    }
  } catch {
    /* Model table not migrated yet — fall through to env / fallback. */
  }
  // Env override: DDA_AGENT_MODEL=openai:gpt-4o, groq:llama-3.3-70b-versatile,
  // or just the bare model id (provider inferred from the slug).
  const env = process.env.DDA_AGENT_MODEL;
  if (env) {
    const [maybeProvider, ...rest] = env.split(":");
    if (rest.length > 0 && maybeProvider) {
      const p = maybeProvider.toLowerCase();
      const provider =
        p === "openai"
          ? "OpenAI"
          : p === "anthropic"
            ? "Anthropic"
            : p === "groq"
              ? "Groq"
              : p === "google" || p === "gemini"
                ? "Google"
                : null;
      if (provider) return { name: rest.join(":"), provider };
    }
    return inferProvider(env);
  }
  return FALLBACK_MODEL;
}

function inferProvider(name: string): ResolvedModel {
  const n = name.toLowerCase();
  if (n.startsWith("gpt") || n.startsWith("o1") || n.startsWith("o3") || n.startsWith("o4")) {
    return { name, provider: "OpenAI" };
  }
  if (n.startsWith("gemini") || n.startsWith("models/gemini")) {
    return { name, provider: "Google" };
  }
  if (
    n.startsWith("llama") ||
    n.startsWith("mixtral") ||
    n.startsWith("gemma") ||
    n.startsWith("qwen") ||
    n.startsWith("deepseek") ||
    n.includes("-groq")
  ) {
    return { name, provider: "Groq" };
  }
  return { name, provider: "Anthropic" };
}

let _anthropic: Anthropic | null = null;
function client(): Anthropic {
  if (_anthropic) return _anthropic;
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY env var is not set.");
  _anthropic = new Anthropic({ apiKey });
  return _anthropic;
}

let _openai: OpenAI | null = null;
function openaiClient(): OpenAI {
  if (_openai) return _openai;
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY env var is not set.");
  _openai = new OpenAI({ apiKey });
  return _openai;
}

/**
 * Groq exposes an OpenAI-compatible Chat Completions API at a different
 * base URL. We can reuse the OpenAI SDK + the OpenAI tool-use loop verbatim;
 * just swap the client.
 */
let _groq: OpenAI | null = null;
function groqClient(): OpenAI {
  if (_groq) return _groq;
  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) throw new Error("GROQ_API_KEY env var is not set.");
  _groq = new OpenAI({
    apiKey,
    baseURL: "https://api.groq.com/openai/v1",
  });
  return _groq;
}

/**
 * Google's Gemini exposes an OpenAI-compatible Chat Completions API (with
 * function calling) at a dedicated base URL. Same deal as Groq — reuse the
 * OpenAI SDK + tool-use loop verbatim, just swap the client + key.
 */
let _gemini: OpenAI | null = null;
function geminiClient(): OpenAI {
  if (_gemini) return _gemini;
  const apiKey = process.env.GEMINI_API_KEY || process.env.GOOGLE_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY env var is not set.");
  _gemini = new OpenAI({
    apiKey,
    baseURL: "https://generativelanguage.googleapis.com/v1beta/openai/",
  });
  return _gemini;
}

/** Pick the OpenAI-shaped client for a given provider (OpenAI / Groq / Google). */
function openAIShapedClient(provider: ResolvedModel["provider"]): OpenAI {
  if (provider === "Groq") return groqClient();
  if (provider === "Google") return geminiClient();
  return openaiClient();
}

/** Convert ALL_TOOLS to OpenAI's `function` tool format. */
function toOpenAITools(list: Tool[] = ALL_TOOLS): OpenAI.Chat.Completions.ChatCompletionTool[] {
  return list.map((t) => ({
    type: "function" as const,
    function: {
      name: t.name,
      description: t.description,
      parameters: t.inputSchema as Record<string, unknown>,
    },
  })) as unknown as OpenAI.Chat.Completions.ChatCompletionTool[];
}

/** The clouds (aws/azure/gcp) this project has connected — drives tool + prompt isolation. */
async function getProjectClouds(projectId: string): Promise<Set<string>> {
  try {
    const rows = await prisma.cloudProvider.findMany({
      where: { projectId },
      select: { kind: true },
      distinct: ["kind"],
    });
    return new Set(rows.map((r) => r.kind));
  } catch {
    return new Set();
  }
}

/** The git providers (github/gitlab) this project has attached repos for — drives tool + prompt isolation. */
async function getProjectGitProviders(projectId: string): Promise<Set<string>> {
  try {
    const rows = await prisma.projectRepo.findMany({
      where: { projectId, repo: { deletedAt: null } },
      select: { repo: { select: { provider: true } } },
    });
    return new Set(rows.map((r) => r.repo.provider));
  } catch {
    return new Set();
  }
}

/**
 * One-shot, tool-free completion using the project's resolved model. Used by
 * non-chat features (e.g. the CI auto-heal reviewer) that just need the model
 * to transform text. Returns the raw assistant text.
 */
export async function completeText(args: {
  projectId: string;
  system: string;
  prompt: string;
  maxTokens?: number;
}): Promise<{ ok: true; text: string } | { ok: false; error: string }> {
  const model = await resolveModel(args.projectId);
  const max = args.maxTokens ?? MAX_OUTPUT_TOKENS;
  try {
    if (model.provider === "OpenAI" || model.provider === "Groq" || model.provider === "Google") {
      const completion = await openAIShapedClient(model.provider).chat.completions.create({
        model: model.name,
        max_tokens: max,
        messages: [
          { role: "system", content: args.system },
          { role: "user", content: args.prompt },
        ],
      });
      return { ok: true, text: completion.choices[0]?.message?.content?.trim() ?? "" };
    }
    const completion = await client().messages.create({
      model: model.name,
      max_tokens: max,
      system: args.system,
      messages: [{ role: "user", content: args.prompt }],
    });
    const text = completion.content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("")
      .trim();
    return { ok: true, text };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "completion failed" };
  }
}

export type AgentRunResult =
  | { ok: true; agentMessageId: string; text: string }
  | { ok: false; code: "missing_api_key" | "thread_not_found" | "upstream_error"; message: string };

export type AgentStreamEvent =
  | { type: "delta"; text: string }
  | { type: "tool_call_start"; toolUseId: string; name: string }
  | { type: "tool_call_input"; toolUseId: string; input: unknown }
  | { type: "tool_call_result"; toolUseId: string; ok: boolean; summary: string }
  | { type: "turn_end"; reason: string }
  | { type: "done"; agentMessageId: string; text: string }
  | {
      type: "error";
      code: "missing_api_key" | "thread_not_found" | "upstream_error";
      message: string;
    };

const MAX_TOOL_LOOPS = 10;

/**
 * Run one turn of the agent inside a thread. Caller should already have
 * persisted the user's message; this function loads the last N messages
 * (including the just-posted user one), calls Claude, then writes the agent's
 * reply back to the same thread.
 */
/**
 * Deterministic first step of the deploy flow. When the user's message IS a
 * deploy request ("deploy my app"), the reply must be the mode question — every
 * time, as clickable options. Models (especially cheaper ones) skip it when the
 * conversation already contains an earlier deploy, so we don't ask the model at
 * all: the route returns this canned ```options``` block directly. The user's
 * button click arrives as the next message and the model takes over from there.
 */
const DEPLOY_MODE_QUESTION =
  '```options\n{"question":"How should I set this up?","options":["Fully automated — analyze my repo and generate everything","Form — let me fill the settings myself"],"key":"setupMode"}\n```';

function deployModeIntercept(history: Array<{ role: string; text: string }>): string | null {
  const last = history[history.length - 1];
  if (!last || last.role !== "user") return null;
  const msg = last.text.trim();
  // Long messages carry extra intent (env, host, "without questions") — let the model handle those.
  if (msg.length > 80) return null;
  const isDeploy =
    /^(please\s+|pls\s+|can you\s+|i want to\s+)*(deploy|ship|launch)\s+(my|the|this)\s+(app|application|repo|project)\b/i.test(
      msg,
    );
  if (!isDeploy) return null;
  // The user already picked a mode in the same breath → no question needed.
  if (/fully automated|form|chatbox|chat box/i.test(msg)) return null;
  return DEPLOY_MODE_QUESTION;
}

export async function runAgentTurn(args: {
  projectId: string;
  threadId: string;
  agentId?: string | null;
}): Promise<AgentRunResult> {
  // No unconditional Anthropic gate here — the per-provider key check below
  // (and the Anthropic client() initializer) handle the key for whichever
  // provider the resolved model uses. This lets a Groq-only / OpenAI-only
  // deployment run without an ANTHROPIC_API_KEY set.

  const thread = await prisma.chatThread.findFirst({
    where: { id: args.threadId, projectId: args.projectId },
    select: { id: true },
  });
  if (!thread) {
    return { ok: false, code: "thread_not_found", message: "Thread not found." };
  }

  // Pull the last N messages oldest-first so Claude sees the conversation in
  // the right order.
  const history = await prisma.chatMessage.findMany({
    where: { threadId: args.threadId, role: { in: ["user", "agent"] } },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
    select: { role: true, text: true },
  });
  history.reverse();

  // Deterministic deploy-mode question — never left to the model (see helper).
  const intercept = deployModeIntercept(history);
  if (intercept) {
    const saved = await prisma.chatMessage.create({
      data: {
        projectId: args.projectId,
        threadId: args.threadId,
        role: "agent",
        agentId: args.agentId ?? null,
        text: intercept,
      },
      select: { id: true },
    });
    await prisma.chatThread.update({
      where: { id: args.threadId },
      data: { updatedAt: new Date() },
    });
    return { ok: true, agentMessageId: saved.id, text: intercept };
  }

  // Identity + project context + standing infra playbook + knowledge base.
  const system = await buildSystemPrompt(args.projectId);

  const messages = history.map((m) => ({
    role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
    content: m.text,
  }));

  let text: string;
  const model = await resolveModel(args.projectId);
  try {
    if (model.provider === "OpenAI" || model.provider === "Groq" || model.provider === "Google") {
      const requiredKey =
        model.provider === "Groq"
          ? "GROQ_API_KEY"
          : model.provider === "Google"
            ? "GEMINI_API_KEY"
            : "OPENAI_API_KEY";
      if (!process.env[requiredKey]) {
        return {
          ok: false,
          code: "missing_api_key",
          message: `${requiredKey} isn't configured on the server.`,
        };
      }
      const completion = await openAIShapedClient(model.provider).chat.completions.create({
        model: model.name,
        max_tokens: MAX_OUTPUT_TOKENS,
        messages: [
          { role: "system", content: system },
          ...messages.map((m) => ({
            role: m.role as "user" | "assistant",
            content: m.content as string,
          })),
        ],
      });
      text = completion.choices[0]?.message?.content?.trim() ?? "";
    } else {
      const completion = await client().messages.create({
        model: model.name,
        max_tokens: MAX_OUTPUT_TOKENS,
        system,
        messages,
      });
      text = completion.content
        .map((block) => (block.type === "text" ? block.text : ""))
        .join("")
        .trim();
    }
    if (!text) text = "(no response)";
  } catch (err) {
    return {
      ok: false,
      code: "upstream_error",
      message: err instanceof Error ? err.message : "Unknown upstream error.",
    };
  }

  const saved = await prisma.chatMessage.create({
    data: {
      projectId: args.projectId,
      threadId: args.threadId,
      role: "agent",
      agentId: args.agentId ?? null,
      text,
    },
    select: { id: true },
  });
  await prisma.chatThread.update({
    where: { id: args.threadId },
    data: { updatedAt: new Date() },
  });

  return { ok: true, agentMessageId: saved.id, text };
}

/**
 * Streaming variant of `runAgentTurn`. Yields events the SSE endpoint can
 * forward verbatim to the browser. Persists the final assistant message in
 * the `done` event right before yielding it, so the client can read its id
 * and treat the streamed message as canonical.
 */
export async function* runAgentTurnStream(args: {
  projectId: string;
  threadId: string;
  agentId?: string | null;
  userId: string;
}): AsyncGenerator<AgentStreamEvent, void, void> {
  const thread = await prisma.chatThread.findFirst({
    where: { id: args.threadId, projectId: args.projectId },
    select: { id: true },
  });
  if (!thread) {
    yield { type: "error", code: "thread_not_found", message: "Thread not found." };
    return;
  }

  const model = await resolveModel(args.projectId);

  // Per-provider API key gate. We do this BEFORE preparing messages so a
  // missing key fails fast rather than after a DB read.
  const keyEnvForProvider: Record<string, string> = {
    Anthropic: "ANTHROPIC_API_KEY",
    OpenAI: "OPENAI_API_KEY",
    Groq: "GROQ_API_KEY",
    Google: "GEMINI_API_KEY",
  };
  const requiredKey = keyEnvForProvider[model.provider];
  if (requiredKey && !process.env[requiredKey]) {
    yield {
      type: "error",
      code: "missing_api_key",
      message: `${requiredKey} isn't configured on the server.`,
    };
    return;
  }
  if (!requiredKey) {
    yield {
      type: "error",
      code: "upstream_error",
      message: `Provider "${model.provider}" isn't supported by the agent runtime yet.`,
    };
    return;
  }

  const history = await prisma.chatMessage.findMany({
    where: { threadId: args.threadId, role: { in: ["user", "agent"] } },
    orderBy: { createdAt: "desc" },
    take: HISTORY_LIMIT,
    select: { role: true, text: true },
  });
  history.reverse();

  // Deterministic deploy-mode question — never left to the model (see helper).
  const intercepted = deployModeIntercept(history);
  if (intercepted) {
    yield { type: "delta", text: intercepted };
    const saved = await prisma.chatMessage.create({
      data: {
        projectId: args.projectId,
        threadId: args.threadId,
        role: "agent",
        agentId: args.agentId ?? null,
        text: intercepted,
      },
      select: { id: true },
    });
    await prisma.chatThread.update({
      where: { id: args.threadId },
      data: { updatedAt: new Date() },
    });
    yield { type: "done", agentMessageId: saved.id, text: intercepted };
    return;
  }

  // Identity + project context + standing infra playbook + knowledge base.
  const system = await buildSystemPrompt(args.projectId);

  const userAssistantHistory = history.map((m) => ({
    role: (m.role === "user" ? "user" : "assistant") as "user" | "assistant",
    text: m.text,
  }));

  // ISOLATION: only expose tools for the clouds AND git providers THIS project
  // uses (agnostic tools are always included). An Azure-only project never sees
  // AWS tools; a GitLab-only project never sees GitHub-Actions OIDC tools — so
  // the agent can't fumble onto the wrong provider, and the smaller tool set
  // makes the model respond faster.
  const clouds = await getProjectClouds(args.projectId);
  const gitProviders = await getProjectGitProviders(args.projectId);
  const projectTools = toolsForProject({ clouds, gitProviders });

  // Dispatch to the provider's tool-use loop. Each implementation yields the
  // same AgentStreamEvent shape, and the accumulator below survives across
  // multiple tool-loop turns so the final text is the full assistant reply.
  let accumulated = "";
  const innerLoop =
    model.provider === "OpenAI" || model.provider === "Groq" || model.provider === "Google"
      ? runOpenAILoop({
          model: model.name,
          system,
          history: userAssistantHistory,
          projectId: args.projectId,
          userId: args.userId,
          provider: model.provider,
          tools: projectTools,
        })
      : runAnthropicLoop({
          model: model.name,
          system,
          history: userAssistantHistory,
          projectId: args.projectId,
          userId: args.userId,
          tools: projectTools,
        });

  for await (const ev of innerLoop) {
    if (ev.type === "delta") accumulated += ev.text;
    if (ev.type === "error") {
      yield ev;
      return;
    }
    yield ev;
  }

  const finalText = accumulated.trim() || "(no response)";
  const saved = await prisma.chatMessage.create({
    data: {
      projectId: args.projectId,
      threadId: args.threadId,
      role: "agent",
      agentId: args.agentId ?? null,
      text: finalText,
    },
    select: { id: true },
  });
  await prisma.chatThread.update({
    where: { id: args.threadId },
    data: { updatedAt: new Date() },
  });

  yield { type: "done", agentMessageId: saved.id, text: finalText };
}

type ProviderLoopArgs = {
  model: string;
  system: string;
  history: Array<{ role: "user" | "assistant"; text: string }>;
  projectId: string;
  userId: string;
  /** Tools available for this project (already filtered to its connected clouds). */
  tools: Tool[];
};

async function* runAnthropicLoop(
  args: ProviderLoopArgs,
): AsyncGenerator<AgentStreamEvent, void, void> {
  const messages: MessageParam[] = args.history.map((m) => ({
    role: m.role,
    content: m.text,
  }));
  const tools = toAnthropicTools(args.tools);
  const toolCtx = { projectId: args.projectId, userId: args.userId };

  loop: for (let turn = 0; turn < MAX_TOOL_LOOPS; turn++) {
    // Per-turn buffers: tool_use blocks the model emits, plus a small map
    // from content_block_index -> running input-json string we accumulate
    // from `input_json_delta` events.
    const toolUseBlocks: Array<{ id: string; name: string; input: unknown }> = [];
    const inputJsonByIndex = new Map<number, string>();
    const idByIndex = new Map<number, string>();
    const nameByIndex = new Map<number, string>();
    let stopReason: string = "end_turn";

    try {
      const stream = client().messages.stream({
        model: args.model,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: args.system,
        messages,
        tools,
      });

      for await (const event of stream) {
        if (event.type === "content_block_start") {
          const block = event.content_block;
          if (block.type === "tool_use") {
            idByIndex.set(event.index, block.id);
            nameByIndex.set(event.index, block.name);
            inputJsonByIndex.set(event.index, "");
            yield {
              type: "tool_call_start",
              toolUseId: block.id,
              name: block.name,
            };
          }
        } else if (event.type === "content_block_delta") {
          if (event.delta.type === "text_delta") {
            yield { type: "delta", text: event.delta.text };
          } else if (event.delta.type === "input_json_delta") {
            const cur = inputJsonByIndex.get(event.index) ?? "";
            inputJsonByIndex.set(event.index, cur + event.delta.partial_json);
          }
        } else if (event.type === "content_block_stop") {
          // If this block was a tool_use, the input JSON is now complete.
          if (idByIndex.has(event.index)) {
            const raw = inputJsonByIndex.get(event.index) ?? "{}";
            let parsed: unknown = {};
            try {
              parsed = JSON.parse(raw || "{}");
            } catch {
              parsed = {};
            }
            const id = idByIndex.get(event.index)!;
            const name = nameByIndex.get(event.index)!;
            toolUseBlocks.push({ id, name, input: parsed });
            yield { type: "tool_call_input", toolUseId: id, input: parsed };
          }
        } else if (event.type === "message_delta") {
          if (event.delta.stop_reason) stopReason = event.delta.stop_reason;
        }
      }

      // The SDK exposes the final assembled message — we need its `content`
      // (text + tool_use blocks) to push back into `messages` so the next
      // turn has full context.
      const finalMessage = await stream.finalMessage();
      messages.push({ role: "assistant", content: finalMessage.content });
      yield { type: "turn_end", reason: stopReason };
    } catch (err) {
      yield {
        type: "error",
        code: "upstream_error",
        message: err instanceof Error ? err.message : "Unknown upstream error.",
      };
      return;
    }

    // If Claude didn't request tools, we're done.
    if (stopReason !== "tool_use" || toolUseBlocks.length === 0) {
      break loop;
    }

    // Execute every tool call sequentially, build the tool_result content
    // for the next turn.
    const resultContent: ContentBlockParam[] = [];
    for (const tu of toolUseBlocks) {
      const res = await executeTool(tu.name, tu.input, toolCtx);
      const payload = res.ok ? res.output : { error: res.error };
      const summary = res.ok
        ? `Returned ${JSON.stringify(res.output).length} bytes of JSON.`
        : `Error: ${res.error}`;
      yield {
        type: "tool_call_result",
        toolUseId: tu.id,
        ok: res.ok,
        summary,
      };
      resultContent.push({
        type: "tool_result",
        tool_use_id: tu.id,
        content: JSON.stringify(payload),
        is_error: !res.ok,
      });
    }
    messages.push({ role: "user", content: resultContent });
    // Continue loop — Claude will read the tool results and respond again.
  }
}

/**
 * OpenAI tool-use loop. Uses Chat Completions streaming, which yields
 * deltas with either `content` (text token) or `tool_calls` (function-call
 * fragments). We accumulate tool_call.function.arguments JSON chunks per
 * index, execute the tools when the message stops with
 * finish_reason="tool_calls", and feed the results back as `role: "tool"`
 * messages — the format the API expects.
 */
async function* runOpenAILoop(
  args: ProviderLoopArgs & { provider: ResolvedModel["provider"] },
): AsyncGenerator<AgentStreamEvent, void, void> {
  const messages: OpenAI.Chat.Completions.ChatCompletionMessageParam[] = [
    { role: "system", content: args.system },
    ...args.history.map(
      (m) =>
        ({ role: m.role, content: m.text }) as OpenAI.Chat.Completions.ChatCompletionMessageParam,
    ),
  ];
  const tools = toOpenAITools(args.tools);
  const toolCtx = { projectId: args.projectId, userId: args.userId };
  // Groq + OpenAI share the same Chat Completions wire format, so the same
  // streaming loop works for both — only the client differs.
  const provider = openAIShapedClient(args.provider);

  for (let turn = 0; turn < MAX_TOOL_LOOPS; turn++) {
    let assistantText = "";
    // Per-turn buffers — OpenAI streams tool_calls in fragments keyed by index.
    type ToolBuf = { id: string; name: string; argsJson: string; yieldedStart: boolean };
    const buffers: Record<number, ToolBuf> = {};
    let finishReason: string = "stop";

    // Groq's llama models intermittently emit a malformed tool call that the
    // API rejects (400 "Failed to call a function … failed_generation"), and
    // free tiers throw 503 "over capacity". Both are transient — retry the SAME
    // turn a few times so the agent self-recovers instead of hard-failing.
    const MAX_TURN_RETRIES = 3;
    let fatalErr: unknown = null;
    for (let attempt = 0; ; attempt++) {
      assistantText = "";
      finishReason = "stop";
      for (const k of Object.keys(buffers)) delete buffers[Number(k)];
      let yieldedThisAttempt = false;
      try {
        const stream = await provider.chat.completions.create({
          model: args.model,
          max_tokens: MAX_OUTPUT_TOKENS,
          messages,
          tools,
          stream: true,
        });

        for await (const chunk of stream) {
          const choice = chunk.choices[0];
          if (!choice) continue;

          if (choice.delta.content) {
            const text = choice.delta.content;
            assistantText += text;
            yieldedThisAttempt = true;
            yield { type: "delta", text };
          }

          if (choice.delta.tool_calls) {
            for (const piece of choice.delta.tool_calls) {
              const idx = piece.index;
              if (!buffers[idx]) {
                buffers[idx] = { id: "", name: "", argsJson: "", yieldedStart: false };
              }
              const buf = buffers[idx]!;
              if (piece.id) buf.id = piece.id;
              if (piece.function?.name) buf.name = piece.function.name;
              if (piece.function?.arguments) buf.argsJson += piece.function.arguments;
              // First time we know the name + id, emit the start event.
              if (!buf.yieldedStart && buf.name && buf.id) {
                buf.yieldedStart = true;
                yieldedThisAttempt = true;
                yield { type: "tool_call_start", toolUseId: buf.id, name: buf.name };
              }
            }
          }

          if (choice.finish_reason) finishReason = choice.finish_reason;
        }
        fatalErr = null;
        break; // success
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const transient = /failed.to.call.a.function|failed_generation|over capacity|503|429/i.test(
          msg,
        );
        // Only retry when nothing was streamed yet this attempt (so we never
        // duplicate visible output). failed_generation / 503 occur pre-content.
        if (transient && !yieldedThisAttempt && attempt < MAX_TURN_RETRIES) {
          await new Promise((r) => setTimeout(r, 500 * (attempt + 1)));
          continue;
        }
        fatalErr = err;
        break;
      }
    }
    if (fatalErr) {
      yield {
        type: "error",
        code: "upstream_error",
        message: fatalErr instanceof Error ? fatalErr.message : "Unknown upstream error.",
      };
      return;
    }

    const toolCalls = Object.values(buffers);

    // Push the assistant turn (text + tool calls) so the next call has
    // context.
    messages.push({
      role: "assistant",
      content: assistantText || null,
      ...(toolCalls.length > 0 && {
        tool_calls: toolCalls.map((t) => ({
          id: t.id,
          type: "function" as const,
          function: { name: t.name, arguments: t.argsJson },
        })),
      }),
    } as OpenAI.Chat.Completions.ChatCompletionMessageParam);

    yield { type: "turn_end", reason: finishReason };

    if (finishReason !== "tool_calls" || toolCalls.length === 0) {
      // Conversation is done.
      return;
    }

    // Execute every tool call and append its result as a `role: "tool"`
    // message — OpenAI's required shape for tool-call responses.
    for (const tc of toolCalls) {
      let input: unknown = {};
      try {
        input = JSON.parse(tc.argsJson || "{}");
      } catch {
        input = {};
      }
      yield { type: "tool_call_input", toolUseId: tc.id, input };

      const res = await executeTool(tc.name, input, toolCtx);
      const payload = res.ok ? res.output : { error: res.error };
      const summary = res.ok
        ? `Returned ${JSON.stringify(res.output).length} bytes of JSON.`
        : `Error: ${res.error}`;
      yield { type: "tool_call_result", toolUseId: tc.id, ok: res.ok, summary };

      messages.push({
        role: "tool",
        tool_call_id: tc.id,
        content: JSON.stringify(payload),
      } as OpenAI.Chat.Completions.ChatCompletionMessageParam);
    }
    // Loop — OpenAI will read the tool messages and respond again.
  }
}
