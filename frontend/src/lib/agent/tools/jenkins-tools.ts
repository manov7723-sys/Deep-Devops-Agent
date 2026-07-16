/**
 * Jenkins agent tools — connect a Jenkins server to the project, ensure a
 * pipeline job exists for a repo, trigger builds, and wait for their result.
 *
 * The connect flow stores URL + username plain and the API token encrypted in
 * AppSecret. Every other tool loads the connection via getJenkinsConnection
 * and hits the Jenkins REST API server-side — the agent never asks the user
 * to open Jenkins after the one-time connect.
 */
import { prisma } from "@/lib/db/prisma";
import { encryptSecret } from "@/lib/auth/crypto";
import {
  ensureJob,
  getJenkinsConnection,
  resolveBuildNumber,
  triggerBuild,
  upsertCredentialString,
  verifyJenkins,
  waitForBuild,
} from "@/lib/ci/jenkins/client";
import { generateJenkinsfile, generatePipelineConfigXml, type JenkinsfileSpec } from "@/lib/ci/jenkins/jenkinsfile";
import type { Tool } from "./types";

// ── connect_jenkins ───────────────────────────────────────────────────────

export const connectJenkinsTool: Tool<
  { url: string; username: string; apiToken: string },
  { connectedAs: string; url: string }
> = {
  name: "connect_jenkins",
  description:
    "Store this project's Jenkins server URL + username + API token so future " +
    "tools can create jobs and trigger builds server-side. Verifies the credentials " +
    "against Jenkins /whoAmI before saving — a rejected token fails loudly. Ask via " +
    "```options-form``` with three text fields (url, username, apiToken) so the " +
    "user pastes them in one submit; NEVER split into three questions.",
  inputSchema: {
    type: "object",
    properties: {
      url: { type: "string", description: "Base URL, e.g. https://jenkins.mycompany.com" },
      username: { type: "string", description: "Jenkins username the API token belongs to." },
      apiToken: { type: "string", description: "API token generated from that user's profile → Configure → API Token." },
    },
    required: ["url", "username", "apiToken"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const baseUrl = input.url.trim().replace(/\/+$/, "");
    const verify = await verifyJenkins({ baseUrl, username: input.username.trim(), apiToken: input.apiToken.trim() });
    if (!verify.ok) return { ok: false, error: `Jenkins rejected the credentials: ${verify.error}` };

    await prisma.$transaction([
      prisma.appSecret.upsert({
        where: { projectId_key: { projectId: ctx.projectId, key: "jenkins_url" } },
        create: { projectId: ctx.projectId, key: "jenkins_url", valueRef: baseUrl },
        update: { valueRef: baseUrl },
      }),
      prisma.appSecret.upsert({
        where: { projectId_key: { projectId: ctx.projectId, key: "jenkins_username" } },
        create: { projectId: ctx.projectId, key: "jenkins_username", valueRef: input.username.trim() },
        update: { valueRef: input.username.trim() },
      }),
      prisma.appSecret.upsert({
        where: { projectId_key: { projectId: ctx.projectId, key: "jenkins_token" } },
        create: { projectId: ctx.projectId, key: "jenkins_token", valueRef: encryptSecret(input.apiToken.trim()) },
        update: { valueRef: encryptSecret(input.apiToken.trim()) },
      }),
    ]);

    return { ok: true, output: { connectedAs: verify.user, url: baseUrl } };
  },
};

// ── ensure_jenkins_job ─────────────────────────────────────────────────────

type EnsureJobInput = {
  repoFullName: string;
  jobName: string;
  branch: string;
  jenkinsfilePath?: string;
  scmCredentialsId?: string;
};

export const ensureJenkinsJobTool: Tool<EnsureJobInput, { created: boolean; url: string }> = {
  name: "ensure_jenkins_job",
  description:
    "Create-or-update a Jenkins pipeline job pointing at a repo + branch, with " +
    "the pipeline script coming from `jenkinsfilePath` (default: Jenkinsfile). " +
    "Idempotent — safe to call every deploy. Requires connect_jenkins to have " +
    "run first for this project. Returns the Jenkins job URL.",
  inputSchema: {
    type: "object",
    properties: {
      repoFullName: { type: "string", description: 'owner/repo (used to derive the Git HTTPS URL).' },
      jobName: { type: "string", description: 'Jenkins job name (e.g. "myapp-prod"). URL-safe: lowercase, letters/digits/dashes.' },
      branch: { type: "string", description: "Git branch to build from (e.g. main)." },
      jenkinsfilePath: { type: "string", description: "Repo-relative path to the Jenkinsfile. Defaults to Jenkinsfile." },
      scmCredentialsId: {
        type: "string",
        description:
          "Optional Jenkins credentials-store id for cloning private repos (e.g. github-token). " +
          "Omit for public repos.",
      },
    },
    required: ["repoFullName", "jobName", "branch"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const conn = await getJenkinsConnection(ctx.projectId);
    if (!conn) return { ok: false, error: "This project has no Jenkins connection. Call connect_jenkins first." };
    const xml = generatePipelineConfigXml({
      description: `DeepAgent pipeline for ${input.repoFullName} → ${input.jobName}`,
      repoUrl: `https://github.com/${input.repoFullName}.git`,
      branch: input.branch,
      jenkinsfilePath: input.jenkinsfilePath || "Jenkinsfile",
      scmCredentialsId: input.scmCredentialsId,
    });
    const res = await ensureJob(conn, input.jobName, xml);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, output: { created: res.created, url: res.url } };
  },
};

// ── generate_jenkinsfile ───────────────────────────────────────────────────

export const generateJenkinsfileTool: Tool<
  JenkinsfileSpec,
  { path: string; content: string; notes: string[] }
> = {
  name: "generate_jenkinsfile",
  description:
    "Generate a Jenkinsfile (Groovy declarative pipeline) for build → scan → " +
    "push → deploy, matching the same 4-stage shape as the GitHub Actions " +
    "workflow. Returns the file body — pair with write_repo_file to commit it. " +
    "manifestType='helm' produces a helm-upgrade deploy stage; 'manifests' " +
    "produces a kubectl-apply deploy stage.",
  inputSchema: {
    type: "object",
    properties: {
      appName: { type: "string" },
      context: { type: "string", description: 'Build-context subdir; "" for repo root.' },
      registryUri: { type: "string", description: "e.g. 123.dkr.ecr.us-east-1.amazonaws.com/myapp" },
      cloud: { type: "string", enum: ["aws", "azure", "gcp"] },
      cloudRegion: { type: "string" },
      namespace: { type: "string" },
      env: { type: "string" },
      scanGate: { type: "boolean" },
      clusterName: { type: "string" },
      credentials: {
        type: "object",
        properties: {
          cloud: { type: "string", description: "Jenkins credential id for cloud auth (username=key,password=secret for AWS)." },
          kubeconfig: { type: "string", description: "Jenkins credential id for the kubeconfig file." },
          slackWebhook: { type: "string" },
        },
        required: ["cloud", "kubeconfig"],
        additionalProperties: false,
      },
      containerPort: { type: "number" },
      manifestType: { type: "string", enum: ["manifests", "helm"] },
      chartPath: { type: "string" },
      releaseName: { type: "string" },
    },
    required: ["appName", "context", "registryUri", "cloud", "namespace", "env", "credentials"],
    additionalProperties: false,
  },
  async execute(input, _ctx) {
    const body = generateJenkinsfile(input);
    const notes = [
      `Jenkinsfile stages: Checkout → Build image → Scan (Trivy) → Push to ${input.cloud.toUpperCase()} → Deploy (${input.manifestType === "helm" ? "Helm" : "kubectl"})`,
      `Assumes Jenkins credentials exist: ${input.credentials.cloud}, ${input.credentials.kubeconfig}${input.credentials.slackWebhook ? ", " + input.credentials.slackWebhook : ""}`,
    ];
    return { ok: true, output: { path: "Jenkinsfile", content: body, notes } };
  },
};

// ── set_jenkins_credential ─────────────────────────────────────────────────

export const setJenkinsCredentialTool: Tool<
  { id: string; description: string; secret: string },
  { id: string }
> = {
  name: "set_jenkins_credential",
  description:
    "Store a secret text credential in Jenkins' system credentials store " +
    "(upserted — safe to call for a credential id that already exists). " +
    "Use to auto-provision the ids the Jenkinsfile references (e.g. slack " +
    "webhook, GitHub PAT). Cloud auth (AWS keys, kubeconfig files) must be " +
    "created by hand via the Jenkins UI for now — this tool only handles " +
    "the simpler 'string' credential kind.",
  inputSchema: {
    type: "object",
    properties: {
      id: { type: "string", description: 'Jenkins credential id (e.g. "slack-webhook"). Must be URL-safe.' },
      description: { type: "string" },
      secret: { type: "string", description: "The secret value to store." },
    },
    required: ["id", "description", "secret"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const conn = await getJenkinsConnection(ctx.projectId);
    if (!conn) return { ok: false, error: "This project has no Jenkins connection. Call connect_jenkins first." };
    const res = await upsertCredentialString(conn, input.id, input.description, input.secret);
    if (!res.ok) return { ok: false, error: res.error };
    return { ok: true, output: { id: input.id } };
  },
};

// ── trigger_jenkins_build ──────────────────────────────────────────────────

export const triggerJenkinsBuildTool: Tool<
  { jobName: string; parameters?: Record<string, string> },
  { queueUrl: string; buildNumber: number | null; buildUrl: string | null }
> = {
  name: "trigger_jenkins_build",
  description:
    "Trigger a build of a Jenkins pipeline job. Returns the queue URL AND, " +
    "if Jenkins picks it up within ~60s, the assigned buildNumber + build URL. " +
    "Use wait_for_jenkins_build to poll the build's final result once " +
    "buildNumber is known.",
  inputSchema: {
    type: "object",
    properties: {
      jobName: { type: "string" },
      parameters: {
        type: "object",
        description: "Optional build parameters (only if the job declares parameters).",
        additionalProperties: { type: "string" },
      },
    },
    required: ["jobName"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const conn = await getJenkinsConnection(ctx.projectId);
    if (!conn) return { ok: false, error: "This project has no Jenkins connection. Call connect_jenkins first." };
    const q = await triggerBuild(conn, input.jobName, input.parameters);
    if (!q.ok) return { ok: false, error: q.error };
    const num = await resolveBuildNumber(conn, q.queueUrl);
    if (!num.ok) {
      return { ok: true, output: { queueUrl: q.queueUrl, buildNumber: null, buildUrl: null } };
    }
    return { ok: true, output: { queueUrl: q.queueUrl, buildNumber: num.buildNumber, buildUrl: num.buildUrl } };
  },
};

// ── wait_for_jenkins_build ─────────────────────────────────────────────────

export const waitForJenkinsBuildTool: Tool<
  { jobName: string; buildNumber: number; timeoutMinutes?: number },
  { result: string; durationMs: number; url: string; consoleTail: string; succeeded: boolean }
> = {
  name: "wait_for_jenkins_build",
  description:
    "Poll a Jenkins build until it finishes. Returns the final result " +
    "(SUCCESS / FAILURE / UNSTABLE / ABORTED), duration, build URL, and the " +
    "last ~8KB of console output. Default timeout is 30 minutes.",
  inputSchema: {
    type: "object",
    properties: {
      jobName: { type: "string" },
      buildNumber: { type: "number" },
      timeoutMinutes: { type: "number", description: "Max wait in minutes; default 30." },
    },
    required: ["jobName", "buildNumber"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const conn = await getJenkinsConnection(ctx.projectId);
    if (!conn) return { ok: false, error: "This project has no Jenkins connection. Call connect_jenkins first." };
    const timeoutMs = Math.max(60_000, (input.timeoutMinutes ?? 30) * 60_000);
    const res = await waitForBuild(conn, input.jobName, input.buildNumber, timeoutMs);
    if (!res.ok) return { ok: false, error: res.error };
    return {
      ok: true,
      output: {
        result: res.result,
        durationMs: res.durationMs,
        url: res.url,
        consoleTail: res.consoleTail,
        succeeded: res.result === "SUCCESS",
      },
    };
  },
};
