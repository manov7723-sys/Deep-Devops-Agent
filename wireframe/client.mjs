// DeepAgent — client bundle (Preact + htm SPA)
// Read verbatim by index.js and embedded into index.html at build time.
// All runtime: browser only. No server, no backend, no DB.
import { h, render, createContext } from "https://esm.sh/preact@10.19.6";
import { useState, useEffect, useRef, useContext } from "https://esm.sh/preact@10.19.6/hooks";
import htm from "https://esm.sh/htm@3.1.1";

const html = htm.bind(h);

// Active project — the switcher in the topbar picks one of PROJECTS's keys.
// Every cloud-dependent page reads via useProject() so switching rebrands
// the whole app: cluster names, terraform backend, activity, chat threads.
const ProjectContext = createContext(null);
const useProject = () => useContext(ProjectContext);

// ═════════════════════════════════════════════════════════════════════
// Icon registry — verbatim copy of src/components/ui/Icon.tsx so the
// wireframe renders the SAME stroke-SVG icons the live app uses (not
// Unicode glyphs). Icons are 24×24 grid, currentColor stroke.
// ═════════════════════════════════════════════════════════════════════
const ICONS = {
  dashboard: "M3 13h8V3H3v10Zm10 8h8V11h-8v10ZM3 21h8v-6H3v6ZM13 3v6h8V3h-8Z",
  projects: "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z",
  teams: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM22 21v-2a4 4 0 0 0-3-3.87M16 3.13A4 4 0 0 1 16 11",
  card: "M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7Zm0 4h20",
  gauge: "M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4Zm0-9a9 9 0 0 0-9 9 9 9 0 0 0 1.2 4.5h15.6A9 9 0 0 0 21 14a9 9 0 0 0-9-9Zm1.4 7.6 3.1-3.1",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6Zm7.4-3a7.5 7.5 0 0 0-.1-1.3l2-1.6-2-3.4-2.4 1a7.3 7.3 0 0 0-2.2-1.3L14.3 2H9.7l-.4 2.7a7.3 7.3 0 0 0-2.2 1.3l-2.4-1-2 3.4 2 1.6a7.4 7.4 0 0 0 0 2.6l-2 1.6 2 3.4 2.4-1a7.3 7.3 0 0 0 2.2 1.3l.4 2.7h4.6l.4-2.7a7.3 7.3 0 0 0 2.2-1.3l2.4 1 2-3.4-2-1.6c.07-.43.1-.86.1-1.3Z",
  chat: "M21 12a8 8 0 0 1-11.5 7.2L3 21l1.8-6.5A8 8 0 1 1 21 12Z",
  cicd: "M4 4v6h6M20 20v-6h-6M20 8a8 8 0 0 0-14.3-3.7M4 16a8 8 0 0 0 14.3 3.7",
  layers: "m12 2 9 5-9 5-9-5 9-5Zm9 10-9 5-9-5m18 5-9 5-9-5",
  cloud: "M7 18a4 4 0 0 1-.5-7.97A6 6 0 0 1 18 9.2 4 4 0 0 1 17 18H7Z",
  stats: "M3 3v18h18M7 15l3-4 3 3 5-7",
  tasks: "M9 11l3 3 8-8M21 12v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h11",
  book: "M4 19.5A2.5 2.5 0 0 1 6.5 17H20M4 19.5A2.5 2.5 0 0 0 6.5 22H20V2H6.5A2.5 2.5 0 0 0 4 4.5v15Z",
  approve: "M9 12l2 2 4-4M12 3l7 4v5c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V7l7-4Z",
  activity: "M22 12h-4l-3 9L9 3l-3 9H2",
  users: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8ZM23 21v-2a4 4 0 0 0-3-3.87M16 3.13A4 4 0 0 1 16 11",
  server: "M4 5a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V5Zm0 10a1 1 0 0 1 1-1h14a1 1 0 0 1 1 1v4a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1v-4ZM8 7h.01M8 17h.01",
  bot: "M12 8V4M9 4h6M5 8h14a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-8a2 2 0 0 1 2-2Zm4 6h.01M15 14h.01",
  bell: "M18 8a6 6 0 1 0-12 0c0 7-3 9-3 9h18s-3-2-3-9M13.7 21a2 2 0 0 1-3.4 0",
  search: "M11 19a8 8 0 1 0 0-16 8 8 0 0 0 0 16Zm10 2-4.3-4.3",
  chevD: "M6 9l6 6 6-6",
  chevR: "M9 6l6 6-6 6",
  chevL: "M15 6l-6 6 6 6",
  plus: "M12 5v14M5 12h14",
  x: "M18 6 6 18M6 6l12 12",
  check: "M20 6 9 17l-5-5",
  menu: "M3 6h18M3 12h18M3 18h18",
  user: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2M12 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Z",
  lock: "M5 11a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-8Zm3-2V7a4 4 0 0 1 8 0v2",
  shield: "M12 3l7 4v5c0 4.5-3 7.7-7 9-4-1.3-7-4.5-7-9V7l7-4Z",
  github: "M12 2a10 10 0 0 0-3.2 19.5c.5.1.7-.2.7-.5v-1.7c-2.8.6-3.4-1.3-3.4-1.3-.5-1.2-1.1-1.5-1.1-1.5-.9-.6.1-.6.1-.6 1 .1 1.5 1 1.5 1 .9 1.5 2.3 1.1 2.9.8.1-.6.3-1.1.6-1.4-2.2-.2-4.6-1.1-4.6-5 0-1.1.4-2 1-2.7-.1-.3-.4-1.3.1-2.6 0 0 .8-.3 2.7 1a9.4 9.4 0 0 1 5 0c1.9-1.3 2.7-1 2.7-1 .5 1.3.2 2.3.1 2.6.6.7 1 1.6 1 2.7 0 3.9-2.4 4.8-4.6 5 .3.3.6.9.6 1.9v2.8c0 .3.2.6.7.5A10 10 0 0 0 12 2Z",
  gitlab: "M12 21 2.4 14a.9.9 0 0 1-.33-1l1.3-4L6 1.3c.13-.4.7-.4.86 0l2.5 7.7h5.28l2.5-7.7c.16-.4.73-.4.86 0l2.66 8 1.3 4a.9.9 0 0 1-.33 1L12 21Z",
  branch: "M6 3v12M18 9a3 3 0 1 0 0 6 3 3 0 0 0 0-6ZM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM6 3a3 3 0 1 0 0 6 3 3 0 0 0 0-6Zm0 6a9 9 0 0 0 9 9h0",
  send: "M22 2 11 13M22 2l-7 20-4-9-9-4 20-7Z",
  zap: "M13 2 3 14h7l-1 8 10-12h-7l1-8Z",
  dollar: "M12 1v22M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
  clock: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM12 7v5l3 2",
  refresh: "M21 12a9 9 0 1 1-2.6-6.3M21 3v6h-6",
  copy: "M9 9h10a1 1 0 0 1 1 1v10a1 1 0 0 1-1 1H9a1 1 0 0 1-1-1V10a1 1 0 0 1 1-1ZM5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1",
  alert: "M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z",
  trash: "M3 6h18M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2m2 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6",
  edit: "M12 20h9M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4 12.5-12.5Z",
  db: "M12 8c4.4 0 8-1.3 8-3s-3.6-3-8-3-8 1.3-8 3 3.6 3 8 3Zm8-3v14c0 1.7-3.6 3-8 3s-8-1.3-8-3V5m16 7c0 1.7-3.6 3-8 3s-8-1.3-8-3",
  globe: "M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18ZM3 12h18M12 3a14 14 0 0 1 0 18 14 14 0 0 1 0-18Z",
  box: "M21 8v8a2 2 0 0 1-1 1.7l-7 4a2 2 0 0 1-2 0l-7-4A2 2 0 0 1 3 16V8a2 2 0 0 1 1-1.7l7-4a2 2 0 0 1 2 0l7 4A2 2 0 0 1 21 8ZM3.3 7 12 12l8.7-5M12 22V12",
  key: "M15 7a4 4 0 1 1-5.6 5.6L3 19l-1 3 3-1 1.5-1.5 2-2L9 14l3-3a4 4 0 0 1 3-4Z",
  mail: "M2 7a2 2 0 0 1 2-2h16a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V7Zm.5-.5L12 13l9.5-6.5",
  filter: "M3 4h18l-7 8v7l-4 2v-9L3 4Z",
  sun: "M12 17a5 5 0 1 0 0-10 5 5 0 0 0 0 10ZM12 1v2M12 21v2M4.2 4.2l1.4 1.4M18.4 18.4l1.4 1.4M1 12h2M21 12h2M4.2 19.8l1.4-1.4M18.4 5.6l1.4-1.4",
  moon: "M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8Z",
  more: "M12 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2ZM19 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2ZM5 13a1 1 0 1 0 0-2 1 1 0 0 0 0 2Z",
  link: "M9 15l6-6M10.5 6.5 12 5a4 4 0 0 1 6 6l-1.5 1.5M13.5 17.5 12 19a4 4 0 0 1-6-6l1.5-1.5",
  play: "M6 4l14 8-14 8V4Z",
};

// Icon component matching src/components/ui/Icon.tsx (24×24 grid, stroke via currentColor).
const Icon = ({ name, size = 18, stroke = 2 }) => {
  const d = ICONS[name] || ICONS.box;
  return html`
    <svg width=${size} height=${size} viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width=${stroke} stroke-linecap="round" stroke-linejoin="round" style=${{flex: "none", display: "inline-block", verticalAlign: "middle"}}>
      <path d=${d} />
    </svg>`;
};

// ═════════════════════════════════════════════════════════════════════
// Three demo projects — one per cloud. Each carries all cloud-specific
// bits so pages can rebrand end-to-end when the user switches project.
// Real app equivalent: Project.cloud + Env + CloudProvider rows.
// ═════════════════════════════════════════════════════════════════════
const PROJECTS = {
  "agent-aws": {
    slug: "agent-aws", name: "agent (AWS)", cloud: "aws", cloudLabel: "AWS",
    clusterType: "EKS", region: "us-east-1",
    clusterName: "eks-prod", clusterVersion: "1.33", clusterNodes: 6,
    stateBackend: { kind: "s3", label: "S3 bucket", bucket: "agent-tfstate", region: "us-east-1", table: "terraform-locks" },
    provider: { id: "p1", kind: "aws", name: "AWS (us-east-1)", env: "release", region: "us-east-1", services: 3, cost: 512 },
    envs: [
      { key: "release", name: "release", tier: "production", cluster: "eks-prod" },
      { key: "beta", name: "beta", tier: "staging", cluster: "eks-beta" },
      { key: "alpha", name: "alpha", tier: "dev", cluster: null },
    ],
    activity: [
      { at: "2m ago", action: "eks.terraform_generated", target: "release/eks-prod", tone: "ok" },
      { at: "18m ago", action: "cloud_provider.credentials_set", target: "aws · release", tone: "ok" },
      { at: "35m ago", action: "chat.message_posted", target: "thread 'EKS access entries'", tone: "info" },
      { at: "1h ago", action: "terraform.run_started", target: "eks-prod-apply", tone: "info" },
      { at: "3h ago", action: "env.tf_backend_set", target: "s3 · agent-tfstate", tone: "ok" },
    ],
    chats: [
      { id: "c1", title: "EKS access entries", when: "2:41 PM", msgs: 22, group: "Today" },
      { id: "c2", title: "ECR OIDC setup", when: "1:22 PM", msgs: 8, group: "Today" },
      { id: "c3", title: "VPC subnet routing", when: "Jul 13", msgs: 14, group: "Yesterday" },
    ],
    chatSeed: [
      { role: "agent", text: "Ready to provision EKS. Region us-east-1, m5.large × 3 nodes ok?" },
      { role: "user", text: "Yes, and add spot capacity for the app pool." },
      { role: "agent", text: "Generated Terraform using terraform-aws-modules/eks/aws v20, VPC via terraform-aws-modules/vpc, S3 backend at agent-tfstate. Encryption at rest via KMS. Ready to apply?" },
      { role: "user", text: "Apply." },
      { role: "agent", text: "Applying… (regional EKS control-plane usually 10-15 min)" },
    ],
    pipeline: [
      { id: "r1", name: "eks-prod-apply", action: "apply", env: "release", status: "running", elapsed: "8m 22s", stages: [
        { name: "init", status: "succeeded", dur: "38s" },
        { name: "plan", status: "succeeded", dur: "1m 45s" },
        { name: "apply", status: "running", dur: "5m 59s" },
      ]},
      { id: "r2", name: "eks-beta-apply", action: "apply", env: "beta", status: "succeeded", elapsed: "14m 08s", stages: [
        { name: "init", status: "succeeded", dur: "32s" },
        { name: "plan", status: "succeeded", dur: "1m 12s" },
        { name: "apply", status: "succeeded", dur: "12m 24s" },
      ]},
    ],
  },
  "agent-gcp": {
    slug: "agent-gcp", name: "agent (GCP)", cloud: "gcp", cloudLabel: "GCP",
    clusterType: "GKE", region: "us-central1",
    clusterName: "gke-prod", clusterVersion: "1.33", clusterNodes: 3,
    stateBackend: { kind: "gcs", label: "GCS bucket", bucket: "tfstate-agent-gcp" },
    provider: { id: "p1", kind: "gcp", name: "GCP (us-central1)", env: "release", region: "us-central1", services: 2, cost: 267, project: "new-project-495604" },
    envs: [
      { key: "release", name: "release", tier: "production", cluster: "gke-prod" },
      { key: "beta", name: "beta", tier: "staging", cluster: "gke-beta" },
      { key: "alpha", name: "alpha", tier: "dev", cluster: null },
    ],
    activity: [
      { at: "5m ago", action: "gke.terraform_generated", target: "release/gke-prod", tone: "ok" },
      { at: "22m ago", action: "azure.tfstate_provisioned", target: "gcs · tfstate-agent-gcp", tone: "ok" },
      { at: "1h ago", action: "chat.message_posted", target: "thread 'Enable GKE APIs'", tone: "info" },
      { at: "2h ago", action: "terraform.run_started", target: "gke-prod-apply", tone: "info" },
      { at: "3h ago", action: "cloud_provider.credentials_set", target: "gcp · release", tone: "ok" },
    ],
    chats: [
      { id: "c1", title: "GKE APIs enablement", when: "2:41 PM", msgs: 12, group: "Today" },
      { id: "c2", title: "Workload Identity setup", when: "1:22 PM", msgs: 7, group: "Today" },
      { id: "c3", title: "Artifact Registry WIF", when: "Jul 13", msgs: 18, group: "Yesterday" },
    ],
    chatSeed: [
      { role: "agent", text: "Provisioning GKE in us-central1. Regional or zonal?" },
      { role: "user", text: "Regional, n2-standard-4 × 3, workload identity on." },
      { role: "agent", text: "Generated main.tf, outputs.tf, versions.tf with google_project_service preconditions (container + compute), GCS backend at tfstate-agent-gcp. Ready to apply?" },
      { role: "user", text: "Apply." },
      { role: "agent", text: "Applying… (regional GKE usually 20-25 min for the control plane + node pools)" },
    ],
    pipeline: [
      { id: "r1", name: "gke-prod-apply", action: "apply", env: "release", status: "running", elapsed: "12m 04s", stages: [
        { name: "init", status: "succeeded", dur: "42s" },
        { name: "plan", status: "succeeded", dur: "2m 18s" },
        { name: "apply", status: "running", dur: "9m 04s" },
      ]},
      { id: "r2", name: "gke-beta-apply", action: "apply", env: "beta", status: "succeeded", elapsed: "18m 22s", stages: [
        { name: "init", status: "succeeded", dur: "38s" },
        { name: "plan", status: "succeeded", dur: "1m 51s" },
        { name: "apply", status: "succeeded", dur: "15m 53s" },
      ]},
    ],
  },
  "agent-azure": {
    slug: "agent-azure", name: "agent (Azure)", cloud: "azure", cloudLabel: "Azure",
    clusterType: "AKS", region: "eastus",
    clusterName: "aks-prod", clusterVersion: "1.33", clusterNodes: 4,
    stateBackend: { kind: "azurerm", label: "Azure Storage container", resourceGroup: "rg-devops", storageAccount: "devclusteraccount", container: "tfstate" },
    provider: { id: "p1", kind: "azure", name: "Azure (eastus)", env: "release", region: "eastus", services: 3, cost: 482, subscription: "799aab2a-460c-4b3b-bfea-c0d72d1ad6a7" },
    envs: [
      { key: "release", name: "release", tier: "production", cluster: "aks-prod" },
      { key: "beta", name: "beta", tier: "staging", cluster: "aks-beta" },
      { key: "alpha", name: "alpha", tier: "dev", cluster: null },
    ],
    activity: [
      { at: "2m ago", action: "aks.terraform_generated", target: "release/aks-prod", tone: "ok" },
      { at: "14m ago", action: "terraform.run_started", target: "aks-prod-apply", tone: "info" },
      { at: "28m ago", action: "azure.tfstate_provisioned", target: "rg-devops/devclusteraccount/tfstate", tone: "ok" },
      { at: "48m ago", action: "cloud_provider.credentials_set", target: "azure · release", tone: "ok" },
      { at: "1h ago", action: "chat.message_posted", target: "thread 'AKS OIDC'", tone: "info" },
    ],
    chats: [
      { id: "c1", title: "AKS OIDC setup", when: "2:41 PM", msgs: 14, group: "Today" },
      { id: "c2", title: "ACR keyless auth", when: "1:22 PM", msgs: 9, group: "Today" },
      { id: "c3", title: "Azure quota bump", when: "Jul 13", msgs: 6, group: "Yesterday" },
    ],
    chatSeed: [
      { role: "agent", text: "Provisioning AKS in eastus. Standard_D4s_v3 × 3 nodes, private cluster?" },
      { role: "user", text: "Public endpoint, workload identity on, monitoring on." },
      { role: "agent", text: "Generated Terraform with Azure Log Analytics + Managed Prometheus + KEDA. azurerm backend at rg-devops/devclusteraccount/tfstate. Ready to apply?" },
      { role: "user", text: "Apply." },
      { role: "agent", text: "Applying… (regional AKS usually 15-25 min)" },
    ],
    pipeline: [
      { id: "r1", name: "aks-prod-apply", action: "apply", env: "release", status: "running", elapsed: "12m 04s", stages: [
        { name: "init", status: "succeeded", dur: "42s" },
        { name: "plan", status: "succeeded", dur: "2m 18s" },
        { name: "apply", status: "running", dur: "9m 04s" },
      ]},
      { id: "r2", name: "aks-beta-apply", action: "apply", env: "beta", status: "succeeded", elapsed: "18m 22s", stages: [
        { name: "init", status: "succeeded", dur: "38s" },
        { name: "plan", status: "succeeded", dur: "1m 51s" },
        { name: "apply", status: "succeeded", dur: "15m 53s" },
      ]},
    ],
  },
};

// Shared data that doesn't vary per project (repos, monitors, alerts...)
const MOCK = {
  pipelines: [
    { repo: "manov7723-sys/deepagent", workflow: "build-and-push", branch: "dev", status: "succeeded", dur: "3m 04s", actor: "manov" },
    { repo: "manov7723-sys/deepagent", workflow: "deploy-cluster", branch: "release", status: "running", dur: "12m 04s", actor: "manov" },
    { repo: "acme/app", workflow: "trivy-scan", branch: "main", status: "failed", dur: "42s", actor: "sriram" },
  ],
  alerts: [
    { name: "mem-usage high", target: "worker-abc123 · 92% for 12m", sev: "high", env: "release" },
    { name: "p95-latency high", target: "app.example.com · 1.2s for 5m", sev: "warn", env: "release" },
  ],
  monitors: [
    { url: "https://app.example.com/health", status: "up", uptime: "99.98%", p50: "142ms", last: "12s" },
    { url: "https://api.example.com/live", status: "up", uptime: "99.99%", p50: "89ms", last: "10s" },
    { url: "https://docs.example.com", status: "warn", uptime: "99.72%", p50: "812ms", last: "24s" },
  ],
};

// ═════════════════════════════════════════════════════════════════════
// Primitives (map 1:1 to src/components/ui in the real app)
// ═════════════════════════════════════════════════════════════════════
const Btn = ({ variant = "outline", size, icon, children, onClick, disabled, block }) => html`
  <button class=${"btn " + variant + (size ? " " + size : "") + (block ? " block" : "")} onClick=${onClick} disabled=${disabled}>
    ${icon && html`<span>${icon}</span>`}${children}
  </button>`;

const Chip = ({ active, children, onClick, icon }) => html`
  <button class=${"chip" + (active ? " active" : "")} onClick=${onClick}>
    ${icon && html`<span>${icon}</span>`}${children}
  </button>`;

const Badge = ({ tone, children }) => html`
  <span class=${"badge" + (tone ? " " + tone : "")}>${["ok","warn","danger","info"].includes(tone) && html`<span class="dot" aria-hidden></span>`}${children}</span>`;

const Dot = ({ tone = "ok" }) => html`<span class="dot" style=${{background: "var(--" + tone + ")"}}></span>`;

const Card = ({ title, sub, actions, maxWidth, pad = true, children }) => html`
  <section class="card" style=${maxWidth ? {maxWidth: maxWidth + "px", width: "100%"} : null}>
    ${title != null && html`
      <div class="card-h">
        <div class="col" style=${{gap: 2}}>
          <span class="card-title">${title}</span>
          ${sub && html`<span class="faint" style=${{fontSize: 12}}>${sub}</span>`}
        </div>
        ${actions && html`<div class="row gap-2" style=${{marginLeft: "auto"}}>${actions}</div>`}
      </div>`}
    <div class=${pad ? "card-pad" : ""}>${children}</div>
  </section>`;

const Field = ({ label, hint, children, required }) => html`
  <label class="col gap-1">
    <span class="field-label">${label}${required && html`<span style=${{color: "var(--danger)", marginLeft: 4}}>*</span>`}</span>
    ${children}
    ${hint && html`<span class="faint" style=${{fontSize: 11.5, marginTop: 4}}>${hint}</span>`}
  </label>`;

const Input = ({ value, onInput, placeholder, readonly, type = "text" }) => html`
  <input class="input" type=${type} value=${value} placeholder=${placeholder} onInput=${onInput} readonly=${readonly} />`;

const Select = ({ value, onChange, options }) => {
  const [open, setOpen] = useState(false);
  return html`
    <div style=${{position: "relative"}}>
      <button class="select" style=${{cursor: "pointer", width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between"}} onClick=${() => setOpen(!open)}>
        <span>${value ?? "Choose…"}</span>
        <span class="faint">▾</span>
      </button>
      ${open && html`
        <div style=${{position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "var(--shadow)", zIndex: 100, overflow: "hidden"}}>
          ${options.map((o) => html`
            <button style=${{display: "block", width: "100%", padding: "10px 14px", background: value === o ? "var(--surface-3)" : "transparent", border: "none", textAlign: "left", cursor: "pointer", color: "var(--text)", fontFamily: "inherit", fontSize: 13}} onClick=${() => { onChange(o); setOpen(false); }}>${o}</button>
          `)}
        </div>`}
    </div>`;
};

const Stat = ({ label, value, sub, icon }) => html`
  <div class="card card-pad" style=${{minWidth: 0}}>
    <div class="row between" style=${{alignItems: "flex-start"}}>
      <div class="col gap-1" style=${{minWidth: 0}}>
        <span class="faint" style=${{fontSize: 11.5, textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 700}}>${label}</span>
        <span style=${{fontSize: 22, fontWeight: 800, letterSpacing: "-.02em"}}>${value}</span>
        ${sub && html`<span class="muted" style=${{fontSize: 12}}>${sub}</span>`}
      </div>
      ${icon && html`<span style=${{width: 36, height: 36, borderRadius: 9, background: "var(--surface-3)", display: "flex", alignItems: "center", justifyContent: "center", color: "var(--text-muted)", fontSize: 16}}>${icon}</span>`}
    </div>
  </div>`;

const TileGrid = ({ minTile = 320, maxTile = 420, gap = 14, children }) => {
  const template = maxTile === "1fr"
    ? "repeat(auto-fill, minmax(" + minTile + "px, 1fr))"
    : "repeat(auto-fill, minmax(" + minTile + "px, " + maxTile + "px))";
  return html`<div style=${{display: "grid", gridTemplateColumns: template, justifyContent: maxTile === "1fr" ? "stretch" : "start", gap: gap}}>${children}</div>`;
};

const PageHead = ({ title, sub, actions }) => html`
  <div class="col gap-4" style=${{marginBottom: 4}}>
    <div class="row between gap-3 wrap" style=${{alignItems: "flex-start"}}>
      <div class="col" style=${{gap: 4, minWidth: 0, maxWidth: 720}}>
        <h1 style=${{fontSize: 22, letterSpacing: "-.02em"}}>${title}</h1>
        ${sub && html`<p class="muted" style=${{fontSize: 13.5, lineHeight: 1.5}}>${sub}</p>`}
      </div>
      ${actions && html`<div class="row gap-2 wrap">${actions}</div>`}
    </div>
  </div>`;

const Table = ({ headers, rows }) => html`
  <div style=${{overflowX: "auto"}}>
    <table style=${{width: "100%", borderCollapse: "collapse", fontSize: 13}}>
      <thead><tr>${headers.map((h) => html`<th style=${{textAlign: "left", padding: "12px 14px", borderBottom: "1px solid var(--border-soft)", fontSize: 11.5, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--text-muted)", fontWeight: 700}}>${h}</th>`)}</tr></thead>
      <tbody>${rows.map((r) => html`<tr>${r.map((c) => html`<td style=${{padding: "12px 14px", borderBottom: "1px solid var(--border-soft)"}}>${c}</td>`)}</tr>`)}</tbody>
    </table>
  </div>`;

// ═════════════════════════════════════════════════════════════════════
// Pages
// ═════════════════════════════════════════════════════════════════════

const DashboardPage = () => {
  const proj = useProject();
  return html`
  <${PageHead} title=${proj.name} sub=${"Production deployment target on " + proj.cloudLabel + " (" + proj.clusterType + ")."} actions=${html`
    <${Btn} variant="primary" icon="◈">Open chat<//>
    <${Btn}>Deploy<//>
  `} />
  <div style=${{display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 14}}>
    <${Stat} label="Environments" value=${String(proj.envs.length)} sub=${proj.envs.map((e) => e.name).join(" · ")} icon="◨" />
    <${Stat} label="Cluster" value=${proj.clusterName} sub=${proj.clusterType + " · v" + proj.clusterVersion} icon="⛁" />
    <${Stat} label="Monthly cost" value=${"$" + (proj.provider.cost + 900).toLocaleString()} sub="▲ 6.4%" icon="$" />
    <${Stat} label="Health" value="OK" sub="all clusters ready" icon="✓" />
  </div>
  <div class="row gap-4 wrap" style=${{alignItems: "flex-start"}}>
    <div style=${{flex: 1, minWidth: 420}}>
      <${Card} title="Recent activity" sub=${proj.cloudLabel + " project · latest 20 events"}>
        <ul style=${{listStyle: "none", padding: 0, margin: 0}}>
          ${proj.activity.map((a) => html`
            <li style=${{padding: "10px 0", borderBottom: "1px solid var(--border-soft)", fontSize: 13}}>
              <div class="row gap-3" style=${{alignItems: "center"}}>
                <${Badge} tone=${a.tone}>${a.tone === "ok" ? "succeeded" : "info"}<//>
                <span class="mono muted">${a.action}</span>
                <span class="faint">·</span>
                <span>${a.target}</span>
                <span class="faint" style=${{marginLeft: "auto"}}>${a.at}</span>
              </div>
            </li>`)}
        </ul>
      <//>
    </div>
    <div style=${{width: 340, flex: "none"}}>
      <${Card} title="Attention" sub="Blocking deploys">
        <ul style=${{listStyle: "none", padding: 0, margin: 0}}>
          <li style=${{padding: "10px 0", borderBottom: "1px solid var(--border-soft)", fontSize: 13}}><${Badge} tone="danger">high<//> 1 open alert · <span class="mono">mem-usage</span> on release</li>
          <li style=${{padding: "10px 0", borderBottom: "1px solid var(--border-soft)", fontSize: 13}}><${Badge} tone="info">pending<//> 2 approvals waiting</li>
          <li style=${{padding: "10px 0", fontSize: 13}}><${Badge} tone="warn">warn<//> State backend not set on <span class="mono">alpha</span></li>
        </ul>
      <//>
    </div>
  </div>
  <${Card} title="Spend trend" sub="30-day rolling">
    <div style=${{height: 180, background: "linear-gradient(180deg, transparent, var(--surface-2))", borderRadius: 8, display: "flex", alignItems: "flex-end", padding: 14, gap: 4}}>
      ${Array.from({length: 30}).map((_, i) => html`<div style=${{flex: 1, background: "var(--accent)", opacity: 0.4 + (i / 30) * 0.6, borderRadius: "2px 2px 0 0", height: (20 + Math.sin(i * 0.4) * 40 + i * 2) + "%"}} />`)}
    </div>
  <//>
`;
};

const ChatPage = () => {
  const proj = useProject();
  const [messages, setMessages] = useState(proj.chatSeed);
  const [text, setText] = useState("");
  const [railOpen, setRailOpen] = useState(true);
  const [activeChat, setActiveChat] = useState("c1");
  const scrollRef = useRef(null);
  useEffect(() => { setMessages(proj.chatSeed); }, [proj.slug]);
  const send = () => {
    if (!text.trim()) return;
    const t = text.trim();
    setMessages([...messages, { role: "user", text: t }]);
    setText("");
    setTimeout(() => setMessages((prev) => [...prev, { role: "agent", text: "(demo) Received: '" + t + "'. In the live app I'd analyze your repos and cloud state to answer." }]), 500);
  };
  useEffect(() => { if (scrollRef.current) scrollRef.current.scrollTop = scrollRef.current.scrollHeight; }, [messages]);
  const groups = ["Today", "Yesterday", "Previous 7 days"];
  return html`
    <div style=${{height: "calc(100vh - 100px)", display: "grid", gridTemplateColumns: railOpen ? "1fr 280px" : "1fr 0px", background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 12, overflow: "hidden", transition: "grid-template-columns .22s ease"}}>
      <div class="col" style=${{minWidth: 0, minHeight: 0}}>
        <header style=${{padding: "14px 20px", borderBottom: "1px solid var(--border-soft)", display: "flex", justifyContent: "space-between", alignItems: "center"}}>
          <div class="row gap-3" style=${{alignItems: "center"}}>
            <span style=${{width: 36, height: 36, borderRadius: 9, background: "var(--accent-soft)", color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 18}}>◐</span>
            <div class="col" style=${{lineHeight: 1.3}}>
              <span class="row gap-2" style=${{fontWeight: 700, fontSize: 14}}>Deep Agent <${Dot} tone="ok" /></span>
              <span class="faint" style=${{fontSize: 11.5}}>Claude Sonnet 4.5 · sees all repos & cloud state</span>
            </div>
          </div>
          <div class="row gap-2">
            <${Badge} tone="accent">agent<//>
            <${Btn} variant="outline" size="sm" icon="🗑">Clear<//>
            <${Btn} variant="outline" size="icon" onClick=${() => setRailOpen(!railOpen)}>${railOpen ? "▶" : "◀"}<//>
          </div>
        </header>
        <div ref=${scrollRef} style=${{flex: 1, overflowY: "auto", padding: 24, display: "flex", flexDirection: "column", gap: 16}}>
          ${messages.map((m) => m.role === "agent" ? html`
            <div class="row gap-3" style=${{alignItems: "flex-start"}}>
              <span style=${{width: 32, height: 32, borderRadius: 9, background: "var(--accent-soft)", color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 12, flex: "none"}}>◐</span>
              <div style=${{background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 12, padding: "12px 15px", maxWidth: 640, fontSize: 14, lineHeight: 1.6}}>${m.text}</div>
            </div>` : html`
            <div class="row gap-3" style=${{justifyContent: "flex-end", alignItems: "flex-start"}}>
              <div style=${{background: "var(--accent-soft)", border: "1px solid var(--accent-line)", borderRadius: 12, padding: "12px 15px", maxWidth: 640, fontSize: 14, lineHeight: 1.6}}>${m.text}</div>
              <span style=${{width: 32, height: 32, borderRadius: 9, background: "var(--surface-3)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 11, flex: "none"}}>MV</span>
            </div>`)}
        </div>
        <div style=${{padding: "16px 24px 20px", borderTop: "1px solid var(--border-soft)", flex: "none"}}>
          <div style=${{maxWidth: 820, margin: "0 auto"}}>
            <div style=${{padding: 12, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 18, boxShadow: "var(--shadow-sm)"}}>
              <textarea class="textarea" style=${{border: "none", background: "transparent", outline: "none", width: "100%", fontSize: 15, minHeight: 24, maxHeight: 200, resize: "none", padding: "4px 6px", color: "var(--text)", fontFamily: "inherit"}} placeholder="Describe what you want to build or change…" value=${text} onInput=${(e) => setText(e.target.value)} onKeyDown=${(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
              <div class="row between" style=${{alignItems: "center", marginTop: 8}}>
                <div class="row gap-2"><${Btn} variant="ghost" size="icon" icon="+" /><${Btn} variant="ghost" size="sm" icon="▤">infra<//></div>
                <${Btn} variant="primary" size="icon" onClick=${send} disabled=${!text.trim()}>▸<//>
              </div>
            </div>
            <p class="faint" style=${{fontSize: 11, textAlign: "center", marginTop: 8}}>Deep Agent can read and write to your repos. Changes require approval before they touch release.</p>
          </div>
        </div>
      </div>
      ${railOpen && html`
        <aside style=${{background: "var(--surface-2)", borderLeft: "1px solid var(--border-soft)", display: "flex", flexDirection: "column", minHeight: 0, overflow: "hidden"}}>
          <div class="row between" style=${{padding: 12, alignItems: "center"}}>
            <span style=${{fontWeight: 700, fontSize: 13}}>Recent chats</span>
            <${Btn} variant="primary" size="sm" icon="+">New<//>
          </div>
          <div style=${{flex: 1, overflowY: "auto", padding: "0 8px 12px"}}>
            ${groups.map((g) => html`
              <div style=${{fontSize: 10.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--text-faint)", padding: "10px 8px 4px"}}>${g}</div>
              ${proj.chats.filter((c) => c.group === g).map((c) => html`
                <button style=${{display: "flex", flexDirection: "column", gap: 3, padding: "8px 10px", margin: "2px 0", borderRadius: 8, border: "1px solid transparent", background: activeChat === c.id ? "color-mix(in srgb, var(--accent) 12%, transparent)" : "transparent", width: "100%", textAlign: "left", color: "var(--text)", fontFamily: "inherit", cursor: "pointer"}} onClick=${() => setActiveChat(c.id)}>
                  <span style=${{fontSize: 13, fontWeight: 600}}>${c.title}</span>
                  <span style=${{fontSize: 11, color: "var(--text-faint)"}}>${c.when} · ${c.msgs} msgs</span>
                </button>`)}
            `)}
          </div>
        </aside>`}
    </div>`;
};

const CloudPage = () => {
  const proj = useProject();
  const [envFilter, setEnvFilter] = useState("all");
  const [connectOpen, setConnectOpen] = useState(false);
  // Only this project's cloud shows up — the project is locked to it at creation.
  const providers = [proj.provider];
  const envs = ["all", ...proj.envs.map((e) => e.key)];
  const tint = { aws: "oklch(0.72 0.19 45 / 0.15)", azure: "oklch(0.7 0.17 235 / 0.18)", gcp: "oklch(0.74 0.17 158 / 0.18)" };
  const tintFg = { aws: "oklch(0.72 0.19 45)", azure: "oklch(0.7 0.17 235)", gcp: "oklch(0.74 0.17 158)" };
  return html`
    <${PageHead} title="Cloud providers" sub="Connected accounts Deep Agent deploys to, per environment." actions=${html`<${Btn} variant="primary" icon="+" onClick=${() => setConnectOpen(true)}>Connect provider<//>`} />
    <div class="row gap-2 wrap">${envs.map((e) => html`<${Chip} active=${envFilter === e} onClick=${() => setEnvFilter(e)}>${e}<//>`)}</div>
    <${TileGrid} minTile=${320} maxTile="1fr">
      ${providers.map((p) => html`
        <${Card}>
          <div class="row between">
            <div class="row gap-3">
              <span style=${{width: 44, height: 44, borderRadius: 11, background: tint[p.kind], color: tintFg[p.kind], display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 10}}>${p.kind.toUpperCase()}</span>
              <div class="col" style=${{gap: 2}}><div style=${{fontWeight: 700, fontSize: 14}}>${p.name}</div><div class="muted" style=${{fontSize: 12}}>${p.env} · ${p.kind.toUpperCase()}</div></div>
            </div>
            <${Dot} tone="ok" />
          </div>
          <div style=${{display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12, marginTop: 14}}>
            <div><div class="faint" style=${{fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 700}}>Region</div><div class="mono" style=${{fontSize: 13, marginTop: 2}}>${p.region}</div></div>
            <div><div class="faint" style=${{fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 700}}>Services</div><div style=${{fontSize: 15, fontWeight: 700, marginTop: 2}}>${p.services}</div></div>
            <div><div class="faint" style=${{fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 700}}>Monthly</div><div style=${{fontSize: 15, fontWeight: 700, marginTop: 2}}>$${p.cost}</div></div>
          </div>
          <div class="row gap-2" style=${{marginTop: 14}}><${Btn} icon="▤">View stats<//><${Btn} variant="ghost" size="icon">⚙<//><${Btn} variant="ghost" size="icon">🗑<//></div>
        <//>`)}
    <//>
    ${proj.cloud === "aws" && html`
      <${Card} title="Vault configuration" sub="Store AWS access key + secret in Vault so the agent reads them at runtime.">
        <div style=${{maxWidth: 520}}>
          <div class="row between" style=${{marginBottom: 14}}><span style=${{fontWeight: 600, fontSize: 13}}>Connection</span><${Badge} tone="warn">not connected<//></div>
          <div class="col gap-3">
            <${Field} label="Vault URL" required><${Input} placeholder="https://127.0.0.1:8200" /><//>
            <${Field} label="Vault token" required hint="Token with read/write on the KV mount (hvs.…)"><${Input} placeholder="hvs.•••••••••••" /><//>
            <div class="row gap-2"><${Btn} variant="primary" icon="🔗">Save & test<//></div>
          </div>
        </div>
      <//>`}
    ${proj.cloud === "azure" && html`
      <${Card} title="Azure context" sub=${"Subscription: " + proj.provider.subscription}>
        <div style=${{maxWidth: 520}} class="col gap-3">
          <${Field} label="Subscription"><${Select} value=${proj.provider.subscription} onChange=${() => {}} options=${[proj.provider.subscription]} /><//>
          <${Field} label="Resource group"><${Select} value="rg-devops" onChange=${() => {}} options=${["rg-devops"]} /><//>
          <${Field} label="Region"><${Select} value=${proj.region} onChange=${() => {}} options=${[proj.region]} /><//>
          <div class="row gap-2"><${Btn} variant="primary" icon="✓">Save context<//></div>
        </div>
      <//>`}
    ${proj.cloud === "gcp" && html`
      <${Card} title="GCP context" sub=${"Project: " + proj.provider.project}>
        <div style=${{maxWidth: 520}} class="col gap-3">
          <${Field} label="GCP project"><${Select} value=${proj.provider.project} onChange=${() => {}} options=${[proj.provider.project]} /><//>
          <${Field} label="Region"><${Select} value=${proj.region} onChange=${() => {}} options=${[proj.region]} /><//>
          <${Field} label="Service account"><${Input} value="dda-runtime@new-project-495604.iam.gserviceaccount.com" readonly=${true} /><//>
          <div class="row gap-2"><${Btn} variant="primary" icon="✓">Save context<//></div>
        </div>
      <//>`}
    ${connectOpen && html`<${ConnectCloudModal} lockedCloud=${proj.cloud} onClose=${() => setConnectOpen(false)} />`}
  `;
};

const ConnectCloudModal = ({ onClose, lockedCloud }) => {
  const [step, setStep] = useState(1);
  const [cloud, setCloud] = useState(lockedCloud || "azure");
  return html`
    <div style=${{position: "fixed", inset: 0, background: "var(--overlay)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20}} onClick=${onClose}>
      <div style=${{background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, boxShadow: "var(--shadow-lg)", maxWidth: 560, width: "100%", padding: 24}} onClick=${(e) => e.stopPropagation()}>
        <div class="row between" style=${{marginBottom: 20}}>
          <h2 style=${{fontSize: 18}}>Connect cloud provider · Step ${step} of 2</h2>
          <${Btn} variant="ghost" size="icon" onClick=${onClose}>✕<//>
        </div>
        ${step === 1 ? html`
          <div class="col gap-4">
            <${Field} label="Pick a cloud">
              <div class="row gap-2 wrap">
                ${[{k: "aws", n: "AWS"}, {k: "azure", n: "Azure"}, {k: "gcp", n: "GCP"}].map((c) => html`
                  <button class=${"chip " + (cloud === c.k ? "active" : "")} style=${{height: 44, padding: "0 16px"}} onClick=${() => setCloud(c.k)}>☁ ${c.n}</button>`)}
              </div>
            <//>
            <${Field} label="Environment to attach to">
              <${Select} value="release" onChange=${() => {}} options=${MOCK.envs.map((e) => e.key)} />
            <//>
            <div class="row gap-2" style=${{justifyContent: "flex-end", marginTop: 8}}>
              <${Btn} variant="ghost" onClick=${onClose}>Cancel<//>
              <${Btn} variant="primary" onClick=${() => setStep(2)}>Continue →<//>
            </div>
          </div>` : html`
          <div class="col gap-4">
            <p class="muted" style=${{fontSize: 13}}>Sign in with your ${cloud.toUpperCase()} account. We'll auto-provision a service principal for keyless deploys.</p>
            <${Btn} variant="primary" block>Sign in with ${cloud.toUpperCase()} →<//>
            <div class="row gap-2" style=${{justifyContent: "flex-end", marginTop: 8}}>
              <${Btn} variant="ghost" onClick=${() => setStep(1)}>← Back<//>
            </div>
          </div>`}
      </div>
    </div>`;
};

const InfraPage = () => {
  const proj = useProject();
  const [pipelineEnv, setPipelineEnv] = useState("release");
  const runs = proj.pipeline.filter((r) => r.env === pipelineEnv);
  const sb = proj.stateBackend;
  return html`
    <${PageHead} title="Infrastructure" sub=${"Cloud credentials, Terraform state, and " + proj.clusterType + " cluster provisioning."} />
    <${Card} title="Cloud credentials" sub="Provider used to authenticate Terraform runs">
      <div class="row gap-2 wrap"><${Badge} tone="ok">${proj.cloudLabel} · release<//><${Btn} icon="+">Add credentials<//></div>
    <//>
    <${Card} title="Terraform state backend" sub=${"Uses " + proj.cloudLabel + " " + sb.label + " for this project."} maxWidth=${560}>
      <div class="col gap-3">
        <${Field} label="Environment"><${Select} value="release" onChange=${() => {}} options=${proj.envs.map((e) => e.key)} /><//>
        ${sb.kind === "s3" && html`
          <${Field} label="S3 bucket"><${Input} value=${sb.bucket} /><//>
          <${Field} label="Region"><${Input} value=${sb.region} /><//>
          <${Field} label="DynamoDB lock table (optional)"><${Input} value=${sb.table} /><//>
          <div class="row gap-2"><${Btn} variant="primary" icon="✓">Save<//></div>`}
        ${sb.kind === "gcs" && html`
          <${Field} label="GCS bucket" hint="GCS uses object generations for locking — no separate lock table."><${Input} value=${sb.bucket} /><//>
          <div class="row gap-2"><${Btn} variant="primary" icon="✓">Save<//></div>`}
        ${sb.kind === "azurerm" && html`
          <${Field} label="Resource group"><${Input} value=${sb.resourceGroup} /><//>
          <${Field} label="Storage account" hint="Globally unique, 3-24 lowercase letters/digits."><${Input} value=${sb.storageAccount} /><//>
          <${Field} label="Blob container"><${Input} value=${sb.container} /><//>
          <div class="row gap-2"><${Btn} variant="primary" icon="✓">Save<//><${Btn} icon="☁">Provision in Azure<//></div>`}
      </div>
    <//>
    <${Card} title=${"Create " + proj.clusterType + " cluster"} sub=${"Interactive wizard for " + proj.cloudLabel} maxWidth=${560}>
      <div class="col gap-3">
        <${Field} label="Cluster name"><${Input} value=${proj.clusterName + "-new"} /><//>
        <${Field} label="Region"><${Input} value=${proj.region} /><//>
        <${Field} label="Kubernetes version"><${Select} value=${proj.clusterVersion} onChange=${() => {}} options=${["1.36","1.35","1.34","1.33","1.32","1.31","1.30"]} /><//>
        <${Field} label="Node count"><${Input} value=${String(proj.clusterNodes)} /><//>
        <div class="row gap-2"><${Btn} variant="primary" icon="⚡">Push & apply<//><${Btn}>Push only<//><${Btn}>Apply only<//></div>
      </div>
    <//>
    <${Card} title="Terraform pipeline" sub="init → plan → apply against the env's cloud creds + state backend.">
      <div class="col gap-3">
        <div class="row gap-2" style=${{alignItems: "center"}}>
          <span class="field-label" style=${{margin: 0, padding: 0}}>Environment</span>
          <div style=${{maxWidth: 220}}><${Select} value=${pipelineEnv} onChange=${setPipelineEnv} options=${proj.envs.map((e) => e.key)} /></div>
        </div>
        ${runs.length === 0 ? html`<div class="muted" style=${{padding: 20, textAlign: "center", fontSize: 13}}>No runs for this environment.</div>` : runs.map((r) => html`
          <${Card} pad=${true}>
            <div class="row between" style=${{alignItems: "flex-start"}}>
              <div class="col">
                <div class="row gap-2" style=${{alignItems: "center"}}>
                  <b>${r.name}</b>
                  <${Badge} tone=${r.status === "succeeded" ? "ok" : r.status === "failed" ? "danger" : "info"}>${r.status}<//>
                  <span class="muted" style=${{fontSize: 12.5}}>${r.action} · ${r.env}</span>
                  <span style=${{fontSize: 12, color: "var(--text-muted)"}}><${Dot} tone=${r.status === "running" ? "info" : "ok"} /> <span class="tnum">${r.elapsed}</span></span>
                </div>
              </div>
              <div class="row gap-2">
                <${Btn} size="sm" icon="↻" disabled=${r.status === "running"}>Rerun<//>
              </div>
            </div>
            <div style=${{marginTop: 12, display: "flex", flexDirection: "column", gap: 6}}>
              ${r.stages.map((s) => html`
                <div class="row gap-2" style=${{alignItems: "center"}}>
                  <${Badge} tone=${s.status === "succeeded" ? "ok" : s.status === "failed" ? "danger" : s.status === "running" ? "info" : "default"}>${s.name}<//>
                  <span class="muted" style=${{fontSize: 12}}>${s.status}${s.dur ? " · " + s.dur : ""}</span>
                </div>`)}
            </div>
          <//>`)}
      </div>
    <//>`;
};

const EnvironmentsPage = () => {
  const proj = useProject();
  const [active, setActive] = useState("release");
  const sb = proj.stateBackend;
  const sbLabel = sb.kind === "s3" ? sb.kind + " · " + sb.bucket
    : sb.kind === "gcs" ? sb.kind + " · " + sb.bucket
    : sb.kind + " · " + sb.resourceGroup + "/" + sb.storageAccount;
  return html`
    <${PageHead} title="Environments" sub=${"Deploy targets on " + proj.cloudLabel + ". Each env owns its own cluster + remote-state config."} actions=${html`<${Btn} variant="primary" icon="+">New environment<//>`} />
    <${Card} title="Active environment" sub="The env used by env-scoped pages by default.">
      <div class="row gap-2 wrap">
        ${proj.envs.map((e) => html`
          <button class="dda-env-tile" data-active=${active === e.key} onClick=${() => setActive(e.key)}>
            <div style=${{fontWeight: 700}}>${e.name}</div><div class="muted" style=${{fontSize: 11}}>${e.tier}</div>
          </button>`)}
      </div>
    <//>
    <${Card} title="All environments" sub=${proj.envs.length + " environments · " + proj.envs.filter((e) => e.cluster).length + " with cluster attached"}>
      <${Table} headers=${["Env", "Cloud", "Cluster", "State backend", "Members"]} rows=${proj.envs.map((e) => [
        html`<b>${e.name}</b> <${Badge} tone=${e.tier === "production" ? "danger" : e.tier === "staging" ? "warn" : "info"}>${e.tier}<//>`,
        html`<${Badge} tone="info">${proj.cloud}<//>`,
        e.cluster ? html`<span class="mono">${e.cluster}</span>` : html`<span class="muted">—</span>`,
        html`<span class="mono faint">${sbLabel}</span>`,
        String(e.tier === "production" ? 5 : 3),
      ])} />
    <//>`;
};

const ConnectionPage = () => {
  const proj = useProject();
  const connected = proj.envs.filter((e) => e.cluster);
  return html`
    <${PageHead} title="Connection" sub=${"Connect a running " + proj.clusterType + " cluster. The kubeconfig is stored encrypted on the environment."} />
    <div style=${{maxWidth: 960, width: "100%"}} class="col gap-5">
      <${Card} title="Connected clusters" sub="Persist on the environment; the AI chat queries these directly.">
        ${connected.length === 0 ? html`<div class="muted" style=${{padding: 20, textAlign: "center", fontSize: 13}}>No clusters connected yet.</div>` : html`
          <ul style=${{listStyle: "none", padding: 0, margin: 0}}>
            ${connected.map((e) => html`
              <li style=${{padding: "10px 0", borderBottom: "1px solid var(--border-soft)", fontSize: 13}}>
                <${Badge} tone="ok">connected<//> <b class="mono">${e.cluster}</b> · ${e.name} · ${proj.clusterNodes} nodes ready
              </li>`)}
          </ul>`}
      <//>
      <${Card} title=${"Connect " + proj.clusterType + " cluster"} sub=${"Locked to " + proj.cloudLabel + " (project cloud)"}>
        <div style=${{maxWidth: 520}}><div class="col gap-3">
          <${Field} label="Cloud provider" hint="Set by this project — can't be changed from here.">
            <div class="row gap-2 wrap">
              <${Chip} active=${true} icon="☁">${proj.cloudLabel}<//>
            </div>
          <//>
          <${Field} label="Environment" required><${Select} value="release" onChange=${() => {}} options=${proj.envs.map((e) => e.key)} /><//>
          ${proj.cloud === "aws" && html`<${Field} label="Region" required><${Input} value=${proj.region} /><//>`}
          ${proj.cloud === "azure" && html`<${Field} label="Resource group" required><${Input} value="rg-devops" /><//>`}
          ${proj.cloud === "gcp" && html`<${Field} label="GCP project" required><${Input} value=${proj.provider.project} /><//>`}
          <${Field} label="Cluster name" required><${Input} value=${proj.clusterName} /><//>
          <div class="row gap-2"><${Btn} variant="primary" icon="⚡">Connect<//><${Btn} variant="ghost">Paste kubeconfig instead<//></div>
        </div></div>
      <//>
    </div>`;
};

const CicdPage = () => html`
  <${PageHead} title="CI/CD & Repos" sub="Pipeline runs, workflow generators, and connected repositories." actions=${html`<${Btn} variant="primary" icon="+">Attach repo<//>`} />
  <${Card} title="Recent pipeline runs" sub="Latest 20 across all repos">
    <${Table} headers=${["Repo", "Workflow", "Branch", "Status", "Duration", "Actor"]} rows=${MOCK.pipelines.map((p) => [
      html`<span class="mono">${p.repo}</span>`, p.workflow, html`<span class="mono">${p.branch}</span>`,
      html`<${Badge} tone=${p.status === "succeeded" ? "ok" : p.status === "failed" ? "danger" : p.status === "running" ? "info" : "warn"}>${p.status}<//>`,
      html`<span class="tnum">${p.dur}</span>`, p.actor,
    ])} />
  <//>`;

const AlertsPage = () => html`
  <${PageHead} title="Alerts" sub="CloudWatch, Azure Monitor, GCP Monitoring, and in-cluster Prometheus." actions=${html`<${Btn}>Test alert<//><${Btn} variant="primary">Configure<//>`} />
  <div style=${{display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14}}>
    <${Stat} label="Open alerts" value="3" sub="5 total" icon="!" />
    <${Stat} label="High severity" value="1" sub="needs action" icon="⚠" />
    <${Stat} label="Security" value="0" sub="clean" icon="🛡" />
    <${Stat} label="Mean ack" value="14m" sub="last 30d" icon="◑" />
  </div>
  <div class="col gap-2">
    ${MOCK.alerts.map((a) => html`
      <${Card}>
        <div class="row between">
          <div class="col gap-1">
            <div class="row gap-2" style=${{alignItems: "center"}}><b>${a.name}</b><${Badge} tone=${a.sev === "high" ? "danger" : "warn"}>${a.sev}<//><${Badge} tone="info">${a.env}<//></div>
            <span class="muted" style=${{fontSize: 12.5}}>${a.target}</span>
          </div>
          <div class="row gap-2"><${Btn} size="sm">Investigate<//><${Btn} size="sm" variant="primary">Ack<//></div>
        </div>
      <//>`)}
  </div>`;

const CostPage = () => html`
  <${PageHead} title="Cost" sub="Multi-cloud spend rollup, budget tracking, and optimization findings." actions=${html`<${Btn}>Estimate infra<//><${Btn} variant="primary" icon="⚡">Optimize<//>`} />
  <div style=${{display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14}}>
    <${Stat} label="Month to date" value="$1,412" sub="68% of $2,100 budget" icon="$" />
    <${Stat} label="Forecast" value="$2,043" sub="within budget" icon="◆" />
    <${Stat} label="Savings" value="$187/mo" sub="3 recommendations" icon="▼" />
    <${Stat} label="Untagged" value="$96" sub="3 resources" icon="!" />
  </div>
  <${Card} title="By service" sub="Top 5 categories this month">
    <div style=${{height: 240, display: "flex", alignItems: "flex-end", gap: 12, padding: 20, background: "var(--surface-2)", borderRadius: 8}}>
      ${[["Azure", 482, "accent"], ["GCP", 267, "info"], ["GHCR", 198, "ok"], ["Vault", 124, "warn"], ["Egress", 72, "danger"]].map(([label, val, tone]) => html`
        <div style=${{flex: 1, background: "var(--" + tone + ")", borderRadius: "6px 6px 0 0", height: (val / 482 * 100) + "%", position: "relative"}}>
          <span style=${{position: "absolute", top: -22, left: 0, right: 0, textAlign: "center", fontSize: 11, fontWeight: 700}}>$${val} ${label}</span>
        </div>`)}
    </div>
  <//>`;

const UptimePage = () => html`
  <${PageHead} title="Uptime" sub="External HTTP monitors for the project's endpoints." actions=${html`<${Btn} variant="primary" icon="+">New monitor<//>`} />
  <${Card} title="Monitors" sub="3 active · 30d avg uptime 99.94%">
    <${Table} headers=${["URL", "Status", "Uptime 30d", "p50", "Last check"]} rows=${MOCK.monitors.map((m) => [
      html`<span class="mono">${m.url}</span>`,
      html`<${Badge} tone=${m.status === "up" ? "ok" : "warn"}>${m.status}<//>`,
      html`<span class="tnum">${m.uptime}</span>`,
      html`<span class="tnum">${m.p50}</span>`,
      html`<span class="faint">${m.last} ago</span>`,
    ])} />
  <//>`;

const SimplePage = (title, sub) => () => html`
  <${PageHead} title=${title} sub=${sub} />
  <${Card} title=${title} sub="Uses the same shared primitives as the pages implemented in full above.">
    <div class="muted" style=${{padding: 40, textAlign: "center", fontSize: 13}}>Real content is wired in the live app.</div>
  <//>`;

// ═════════════════════════════════════════════════════════════════════
// Source control — GitHub / GitLab OAuth accounts + project repo picker
// (Mirrors src/app/(app)/p/[projectSlug]/github/GithubConnectionClient.tsx)
// ═════════════════════════════════════════════════════════════════════
const AVAILABLE_REPOS = [
  { fullName: "manov7723-sys/deepagent", provider: "github", defaultBranch: "dev", visibility: "Private", stars: 12, updated: "2h ago" },
  { fullName: "manov7723-sys/dynamic-react-app", provider: "github", defaultBranch: "main", visibility: "Public", stars: 3, updated: "1d ago" },
  { fullName: "sriram-tecnso/deepagent", provider: "github", defaultBranch: "dev", visibility: "Private", stars: 5, updated: "3d ago" },
  { fullName: "acme/app-frontend", provider: "github", defaultBranch: "main", visibility: "Private", stars: 42, updated: "5h ago" },
  { fullName: "acme/worker", provider: "github", defaultBranch: "main", visibility: "Public", stars: 8, updated: "1w ago" },
];

const ChangeRepoModal = ({ onClose, currentFullName, onPick }) => {
  const [q, setQ] = useState("");
  const [selected, setSelected] = useState(currentFullName);
  const filtered = AVAILABLE_REPOS.filter((r) => !q || r.fullName.toLowerCase().includes(q.toLowerCase()));
  return html`
    <div style=${{position: "fixed", inset: 0, background: "var(--overlay)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20}} onClick=${onClose}>
      <div style=${{background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, boxShadow: "var(--shadow-lg)", maxWidth: 640, width: "100%", maxHeight: "80vh", display: "flex", flexDirection: "column"}} onClick=${(e) => e.stopPropagation()}>
        <div style=${{padding: "18px 20px", borderBottom: "1px solid var(--border-soft)"}}>
          <div class="row between" style=${{marginBottom: 6}}>
            <h2 style=${{fontSize: 17, margin: 0}}>Change project repository</h2>
            <${Btn} variant="ghost" size="icon" onClick=${onClose}>✕<//>
          </div>
          <p class="faint" style=${{fontSize: 12.5, margin: 0, lineHeight: 1.5}}>Pick the repository this project uses for Automation, CI, and security scans. The switch applies across the whole project.</p>
        </div>
        <div style=${{padding: "12px 20px", borderBottom: "1px solid var(--border-soft)"}}>
          <${Input} placeholder="Search repositories…" value=${q} onInput=${(e) => setQ(e.target.value)} />
        </div>
        <div style=${{flex: 1, overflowY: "auto"}}>
          ${filtered.length === 0 ? html`
            <div class="muted" style=${{padding: 40, textAlign: "center", fontSize: 13}}>No repositories match "${q}".</div>
          ` : filtered.map((r) => html`
            <button style=${{display: "flex", width: "100%", padding: "12px 20px", background: selected === r.fullName ? "var(--accent-soft)" : "transparent", border: "none", borderBottom: "1px solid var(--border-soft)", textAlign: "left", cursor: "pointer", color: "var(--text)", fontFamily: "inherit", alignItems: "center", gap: 12}} onClick=${() => setSelected(r.fullName)}>
              <span style=${{width: 32, height: 32, borderRadius: 8, background: "var(--surface-3)", display: "flex", alignItems: "center", justifyContent: "center", flex: "none", fontSize: 14}}>◍</span>
              <div class="col" style=${{gap: 3, minWidth: 0, flex: 1}}>
                <div class="row gap-2" style=${{alignItems: "center"}}>
                  <span style=${{fontWeight: 700, fontSize: 13.5}} class="mono">${r.fullName}</span>
                  ${r.fullName === currentFullName && html`<${Badge} tone="ok">current<//>`}
                  <${Badge} tone=${r.visibility === "Private" ? "warn" : "default"}>${r.visibility}<//>
                </div>
                <span class="faint" style=${{fontSize: 11.5}}>default: <span class="mono">${r.defaultBranch}</span> · ⋆ ${r.stars} · ${r.updated}</span>
              </div>
              ${selected === r.fullName && html`<span style=${{color: "var(--accent)", fontSize: 18}}>✓</span>`}
            </button>`)}
        </div>
        <div style=${{padding: "14px 20px", borderTop: "1px solid var(--border-soft)"}} class="row between">
          <span class="faint" style=${{fontSize: 12}}>${filtered.length} repositor${filtered.length === 1 ? "y" : "ies"} · switching consolidates to one</span>
          <div class="row gap-2">
            <${Btn} variant="ghost" onClick=${onClose}>Cancel<//>
            <${Btn} variant="primary" icon="✓" disabled=${!selected || selected === currentFullName} onClick=${() => { onPick(selected); onClose(); }}>Use this repo<//>
          </div>
        </div>
      </div>
    </div>`;
};

const GithubProviderCard = ({ provider, connected, account, onConnect, onDisconnect }) => {
  const label = provider === "github" ? "GitHub" : "GitLab";
  const icon = provider === "github" ? "◍" : "▲";
  const crNoun = provider === "gitlab" ? "merge" : "pull";
  return html`
    <${Card} title=${label} sub=${"Used for repo access, Dockerfile/workflow " + crNoun + " requests and CI setup"}>
      ${!connected ? html`
        <div class="col gap-3 center" style=${{padding: "36px 20px", textAlign: "center"}}>
          <span style=${{width: 44, height: 44, borderRadius: 12, background: "var(--surface-3)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20, color: "var(--text-muted)"}}>${icon}</span>
          <div style=${{fontWeight: 700, fontSize: 14}}>No ${label} account connected</div>
          <div class="muted" style=${{fontSize: 13, maxWidth: 380}}>Connect ${label} so the agent can read this project's repositories and open ${crNoun} requests.</div>
          <${Btn} variant="primary" icon=${icon} onClick=${onConnect}>Connect ${label}<//>
        </div>
      ` : html`
        <div class="col gap-3">
          ${account.map((a) => html`
            <div class="row gap-3 between" style=${{alignItems: "center", padding: "10px 12px", background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 10}}>
              <div class="row gap-3" style=${{alignItems: "center", minWidth: 0}}>
                <span style=${{width: 36, height: 36, borderRadius: 9, background: "var(--surface-3)", overflow: "hidden", display: "flex", alignItems: "center", justifyContent: "center", flex: "none", fontSize: 14, fontWeight: 800}}>${a.username.slice(0,2).toUpperCase()}</span>
                <div class="col" style=${{gap: 2, minWidth: 0}}>
                  <div class="row gap-2" style=${{alignItems: "center"}}>
                    <b style=${{fontSize: 13.5}}>${a.name}</b>
                    <span class="faint mono" style=${{fontSize: 12}}>@${a.username}</span>
                    <${Badge} tone="ok">connected<//>
                  </div>
                  <span class="faint" style=${{fontSize: 11.5}}>${a.email} · connected ${a.since}</span>
                </div>
              </div>
              <div class="row gap-2">
                <${Btn} size="sm" icon=${icon} onClick=${onConnect}>Reconnect<//>
                <${Btn} size="sm" variant="outline" onClick=${() => onDisconnect(a.id)}>Disconnect<//>
              </div>
            </div>`)}
          <div class="row gap-2 between" style=${{padding: "8px 4px 0"}}>
            <span class="faint" style=${{fontSize: 12}}>${account.length} account${account.length !== 1 ? "s" : ""} · agent uses OAuth token to read repos + open PRs</span>
            <${Btn} size="sm" variant="ghost" icon="+" onClick=${onConnect}>Add another ${label} account<//>
          </div>
        </div>
      `}
    <//>`;
};

const GithubPage = () => {
  const [ghConnected, setGhConnected] = useState(true);
  const [glConnected, setGlConnected] = useState(false);
  const [note, setNote] = useState(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [activeRepo, setActiveRepo] = useState("manov7723-sys/deepagent");
  const active = AVAILABLE_REPOS.find((r) => r.fullName === activeRepo);
  const ghAccounts = ghConnected ? [
    { id: "gh1", name: "manoi vv", username: "manov7723-sys", email: "manov7723@example.com", since: "Nov 4, 2025" },
  ] : [];
  const glAccounts = glConnected ? [
    { id: "gl1", name: "sriram", username: "sriram-tecnso", email: "sriram@tecneural.com", since: "Jul 13, 2026" },
  ] : [];
  const connect = (p) => {
    if (p === "github") setGhConnected(true);
    else setGlConnected(true);
    setNote(p === "github" ? "GitHub connected." : "GitLab connected.");
    setTimeout(() => setNote(null), 3000);
  };
  const disconnect = (p) => {
    if (p === "github") setGhConnected(false);
    else setGlConnected(false);
    setNote(p === "github" ? "GitHub disconnected." : "GitLab disconnected.");
    setTimeout(() => setNote(null), 3000);
  };
  return html`
    <${PageHead} title="Source control" sub="Manage the GitHub and GitLab accounts the agent uses to read your repositories and open pull / merge requests." />
    ${note && html`
      <div style=${{padding: "10px 14px", background: "var(--ok-soft)", color: "var(--ok)", borderRadius: 8, fontSize: 13, display: "flex", alignItems: "center", gap: 8}}>
        <span>✓</span><span>${note}</span>
      </div>`}
    <${GithubProviderCard} provider="github" connected=${ghConnected} account=${ghAccounts} onConnect=${() => connect("github")} onDisconnect=${() => disconnect("github")} />
    <${GithubProviderCard} provider="gitlab" connected=${glConnected} account=${glAccounts} onConnect=${() => connect("gitlab")} onDisconnect=${() => disconnect("gitlab")} />
    ${(ghConnected || glConnected) && html`
      <${Card} title="Project repository" sub="The repository this project uses everywhere — Automation, CI, and security scans. Changing it applies across the whole project.">
        <div class="row between gap-3 wrap" style=${{alignItems: "center"}}>
          ${active ? html`
            <div class="row gap-3" style=${{alignItems: "center", minWidth: 0}}>
              <span style=${{width: 42, height: 42, borderRadius: 10, background: "var(--surface-3)", display: "flex", alignItems: "center", justifyContent: "center", flex: "none", fontSize: 18}}>◍</span>
              <div class="col" style=${{gap: 3, minWidth: 0}}>
                <div class="row gap-2" style=${{alignItems: "center"}}>
                  <strong style=${{fontSize: 14}} class="mono">${active.fullName}</strong>
                  <${Badge} tone=${active.visibility === "Private" ? "warn" : "default"}>${active.visibility}<//>
                </div>
                <span class="faint" style=${{fontSize: 12}}>Default branch: <span class="mono">${active.defaultBranch}</span> · updated ${active.updated}</span>
              </div>
            </div>
          ` : html`<span class="muted" style=${{fontSize: 13}}>No repository set for this project yet.</span>`}
          <${Btn} variant="outline" icon="◍" onClick=${() => setModalOpen(true)}>${active ? "Change repo" : "Set repository"}<//>
        </div>
      <//>`}
    <div class="row gap-2 faint" style=${{fontSize: 12, alignItems: "flex-start", padding: "8px 4px"}}>
      <span>🔒</span>
      <span>Disconnecting removes the agent's access to that provider's repositories. You can reconnect at any time — it's the same flow used when creating a project.</span>
    </div>
    ${modalOpen && html`<${ChangeRepoModal} onClose=${() => setModalOpen(false)} currentFullName=${activeRepo} onPick=${(r) => { setActiveRepo(r); setNote("Project repository changed to " + r + "."); setTimeout(() => setNote(null), 3000); }} />`}
  `;
};

// ═════════════════════════════════════════════════════════════════════
// Topology — SVG service graph showing traffic flow through the cluster
// ═════════════════════════════════════════════════════════════════════
const TopologyPage = () => {
  const proj = useProject();
  const [ns, setNs] = useState("default");
  // Node coordinates for the SVG graph. Left-to-right traffic flow.
  const nodes = [
    { id: "users", label: "Users", type: "external", x: 60, y: 260 },
    { id: "ingress", label: "ingress-nginx", sub: "LoadBalancer", type: "ingress", x: 260, y: 260 },
    { id: "svc-front", label: "app-frontend-svc", sub: "ClusterIP · :8080", type: "service", x: 500, y: 140 },
    { id: "svc-api", label: "api-svc", sub: "ClusterIP · :4000", type: "service", x: 500, y: 260 },
    { id: "svc-worker", label: "worker-svc", sub: "Headless", type: "service", x: 500, y: 380 },
    { id: "dep-front", label: "app-frontend", sub: "Deployment · 3/3", type: "deployment", x: 760, y: 140 },
    { id: "dep-api", label: "api", sub: "Deployment · 2/2", type: "deployment", x: 760, y: 260 },
    { id: "dep-worker", label: "worker", sub: "Deployment · 2/2", type: "deployment", x: 760, y: 380 },
    { id: "db", label: "postgres", sub: "Managed · " + proj.cloudLabel, type: "external", x: 1020, y: 260 },
  ];
  const edges = [
    ["users", "ingress"],
    ["ingress", "svc-front"], ["ingress", "svc-api"],
    ["svc-front", "dep-front"], ["svc-api", "dep-api"], ["svc-worker", "dep-worker"],
    ["dep-front", "svc-api"], ["dep-api", "db"], ["dep-worker", "db"],
  ];
  const colors = {
    external: { bg: "var(--surface-3)", stroke: "var(--border)", fg: "var(--text)" },
    ingress: { bg: "var(--info-soft)", stroke: "var(--info)", fg: "var(--info)" },
    service: { bg: "var(--accent-soft)", stroke: "var(--accent-line)", fg: "var(--accent)" },
    deployment: { bg: "var(--ok-soft)", stroke: "var(--ok)", fg: "var(--ok)" },
  };
  const findNode = (id) => nodes.find((n) => n.id === id);
  return html`
    <${PageHead} title="Topology" sub=${"Live service graph for " + proj.clusterName + " (" + proj.cloudLabel + " · " + proj.region + ") — traffic flow left → right."} />
    <div class="row gap-3 wrap" style=${{alignItems: "center"}}>
      <div style=${{minWidth: 220}}><${Field} label="Environment"><${Select} value="release" onChange=${() => {}} options=${proj.envs.map((e) => e.key)} /><//></div>
      <div style=${{minWidth: 220}}><${Field} label="Namespace"><${Select} value=${ns} onChange=${setNs} options=${["default", "kube-system", "monitoring", "ingress-nginx"]} /><//></div>
      <div class="row gap-2 wrap" style=${{marginLeft: "auto"}}>
        <${Chip}><span style=${{width: 8, height: 8, background: "var(--info)", borderRadius: "50%", display: "inline-block", marginRight: 6}}></span>ingress<//>
        <${Chip}><span style=${{width: 8, height: 8, background: "var(--accent)", borderRadius: "50%", display: "inline-block", marginRight: 6}}></span>service<//>
        <${Chip}><span style=${{width: 8, height: 8, background: "var(--ok)", borderRadius: "50%", display: "inline-block", marginRight: 6}}></span>deployment<//>
      </div>
    </div>
    <${Card} title=${proj.clusterName + " / " + ns} sub=${nodes.filter((n) => n.type !== "external").length + " workloads · " + edges.length + " edges"}>
      <div style=${{background: "var(--surface-2)", borderRadius: 8, overflow: "hidden"}}>
        <svg viewBox="0 0 1140 520" style=${{width: "100%", height: 520, display: "block"}} xmlns="http://www.w3.org/2000/svg">
          <defs>
            <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto">
              <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--text-muted)" opacity="0.7" />
            </marker>
            <pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
              <path d="M 40 0 L 0 0 0 40" fill="none" stroke="var(--border-soft)" stroke-width="0.5" opacity="0.4" />
            </pattern>
          </defs>
          <rect width="1140" height="520" fill="url(#grid)" />
          ${edges.map(([from, to]) => {
            const a = findNode(from), b = findNode(to);
            const mx = (a.x + b.x) / 2;
            return html`<path d=${"M " + (a.x + 60) + " " + a.y + " C " + mx + " " + a.y + ", " + mx + " " + b.y + ", " + (b.x - 60) + " " + b.y} fill="none" stroke="var(--text-muted)" stroke-width="1.5" opacity="0.5" marker-end="url(#arrow)" />`;
          })}
          ${nodes.map((n) => {
            const c = colors[n.type];
            return html`
              <g transform=${"translate(" + (n.x - 60) + "," + (n.y - 30) + ")"}>
                <rect width="120" height="60" rx="10" fill=${c.bg} stroke=${c.stroke} stroke-width="1.5" />
                <text x="60" y="26" text-anchor="middle" font-size="12" font-weight="700" fill=${c.fg} font-family="var(--font-ui)">${n.label}</text>
                ${n.sub && html`<text x="60" y="44" text-anchor="middle" font-size="10" fill="var(--text-muted)" font-family="var(--font-ui)">${n.sub}</text>`}
              </g>`;
          })}
        </svg>
      </div>
      <div class="row gap-4 wrap" style=${{marginTop: 14, fontSize: 12, color: "var(--text-muted)"}}>
        <span><b>7</b> pods running</span>
        <span><b>3</b> services</span>
        <span><b>1</b> ingress</span>
        <span><b>0</b> unhealthy</span>
        <span style=${{marginLeft: "auto"}}>Auto-refreshed 12s ago</span>
      </div>
    <//>`;
};

// ═════════════════════════════════════════════════════════════════════
// Cloud stats — Grafana-style monitoring dashboard
// ═════════════════════════════════════════════════════════════════════
// Generate believable-looking time-series data (60 points, deterministic).
const genSeries = (seed, base, amp, spike) => {
  const out = [];
  let v = base;
  for (let i = 0; i < 60; i++) {
    v = base + Math.sin(i * 0.3 + seed) * amp + Math.cos(i * 0.15 + seed * 2) * amp * 0.4;
    if (spike && i > 40 && i < 50) v += spike * (1 - Math.abs(i - 45) / 5);
    out.push(Math.max(0, v));
  }
  return out;
};

// Draw an SVG line chart. Points are normalized into the viewBox.
const LineChart = ({ series, max, color, w = 500, h = 140, showArea = true }) => {
  const step = w / (series.length - 1);
  const points = series.map((v, i) => [i * step, h - (v / max) * h]);
  const path = points.map((p, i) => (i === 0 ? "M" : "L") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join(" ");
  const area = path + " L " + w + " " + h + " L 0 " + h + " Z";
  return html`
    <svg viewBox=${"0 0 " + w + " " + h} preserveAspectRatio="none" style=${{width: "100%", height: h, display: "block"}}>
      ${[0.25, 0.5, 0.75].map((y) => html`<line x1="0" x2=${w} y1=${h * y} y2=${h * y} stroke="var(--border-soft)" stroke-width="0.5" stroke-dasharray="4 4" />`)}
      ${showArea && html`<path d=${area} fill=${color} opacity="0.15" />`}
      <path d=${path} fill="none" stroke=${color} stroke-width="2" stroke-linejoin="round" stroke-linecap="round" />
    </svg>`;
};

// Grafana-style panel wrapper — dark header, big value, chart below.
const GrafanaPanel = ({ title, value, unit, color, series, max }) => html`
  <div style=${{background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, overflow: "hidden"}}>
    <div style=${{padding: "10px 14px", borderBottom: "1px solid var(--border-soft)", display: "flex", justifyContent: "space-between", alignItems: "center"}}>
      <span style=${{fontSize: 12.5, fontWeight: 700, color: "var(--text)"}}>${title}</span>
      <span style=${{fontSize: 11, color: "var(--text-faint)"}}>last 60m</span>
    </div>
    <div style=${{padding: "12px 14px 6px", display: "flex", alignItems: "baseline", gap: 6}}>
      <span style=${{fontSize: 26, fontWeight: 800, letterSpacing: "-.02em", color: color}}>${value}</span>
      <span style=${{fontSize: 12, color: "var(--text-muted)", fontWeight: 600}}>${unit}</span>
    </div>
    <${LineChart} series=${series} max=${max} color=${color} h=${100} />
  </div>`;

const StatsPage = () => {
  const proj = useProject();
  const cpu = genSeries(1, 55, 12, 20);
  const mem = genSeries(2, 62, 8, 0);
  const req = genSeries(3, 340, 80, 100);
  const err = genSeries(4, 0.3, 0.2, 1.5);
  const pods = { running: 7, pending: 1, failed: 0, total: 8 };
  const donutRadius = 60, donutInner = 40;
  const donutSegs = [
    { color: "var(--ok)", value: pods.running, label: "Running" },
    { color: "var(--warn)", value: pods.pending, label: "Pending" },
    { color: "var(--danger)", value: pods.failed, label: "Failed" },
  ];
  let cum = 0;
  const donutPaths = donutSegs.map((s) => {
    const start = (cum / pods.total) * Math.PI * 2 - Math.PI / 2;
    cum += s.value;
    const end = (cum / pods.total) * Math.PI * 2 - Math.PI / 2;
    const x1 = 90 + donutRadius * Math.cos(start), y1 = 90 + donutRadius * Math.sin(start);
    const x2 = 90 + donutRadius * Math.cos(end), y2 = 90 + donutRadius * Math.sin(end);
    const x3 = 90 + donutInner * Math.cos(end), y3 = 90 + donutInner * Math.sin(end);
    const x4 = 90 + donutInner * Math.cos(start), y4 = 90 + donutInner * Math.sin(start);
    const large = end - start > Math.PI ? 1 : 0;
    return { ...s, path: "M " + x1 + " " + y1 + " A " + donutRadius + " " + donutRadius + " 0 " + large + " 1 " + x2 + " " + y2 + " L " + x3 + " " + y3 + " A " + donutInner + " " + donutInner + " 0 " + large + " 0 " + x4 + " " + y4 + " Z" };
  });
  return html`
    <${PageHead} title="Cloud stats" sub=${"Live cluster metrics for " + proj.clusterName + " (" + proj.cloudLabel + ") via in-cluster Prometheus + Grafana."} actions=${html`<${Btn} icon="↗">Open in Grafana<//><${Btn} variant="primary" icon="↻">Refresh<//>`} />
    <div class="row gap-2 wrap"><${Chip} active=${true}>release<//><${Chip}>beta<//><${Chip}>alpha<//><span class="row gap-2" style=${{marginLeft: "auto", alignItems: "center", fontSize: 12, color: "var(--text-muted)"}}><${Dot} tone="ok" /> Prometheus scraping · 12s ago</span></div>
    <div style=${{display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))", gap: 14}}>
      <${Stat} label="CPU (cluster avg)" value=${Math.round(cpu[cpu.length-1]) + "%"} sub="node pool: system + app" icon="◍" />
      <${Stat} label="Memory (cluster avg)" value=${Math.round(mem[mem.length-1]) + "%"} sub="8/12 nodes reporting" icon="▤" />
      <${Stat} label="Pods running" value=${String(pods.running)} sub=${pods.pending + " pending · " + pods.failed + " failed"} icon="◆" />
      <${Stat} label="Requests/min" value=${Math.round(req[req.length-1])} sub="p50 142ms · p95 812ms" icon="↔" />
    </div>
    <div style=${{display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14}}>
      <${GrafanaPanel} title="CPU usage · cluster" value=${Math.round(cpu[cpu.length-1])} unit="%" color="var(--accent)" series=${cpu} max=${100} />
      <${GrafanaPanel} title="Memory usage · cluster" value=${Math.round(mem[mem.length-1])} unit="%" color="var(--info)" series=${mem} max=${100} />
      <${GrafanaPanel} title="HTTP requests" value=${Math.round(req[req.length-1])} unit="req/min" color="var(--ok)" series=${req} max=${500} />
      <${GrafanaPanel} title="5xx error rate" value=${err[err.length-1].toFixed(2)} unit="%" color="var(--danger)" series=${err} max=${3} />
    </div>
    <div style=${{display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14}}>
      <${Card} title="Pod status" sub=${pods.total + " pods across " + proj.clusterNodes + " nodes"}>
        <div class="row gap-4" style=${{alignItems: "center"}}>
          <svg viewBox="0 0 180 180" style=${{width: 180, height: 180, flex: "none"}}>
            ${donutPaths.map((s) => html`<path d=${s.path} fill=${s.color} />`)}
            <text x="90" y="86" text-anchor="middle" font-size="26" font-weight="800" fill="var(--text)" font-family="var(--font-ui)">${pods.running}</text>
            <text x="90" y="104" text-anchor="middle" font-size="11" fill="var(--text-muted)" font-family="var(--font-ui)">of ${pods.total} running</text>
          </svg>
          <div class="col gap-2" style=${{flex: 1}}>
            ${donutSegs.map((s) => html`
              <div class="row gap-2" style=${{alignItems: "center", fontSize: 13}}>
                <span style=${{width: 12, height: 12, background: s.color, borderRadius: 3, flex: "none"}}></span>
                <span>${s.label}</span>
                <span style=${{marginLeft: "auto", fontWeight: 700, fontFamily: "var(--font-mono)"}}>${s.value}</span>
              </div>`)}
          </div>
        </div>
      <//>
      <${Card} title="Prometheus scrape targets" sub="8 targets · all up">
        <ul style=${{listStyle: "none", padding: 0, margin: 0}}>
          ${[
            ["kube-state-metrics", "monitoring", "up", "8s"],
            ["node-exporter (× 3)", "monitoring", "up", "9s"],
            ["cadvisor", "kube-system", "up", "11s"],
            ["app-frontend", "default", "up", "12s"],
            ["worker", "default", "up", "13s"],
            ["api", "default", "up", "12s"],
          ].map(([target, ns, status, lastScrape]) => html`
            <li style=${{padding: "8px 0", borderBottom: "1px solid var(--border-soft)", display: "flex", alignItems: "center", gap: 10, fontSize: 13}}>
              <${Dot} tone="ok" />
              <span class="mono" style=${{fontWeight: 600}}>${target}</span>
              <span class="faint" style=${{fontSize: 11}}>${ns}</span>
              <span style=${{marginLeft: "auto"}} class="faint">${lastScrape} ago</span>
            </li>`)}
        </ul>
      <//>
    </div>
    <${Card} title="Grafana dashboards" sub="Linked from this project — click to open in Grafana">
      <div style=${{display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))", gap: 12}}>
        ${[
          { title: "Cluster overview", panels: 12, updated: "2m ago", tag: "kubernetes" },
          { title: "Application SLOs", panels: 8, updated: "5m ago", tag: "slo" },
          { title: "Node capacity", panels: 6, updated: "8m ago", tag: "capacity" },
        ].map((d) => html`
          <button style=${{textAlign: "left", padding: 14, background: "var(--surface)", border: "1px solid var(--border-soft)", borderRadius: 10, cursor: "pointer", color: "var(--text)", fontFamily: "inherit"}}>
            <div class="row gap-2" style=${{alignItems: "center", marginBottom: 6}}>
              <span style=${{width: 22, height: 22, borderRadius: 6, background: "oklch(0.72 0.19 45 / 0.2)", color: "oklch(0.72 0.19 45)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 11, fontWeight: 800}}>G</span>
              <span style=${{fontWeight: 700, fontSize: 13.5}}>${d.title}</span>
            </div>
            <div class="faint" style=${{fontSize: 12}}>${d.panels} panels · updated ${d.updated}</div>
            <div class="row gap-2" style=${{marginTop: 8}}><${Chip}>${d.tag}<//></div>
          </button>`)}
      </div>
    <//>`;
};

// ═════════════════════════════════════════════════════════════════════
// Promotions — deploy the same image forward across envs
// ═════════════════════════════════════════════════════════════════════
const APPS_SEED = [
  {
    id: "app-frontend",
    name: "app-frontend",
    repo: "manov7723-sys/deepagent/frontend",
    lang: "TypeScript · Next.js",
    images: { alpha: "sha-a1b2c3d", beta: "sha-9e4f7ab", release: "sha-7e2f8d0" },
    tags: { alpha: "2m ago", beta: "12m ago", release: "3d ago" },
    health: { alpha: "healthy", beta: "healthy", release: "healthy" },
  },
  {
    id: "api",
    name: "api",
    repo: "manov7723-sys/deepagent/api",
    lang: "TypeScript · Node.js",
    images: { alpha: "sha-4d2e1fb", beta: "sha-4d2e1fb", release: "sha-c3d4e5f" },
    tags: { alpha: "8m ago", beta: "4h ago", release: "2d ago" },
    health: { alpha: "healthy", beta: "healthy", release: "healthy" },
  },
  {
    id: "worker",
    name: "worker",
    repo: "manov7723-sys/deepagent/worker",
    lang: "Go",
    images: { alpha: "sha-8b1a2c4", beta: null, release: null },
    tags: { alpha: "22m ago", beta: null, release: null },
    health: { alpha: "healthy", beta: null, release: null },
  },
];

const PROMO_HISTORY_SEED = [
  { app: "app-frontend", from: "beta", to: "release", image: "sha-7e2f8d0", by: "manov", when: "3d ago", status: "succeeded" },
  { app: "api", from: "alpha", to: "beta", image: "sha-4d2e1fb", by: "manov", when: "4h ago", status: "succeeded" },
  { app: "api", from: "beta", to: "release", image: "sha-c3d4e5f", by: "sriram", when: "2d ago", status: "succeeded" },
  { app: "app-frontend", from: "alpha", to: "beta", image: "sha-9e4f7ab", by: "manov", when: "12m ago", status: "succeeded" },
  { app: "worker", from: "alpha", to: "beta", image: "sha-e7f4b12", by: "manov", when: "6h ago", status: "failed" },
];

// Promote-confirm modal: shows what changes, requires explicit confirm.
const PromoteModal = ({ app, from, to, onConfirm, onClose }) => {
  const fromImage = app.images[from];
  const toImage = app.images[to];
  return html`
    <div style=${{position: "fixed", inset: 0, background: "var(--overlay)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20}} onClick=${onClose}>
      <div style=${{background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, boxShadow: "var(--shadow-lg)", maxWidth: 560, width: "100%", padding: 24}} onClick=${(e) => e.stopPropagation()}>
        <div class="row between" style=${{marginBottom: 6}}>
          <h2 style=${{fontSize: 17, margin: 0}}>Promote ${app.name}</h2>
          <${Btn} variant="ghost" size="icon" onClick=${onClose}>✕<//>
        </div>
        <p class="faint" style=${{fontSize: 12.5, margin: "0 0 20px", lineHeight: 1.5}}>Copy the image currently deployed on <b>${from}</b> forward to <b>${to}</b>. The ${to} rollout starts immediately.</p>
        <div class="col gap-3" style=${{padding: 16, background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 10, marginBottom: 20}}>
          <div class="row between" style=${{alignItems: "center"}}>
            <div class="col" style=${{gap: 2}}>
              <div class="faint" style=${{fontSize: 11, textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 700}}>${from}</div>
              <div class="mono" style=${{fontSize: 13}}>${fromImage}</div>
            </div>
            <span style=${{fontSize: 18, color: "var(--accent)"}}>→</span>
            <div class="col" style=${{gap: 2, textAlign: "right"}}>
              <div class="faint" style=${{fontSize: 11, textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 700}}>${to}</div>
              <div class="mono" style=${{fontSize: 13}}>${toImage || html`<span class="faint">— (not deployed)</span>`}</div>
            </div>
          </div>
        </div>
        ${to === "release" && html`
          <div style=${{padding: "10px 14px", background: "var(--warn-soft)", color: "var(--warn)", borderRadius: 8, fontSize: 12.5, marginBottom: 20, display: "flex", gap: 8, alignItems: "flex-start"}}>
            <span>⚠</span>
            <span>Promoting to <b>release</b> triggers a production deploy. Approvers on the Approvals page will be notified.</span>
          </div>`}
        <div class="row gap-2" style=${{justifyContent: "flex-end"}}>
          <${Btn} variant="ghost" onClick=${onClose}>Cancel<//>
          <${Btn} variant="primary" icon="▲" onClick=${onConfirm}>Promote to ${to}<//>
        </div>
      </div>
    </div>`;
};

const PromotionsPage = () => {
  const proj = useProject();
  const [apps, setApps] = useState(APPS_SEED);
  const [history, setHistory] = useState(PROMO_HISTORY_SEED);
  const [namespace, setNamespace] = useState("default");
  const [pendingPromo, setPendingPromo] = useState(null); // { app, from, to }

  const doPromote = () => {
    const { app, from, to } = pendingPromo;
    const nextApps = apps.map((a) => {
      if (a.id !== app.id) return a;
      return {
        ...a,
        images: { ...a.images, [to]: a.images[from] },
        tags: { ...a.tags, [to]: "just now" },
        health: { ...a.health, [to]: "rolling out" },
      };
    });
    setApps(nextApps);
    setHistory([{ app: app.name, from, to, image: app.images[from], by: "manov", when: "just now", status: "succeeded" }, ...history]);
    setPendingPromo(null);
  };

  const envs = ["alpha", "beta", "release"];
  const envTone = { alpha: "info", beta: "warn", release: "danger" };
  const envSub = { alpha: "dev", beta: "staging", release: "production" };

  return html`
    <${PageHead} title="Promotions" sub=${"Promote a deployed image between environments (alpha → beta → release) on " + proj.clusterName + "."} actions=${html`<${Btn} variant="primary" icon="+">New promotion<//>`} />
    <div class="row gap-3 wrap" style=${{alignItems: "center"}}>
      <div style=${{minWidth: 220}}><${Field} label="Namespace"><${Select} value=${namespace} onChange=${setNamespace} options=${["default", "kube-system", "monitoring"]} /><//></div>
      <div class="row gap-2 wrap" style=${{marginLeft: "auto", alignItems: "center", fontSize: 12, color: "var(--text-muted)"}}>
        <${Dot} tone="ok" /> <span>Deploys through the Approvals gate for release env</span>
      </div>
    </div>

    ${apps.map((app) => html`
      <${Card} title=${app.name} sub=${app.repo + " · " + app.lang}>
        <div style=${{display: "grid", gridTemplateColumns: "1fr auto 1fr auto 1fr", gap: 12, alignItems: "stretch"}}>
          ${envs.map((env, i) => html`
            ${i > 0 && html`
              <div style=${{display: "flex", alignItems: "center", justifyContent: "center", padding: "0 4px"}}>
                ${app.images[envs[i-1]] && app.images[envs[i-1]] !== app.images[env] ? html`
                  <button class="btn primary sm" style=${{whiteSpace: "nowrap"}} onClick=${() => setPendingPromo({ app, from: envs[i-1], to: env })}>
                    → ${env}
                  </button>
                ` : html`<span style=${{color: "var(--text-faint)", fontSize: 18}}>→</span>`}
              </div>`}
            <div style=${{padding: 14, background: "var(--surface-2)", border: "1px solid " + (app.images[env] ? "var(--border-soft)" : "var(--border)"), borderRadius: 10, minWidth: 0}}>
              <div class="row between" style=${{alignItems: "center", marginBottom: 8}}>
                <${Badge} tone=${envTone[env]}>${env}<//>
                <span class="faint" style=${{fontSize: 11}}>${envSub[env]}</span>
              </div>
              ${app.images[env] ? html`
                <div class="mono" style=${{fontSize: 12.5, fontWeight: 700, wordBreak: "break-all"}}>${app.images[env]}</div>
                <div class="row gap-2" style=${{marginTop: 8, alignItems: "center"}}>
                  <${Dot} tone=${app.health[env] === "healthy" ? "ok" : "info"} />
                  <span class="muted" style=${{fontSize: 11.5}}>${app.health[env]} · ${app.tags[env]}</span>
                </div>
              ` : html`
                <div class="faint" style=${{fontSize: 12, padding: "16px 0"}}>Not deployed to ${env} yet</div>
              `}
            </div>`)}
        </div>
      <//>
    `)}

    <${Card} title="Recent promotions" sub=${history.length + " total · latest first"}>
      <${Table} headers=${["When", "App", "Movement", "Image", "By", "Status"]} rows=${history.slice(0, 8).map((h) => [
        html`<span class="faint">${h.when}</span>`,
        html`<b>${h.app}</b>`,
        html`<span class="row gap-2" style=${{alignItems: "center"}}><${Badge} tone=${envTone[h.from]}>${h.from}<//><span class="faint">→</span><${Badge} tone=${envTone[h.to]}>${h.to}<//></span>`,
        html`<span class="mono" style=${{fontSize: 12.5}}>${h.image}</span>`,
        h.by,
        html`<${Badge} tone=${h.status === "succeeded" ? "ok" : "danger"}>${h.status}<//>`,
      ])} />
    <//>
    ${pendingPromo && html`<${PromoteModal} app=${pendingPromo.app} from=${pendingPromo.from} to=${pendingPromo.to} onConfirm=${doPromote} onClose=${() => setPendingPromo(null)} />`}
  `;
};

// ═════════════════════════════════════════════════════════════════════
// Nav
// ═════════════════════════════════════════════════════════════════════
// Icon names come from src/components/ui/Icon.tsx — same registry the real
// nav-registry.ts uses, so the sidebar renders identical stroke-SVG glyphs.
const PAGES = {
  dashboard: { label: "Dashboard", icon: "dashboard", component: DashboardPage },
  chat: { label: "Chat", icon: "chat", component: ChatPage },
  cicd: { label: "CI/CD & Repos", icon: "cicd", component: CicdPage },
  environments: { label: "Environments", icon: "layers", component: EnvironmentsPage },
  cloud: { label: "Cloud providers", icon: "cloud", component: CloudPage },
  infra: { label: "Infrastructure", icon: "server", component: InfraPage },
  topology: { label: "Topology", icon: "link", component: TopologyPage },
  promotions: { label: "Promotions", icon: "branch", component: PromotionsPage },
  github: { label: "Source control", icon: "github", component: GithubPage },
  connection: { label: "Clusters", icon: "globe", component: ConnectionPage },
  stats: { label: "Cloud stats", icon: "stats", component: StatsPage },
  uptime: { label: "Uptime", icon: "gauge", component: UptimePage },
  scheduler: { label: "Scheduler", icon: "clock", component: SimplePage("Scheduler", "Deploy later — schedule an image + env for automatic rollout.") },
  cost: { label: "Cost", icon: "dollar", component: CostPage },
  tasks: { label: "Tasks", icon: "tasks", component: SimplePage("Tasks", "Autonomous agent runs — scheduled or on-demand.") },
  knowledge: { label: "Knowledge", icon: "book", component: SimplePage("Knowledge", "Runbooks, incident postmortems, reference docs.") },
  approvals: { label: "Approvals", icon: "approve", component: SimplePage("Approvals", "Gated changes waiting on a human.") },
  alerts: { label: "Alerts", icon: "alert", component: AlertsPage },
  activity: { label: "Activity", icon: "activity", component: SimplePage("Activity", "Every audit-worthy action in the project.") },
  settings: { label: "Settings", icon: "settings", component: SimplePage("Project settings", "General, integrations, members, danger zone.") },
};

const NAV_GROUPS = [
  { label: null, items: ["dashboard","chat","cicd","environments","cloud","infra","topology"] },
  { label: "Deploy", items: ["promotions"] },
  { label: "Connection", items: ["github","connection","stats","uptime","scheduler"] },
  { label: null, items: ["cost","tasks","knowledge","approvals","alerts","activity","settings"] },
];

// ═════════════════════════════════════════════════════════════════════
// Shell
// ═════════════════════════════════════════════════════════════════════
const ProjectSwitcher = ({ activeSlug, onSwitch }) => {
  const [open, setOpen] = useState(false);
  const active = PROJECTS[activeSlug];
  const cloudTint = { aws: "oklch(0.72 0.19 45)", azure: "oklch(0.7 0.17 235)", gcp: "oklch(0.74 0.17 158)" };
  return html`
    <div style=${{position: "relative"}}>
      <button class="btn outline block" style=${{width: "100%", justifyContent: "space-between"}} onClick=${() => setOpen(!open)}>
        <span class="row gap-2" style=${{alignItems: "center"}}>
          <span style=${{width: 22, height: 22, borderRadius: 6, background: cloudTint[active.cloud], color: "white", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 800}}>${active.cloudLabel.slice(0,2).toUpperCase()}</span>
          <span>${active.name}</span>
        </span>
        <span class="faint">▾</span>
      </button>
      ${open && html`
        <div style=${{position: "absolute", top: "calc(100% + 4px)", left: 0, right: 0, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 8, boxShadow: "var(--shadow)", zIndex: 100, overflow: "hidden"}}>
          <div style=${{fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--text-faint)", padding: "8px 12px 4px", fontWeight: 700}}>Switch project</div>
          ${Object.values(PROJECTS).map((p) => html`
            <button style=${{display: "flex", width: "100%", padding: "10px 12px", background: p.slug === activeSlug ? "var(--surface-3)" : "transparent", border: "none", textAlign: "left", cursor: "pointer", color: "var(--text)", fontFamily: "inherit", fontSize: 13, alignItems: "center", gap: 10}} onClick=${() => { onSwitch(p.slug); setOpen(false); }}>
              <span style=${{width: 22, height: 22, borderRadius: 6, background: cloudTint[p.cloud], color: "white", display: "inline-flex", alignItems: "center", justifyContent: "center", fontSize: 10, fontWeight: 800, flex: "none"}}>${p.cloudLabel.slice(0,2).toUpperCase()}</span>
              <span class="col">
                <span style=${{fontWeight: 600}}>${p.name}</span>
                <span class="faint" style=${{fontSize: 11}}>${p.cloudLabel} · ${p.clusterType} · ${p.region}</span>
              </span>
              ${p.slug === activeSlug && html`<span class="faint" style=${{marginLeft: "auto"}}>✓</span>`}
            </button>`)}
          <div style=${{borderTop: "1px solid var(--border-soft)"}}>
            <button style=${{display: "flex", width: "100%", padding: "10px 12px", background: "transparent", border: "none", textAlign: "left", cursor: "pointer", color: "var(--accent)", fontFamily: "inherit", fontSize: 13, alignItems: "center", gap: 10, fontWeight: 600}}>
              <span>+</span><span>Create new project</span>
            </button>
          </div>
        </div>`}
    </div>`;
};

const Sidebar = ({ active, onSelect, activeProject, onSwitchProject }) => html`
  <aside class="dda-sidebar col">
    <div class="dda-sidebar-head row between">
      <div class="row gap-2" style=${{alignItems: "center"}}>
        <span style=${{width: 34, height: 34, borderRadius: 10, background: "var(--accent)", color: "var(--accent-fg)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 14}}>◐</span>
        <div class="col">
          <span style=${{fontWeight: 800, fontSize: 13.5, letterSpacing: "-.01em"}}>DeepAgent DevOps</span>
          <span class="faint" style=${{fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".08em", fontWeight: 700}}>Autonomous infra</span>
        </div>
      </div>
    </div>
    <div style=${{padding: "0 12px 8px"}}>
      <${ProjectSwitcher} activeSlug=${activeProject} onSwitch=${onSwitchProject} />
    </div>
    <nav class="col gap-1 dda-sidebar-nav">
      ${NAV_GROUPS.map((g) => html`
        ${g.label && html`<div class="dda-sidebar-sep">${g.label}</div>`}
        ${g.items.map((id) => html`
          <a href=${"#" + id} class=${"dda-sidebar-item row" + (active === id ? " active" : "")} onClick=${(e) => { e.preventDefault(); onSelect(id); }}>
            <${Icon} name=${PAGES[id].icon} size=${16} />
            <span>${PAGES[id].label}</span>
          </a>`)}
      `)}
    </nav>
    <div class="dda-sidebar-foot">
      <div class="dda-sidebar-status card card-pad">
        <div class="row gap-2" style=${{alignItems: "center"}}><${Dot} tone="ok" /><span style=${{fontWeight: 600, fontSize: 12.5}}>All systems ok</span></div>
        <div class="faint" style=${{fontSize: 11, marginTop: 4}}>Last check 2m ago</div>
      </div>
    </div>
  </aside>`;

const UserMenu = ({ session, onLogout }) => {
  const [open, setOpen] = useState(false);
  const initials = (session.name || session.email || "?").split(/\s+|@/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  return html`
    <div style=${{position: "relative"}}>
      <button class="btn ghost icon sm" style=${{fontSize: 11, fontWeight: 700}} onClick=${() => setOpen(!open)}>${initials}</button>
      ${open && html`
        <div style=${{position: "absolute", top: "calc(100% + 6px)", right: 0, minWidth: 240, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "var(--shadow-lg)", zIndex: 150, overflow: "hidden"}}>
          <div style=${{padding: "12px 14px", borderBottom: "1px solid var(--border-soft)"}}>
            <div style=${{fontWeight: 700, fontSize: 13.5}}>${session.name || session.email}</div>
            <div class="faint" style=${{fontSize: 12}}>${session.email}${session.via ? " · via " + session.via : ""}</div>
          </div>
          <div style=${{padding: 6}}>
            ${[
              { icon: "user", label: "Account settings" },
              { icon: "settings", label: "Preferences" },
              { icon: "key", label: "API keys" },
            ].map((i) => html`
              <button style=${{display: "flex", width: "100%", padding: "8px 10px", background: "transparent", border: "none", textAlign: "left", cursor: "pointer", color: "var(--text)", fontFamily: "inherit", fontSize: 13, alignItems: "center", gap: 10, borderRadius: 6}} onMouseOver=${(e) => e.currentTarget.style.background = "var(--surface-3)"} onMouseOut=${(e) => e.currentTarget.style.background = "transparent"}>
                <${Icon} name=${i.icon} size=${15} />
                <span>${i.label}</span>
              </button>`)}
          </div>
          <div style=${{padding: 6, borderTop: "1px solid var(--border-soft)"}}>
            <button style=${{display: "flex", width: "100%", padding: "8px 10px", background: "transparent", border: "none", textAlign: "left", cursor: "pointer", color: "var(--danger)", fontFamily: "inherit", fontSize: 13, alignItems: "center", gap: 10, borderRadius: 6}} onClick=${() => { setOpen(false); onLogout(); }} onMouseOver=${(e) => e.currentTarget.style.background = "var(--danger-soft)"} onMouseOut=${(e) => e.currentTarget.style.background = "transparent"}>
              <${Icon} name="x" size=${15} />
              <span style=${{fontWeight: 600}}>Log out</span>
            </button>
          </div>
        </div>`}
    </div>`;
};

const Topbar = ({ theme, onToggleTheme, project, session, onLogout }) => html`
  <header class="dda-topbar row between" style=${{display: "flex", alignItems: "center"}}>
    <div class="row gap-3" style=${{alignItems: "center"}}>
      <${Btn} variant="ghost" size="icon"><${Icon} name="menu" size=${18} /><//>
      <div class="row gap-2" style=${{fontSize: 13, color: "var(--text-muted)", alignItems: "center"}}>
        <span>Projects</span><span class="faint">/</span><span style=${{color: "var(--text)", fontWeight: 600}}>${project.name}</span>
        <${Badge} tone="info">${project.cloudLabel}<//>
      </div>
    </div>
    <div style=${{flex: 1, maxWidth: 520, margin: "0 24px"}}>
      <div class="input row gap-2" style=${{cursor: "default", color: "var(--text-faint)", alignItems: "center"}}>
        <${Icon} name="search" size=${16} /><span>Search resources, repos, agents…</span><span style=${{marginLeft: "auto", fontSize: 11, padding: "1px 6px", border: "1px solid var(--border)", borderRadius: 4}}>⌘K</span>
      </div>
    </div>
    <div class="row gap-2">
      <${Btn} size="sm"><${Icon} name="box" size=${14} /> Project workspace <${Icon} name="chevD" size=${12} /><//>
      <${Btn} variant="ghost" size="icon" onClick=${onToggleTheme}><${Icon} name=${theme === "dark" ? "sun" : "moon"} size=${16} /><//>
      <${Btn} variant="ghost" size="icon"><${Icon} name="bell" size=${16} /><//>
      <${UserMenu} session=${session} onLogout=${onLogout} />
    </div>
  </header>`;

// ═════════════════════════════════════════════════════════════════════
// Auth pages — Login / Signup, styled to match the live
// src/components/auth/AuthFrame.tsx + LoginClient.tsx
// ═════════════════════════════════════════════════════════════════════
const AUTH_FEATURES = [
  { icon: "zap", label: "Generate Terraform & K8s from a prompt" },
  { icon: "shield", label: "Agents review every change against requirements" },
  { icon: "approve", label: "Human-in-the-loop approvals on risky steps" },
];

const AuthFrame = ({ children, foot }) => html`
  <div class="auth-frame">
    <aside class="auth-brand">
      <div class="auth-brand-glow"></div>
      <div class="auth-brand-inner">
        <div class="row gap-2" style=${{alignItems: "center"}}>
          <span style=${{width: 34, height: 34, borderRadius: 10, background: "var(--accent)", color: "var(--accent-fg)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 15}}>◐</span>
          <span style=${{fontWeight: 800, fontSize: 17, letterSpacing: "-.01em"}}>DeepAgent</span>
        </div>
        <div class="auth-brand-pitch">
          <h1>Run real infrastructure without the DevOps team.</h1>
          <p class="muted tx-pretty">Connect a repo, describe what you want, and Deep Agent writes the Terraform and Kubernetes, ships it through your environments, and watches it 24/7 — with you approving the moves that matter.</p>
          <div class="col gap-3" style=${{marginTop: 8}}>
            ${AUTH_FEATURES.map((f) => html`
              <div class="row gap-3">
                <span class="auth-feat"><${Icon} name=${f.icon} size=${17} /></span>
                <span style=${{fontSize: 14, fontWeight: 600}}>${f.label}</span>
              </div>`)}
          </div>
        </div>
        <div class="row gap-3 faint auth-brand-foot">
          <span>SOC 2 Type II</span><span>·</span><span>99.95% uptime</span><span>·</span><span>© 2026 DeepAgent</span>
        </div>
      </div>
    </aside>
    <section class="auth-form-wrap">
      <div class="auth-form-col">
        <div class="auth-logo-mobile">
          <span style=${{width: 32, height: 32, borderRadius: 10, background: "var(--accent)", color: "var(--accent-fg)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 14}}>◐</span>
        </div>
        ${children}
        ${foot && html`<div style=${{marginTop: 16}}>${foot}</div>`}
      </div>
    </section>
  </div>`;

const AuthHead = ({ title, sub }) => html`
  <div class="col gap-2">
    <h2 style=${{fontSize: 25, fontWeight: 800, letterSpacing: "-.02em", margin: 0}}>${title}</h2>
    ${sub && html`<p class="muted" style=${{fontSize: 14, margin: 0}}>${sub}</p>`}
  </div>`;

const LoginPage = ({ onLogin, onGoSignup }) => {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(true);
  const [emailError, setEmailError] = useState(null);
  const [pwdError, setPwdError] = useState(null);
  const [serverError, setServerError] = useState(null);
  const [submitting, setSubmitting] = useState(false);

  const submit = (e) => {
    e && e.preventDefault();
    let bad = false;
    if (!email) { setEmailError("Email is required"); bad = true; }
    else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setEmailError("Enter a valid email"); bad = true; }
    else setEmailError(null);
    if (!password) { setPwdError("Password is required"); bad = true; }
    else if (password.length < 8) { setPwdError("At least 8 characters"); bad = true; }
    else setPwdError(null);
    if (bad) return;
    setServerError(null);
    setSubmitting(true);
    // Demo: any valid-shape email + any 8+ char password succeeds.
    setTimeout(() => { setSubmitting(false); onLogin({ email }); }, 400);
  };

  const oauth = (provider) => {
    setSubmitting(true);
    setTimeout(() => { setSubmitting(false); onLogin({ email: "manoi.vv@example.com", via: provider }); }, 500);
  };

  return html`
    <${AuthFrame} foot=${html`
      <p class="muted" style=${{textAlign: "center", fontSize: 13}}>
        New here? <a class="auth-link" onClick=${onGoSignup} style=${{cursor: "pointer"}}>Create an account</a>
      </p>
    `}>
      <${AuthHead} title="Welcome back" sub="Log in to your DeepAgent workspace." />
      <div class="col gap-3" style=${{marginTop: 20}}>
        <a class="btn outline" style=${{display: "flex", justifyContent: "center", gap: 8, cursor: "pointer"}} onClick=${() => oauth("github")}>
          <${Icon} name="github" size=${16} />
          Continue with GitHub
        </a>
        <a class="btn outline" style=${{display: "flex", justifyContent: "center", gap: 8, cursor: "pointer"}} onClick=${() => oauth("google")}>
          <span style=${{width: 16, height: 16, borderRadius: "50%", background: "linear-gradient(135deg, #4285F4 0%, #34A853 50%, #FBBC05 75%, #EA4335 100%)", display: "inline-block"}}></span>
          Continue with Google
        </a>
      </div>
      <div class="auth-divider">
        <div class="divider"></div>
        <span>or</span>
        <div class="divider"></div>
      </div>
      <form class="col gap-4" onSubmit=${submit} noValidate>
        <label class="col gap-1">
          <span class="field-label">Work email</span>
          <input class="input" type="email" placeholder="you@company.com" value=${email} onInput=${(e) => setEmail(e.target.value)} />
          ${emailError && html`<span style=${{fontSize: 11.5, marginTop: 4, color: "var(--danger)"}}>${emailError}</span>`}
        </label>
        <label class="col gap-1">
          <span class="field-label">Password</span>
          <input class="input" type="password" placeholder="••••••••" value=${password} onInput=${(e) => setPassword(e.target.value)} />
          ${pwdError && html`<span style=${{fontSize: 11.5, marginTop: 4, color: "var(--danger)"}}>${pwdError}</span>`}
        </label>
        <div class="row between">
          <label class="row gap-2" style=${{cursor: "pointer", alignItems: "center"}} onClick=${() => setRemember(!remember)}>
            <span style=${{width: 32, height: 18, borderRadius: 999, background: remember ? "var(--accent)" : "var(--surface-3)", padding: 2, transition: "background .15s"}}>
              <span style=${{width: 14, height: 14, borderRadius: "50%", background: "white", display: "block", transform: remember ? "translateX(14px)" : "translateX(0)", transition: "transform .15s"}}></span>
            </span>
            <span style=${{fontSize: 13, fontWeight: 600}}>Remember me</span>
          </label>
          <a class="auth-link" style=${{fontSize: 13, cursor: "pointer"}}>Forgot password?</a>
        </div>
        ${serverError && html`<p style=${{fontSize: 12.5, color: "var(--danger)", margin: 0}}>${serverError}</p>`}
        <button type="submit" class="btn primary lg block" disabled=${submitting}>
          ${submitting ? "Signing in…" : "Log in"} <${Icon} name="chevR" size=${16} />
        </button>
        <p class="faint" style=${{fontSize: 11.5, textAlign: "center", margin: 0}}>
          Demo: any email + any 8-char password works.
        </p>
      </form>
    <//>`;
};

const SignupPage = ({ onLogin, onGoLogin }) => {
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const passwordReqs = [
    { met: password.length >= 8, label: "At least 8 characters" },
    { met: /[A-Z]/.test(password), label: "One uppercase letter" },
    { met: /[0-9]/.test(password), label: "One digit" },
  ];
  const canSubmit = name && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) && passwordReqs.every((r) => r.met);
  const submit = (e) => {
    e && e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setTimeout(() => { setSubmitting(false); onLogin({ email, name }); }, 400);
  };
  return html`
    <${AuthFrame} foot=${html`
      <p class="muted" style=${{textAlign: "center", fontSize: 13}}>
        Already have an account? <a class="auth-link" onClick=${onGoLogin} style=${{cursor: "pointer"}}>Log in</a>
      </p>
    `}>
      <${AuthHead} title="Create your workspace" sub="Sign up to start using DeepAgent." />
      <form class="col gap-4" onSubmit=${submit} style=${{marginTop: 20}}>
        <label class="col gap-1">
          <span class="field-label">Full name</span>
          <input class="input" type="text" placeholder="Jane Doe" value=${name} onInput=${(e) => setName(e.target.value)} />
        </label>
        <label class="col gap-1">
          <span class="field-label">Work email</span>
          <input class="input" type="email" placeholder="you@company.com" value=${email} onInput=${(e) => setEmail(e.target.value)} />
        </label>
        <label class="col gap-1">
          <span class="field-label">Password</span>
          <input class="input" type="password" placeholder="Create a password" value=${password} onInput=${(e) => setPassword(e.target.value)} />
          <ul class="auth-pwd-checklist" style=${{listStyle: "none", padding: 0, margin: "8px 0 0"}}>
            ${passwordReqs.map((r) => html`
              <li class=${"auth-pwd-req" + (r.met ? " met" : "")} style=${{display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: r.met ? "var(--ok)" : "var(--text-muted)", padding: "2px 0"}}>
                <${Icon} name=${r.met ? "check" : "x"} size=${12} />
                <span>${r.label}</span>
              </li>`)}
          </ul>
        </label>
        <button type="submit" class="btn primary lg block" disabled=${!canSubmit || submitting}>
          ${submitting ? "Creating…" : "Create workspace"} <${Icon} name="chevR" size=${16} />
        </button>
        <p class="faint" style=${{fontSize: 11.5, textAlign: "center", margin: 0}}>
          By continuing you agree to the Terms and Privacy Policy.
        </p>
      </form>
    <//>`;
};

const App = () => {
  // Auth: on first mount, user is at the login screen. localStorage keeps
  // them signed in across refreshes so you don't have to re-log-in every
  // time you regenerate the wireframe. Clicking "Log out" in the user
  // dropdown clears the flag and drops you back to the login page.
  const [session, setSession] = useState(() => {
    try {
      const raw = localStorage.getItem("dda-wf-session");
      return raw ? JSON.parse(raw) : null;
    } catch (e) { return null; }
  });
  const [authScreen, setAuthScreen] = useState("login"); // "login" | "signup"
  const login = (user) => {
    setSession(user);
    try { localStorage.setItem("dda-wf-session", JSON.stringify(user)); } catch (e) {}
  };
  const logout = () => {
    setSession(null);
    try { localStorage.removeItem("dda-wf-session"); } catch (e) {}
    location.hash = "";
  };

  const [active, setActive] = useState(() => (location.hash.slice(1) in PAGES ? location.hash.slice(1) : "dashboard"));
  const [theme, setTheme] = useState(() => {
    try { return localStorage.getItem("dda-wf-theme") || "dark"; } catch (e) { return "dark"; }
  });
  const [projectSlug, setProjectSlug] = useState(() => {
    try {
      const s = localStorage.getItem("dda-wf-project");
      return s && s in PROJECTS ? s : "agent-aws";
    } catch (e) { return "agent-aws"; }
  });
  useEffect(() => { document.documentElement.setAttribute("data-theme", theme); try { localStorage.setItem("dda-wf-theme", theme); } catch (e) {} }, [theme]);
  useEffect(() => { try { localStorage.setItem("dda-wf-project", projectSlug); } catch (e) {} }, [projectSlug]);
  useEffect(() => {
    const on = () => { const id = location.hash.slice(1); if (id in PAGES) setActive(id); };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  // Not signed in → show the auth pages instead of the app shell.
  if (!session) {
    return authScreen === "login"
      ? html`<${LoginPage} onLogin=${login} onGoSignup=${() => setAuthScreen("signup")} />`
      : html`<${SignupPage} onLogin=${login} onGoLogin=${() => setAuthScreen("login")} />`;
  }

  const select = (id) => { setActive(id); location.hash = id; };
  const Page = PAGES[active].component;
  const isChat = active === "chat";
  const project = PROJECTS[projectSlug];
  return html`
    <${ProjectContext.Provider} value=${project}>
      <div class="dda-shell" style=${{display: "flex", height: "100vh", overflow: "hidden"}}>
        <${Sidebar} active=${active} onSelect=${select} activeProject=${projectSlug} onSwitchProject=${setProjectSlug} />
        <div class="col grow" style=${{minWidth: 0, minHeight: 0}}>
          <${Topbar} theme=${theme} onToggleTheme=${() => setTheme(theme === "dark" ? "light" : "dark")} project=${project} session=${session} onLogout=${logout} />
          <main class="dda-main grow">
            <div class="dda-page-wrap col gap-5" style=${isChat ? {maxWidth: "none", padding: 0, height: "100%"} : null}>
              <${Page} />
            </div>
          </main>
        </div>
      </div>
    <//>`;
};

render(h(App, null), document.getElementById("root"));
