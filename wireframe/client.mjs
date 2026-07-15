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

// Global toast context — every button in the wireframe uses this to give the
// client demo instant, believable feedback ("Environment created", "Save queued",
// "Deploy started") without needing a real backend. Toasts auto-dismiss.
const ToastContext = createContext(() => {});
const useToast = () => useContext(ToastContext);

// Global approvals queue — shared across projects and pages. The chat wizard's
// "Create cluster" flow adds a pending Terraform-plan approval here; the
// Approvals page reads + approves/rejects. Persists across page nav via the
// context provider mounted in App.
const ApprovalsContext = createContext(null);
const useApprovals = () => useContext(ApprovalsContext);

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
    provider: { id: "p1", kind: "aws", name: "AWS (us-east-1)", env: "prod", region: "us-east-1", services: 3, cost: 512 },
    envs: [
      { key: "prod", name: "prod", tier: "prod", cluster: "eks-prod" },
      { key: "staging", name: "staging", tier: "staging", cluster: "eks-staging" },
      { key: "dev", name: "dev", tier: "dev", cluster: null },
    ],
    activity: [
      { at: "2m ago", action: "eks.terraform_generated", target: "prod/eks-prod", tone: "ok" },
      { at: "18m ago", action: "cloud_provider.credentials_set", target: "aws · prod", tone: "ok" },
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
      { id: "r1", name: "eks-prod-apply", action: "apply", env: "prod", status: "running", elapsed: "8m 22s", stages: [
        { name: "init", status: "succeeded", dur: "38s" },
        { name: "plan", status: "succeeded", dur: "1m 45s" },
        { name: "apply", status: "running", dur: "5m 59s" },
      ]},
      { id: "r2", name: "eks-staging-apply", action: "apply", env: "staging", status: "succeeded", elapsed: "14m 08s", stages: [
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
    provider: { id: "p1", kind: "gcp", name: "GCP (us-central1)", env: "prod", region: "us-central1", services: 2, cost: 267, project: "new-project-495604" },
    envs: [
      { key: "prod", name: "prod", tier: "prod", cluster: "gke-prod" },
      { key: "staging", name: "staging", tier: "staging", cluster: "gke-staging" },
      { key: "dev", name: "dev", tier: "dev", cluster: null },
    ],
    activity: [
      { at: "5m ago", action: "gke.terraform_generated", target: "prod/gke-prod", tone: "ok" },
      { at: "22m ago", action: "azure.tfstate_provisioned", target: "gcs · tfstate-agent-gcp", tone: "ok" },
      { at: "1h ago", action: "chat.message_posted", target: "thread 'Enable GKE APIs'", tone: "info" },
      { at: "2h ago", action: "terraform.run_started", target: "gke-prod-apply", tone: "info" },
      { at: "3h ago", action: "cloud_provider.credentials_set", target: "gcp · prod", tone: "ok" },
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
      { id: "r1", name: "gke-prod-apply", action: "apply", env: "prod", status: "running", elapsed: "12m 04s", stages: [
        { name: "init", status: "succeeded", dur: "42s" },
        { name: "plan", status: "succeeded", dur: "2m 18s" },
        { name: "apply", status: "running", dur: "9m 04s" },
      ]},
      { id: "r2", name: "gke-staging-apply", action: "apply", env: "staging", status: "succeeded", elapsed: "18m 22s", stages: [
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
    provider: { id: "p1", kind: "azure", name: "Azure (eastus)", env: "prod", region: "eastus", services: 3, cost: 482, subscription: "799aab2a-460c-4b3b-bfea-c0d72d1ad6a7" },
    envs: [
      { key: "prod", name: "prod", tier: "prod", cluster: "aks-prod" },
      { key: "staging", name: "staging", tier: "staging", cluster: "aks-staging" },
      { key: "dev", name: "dev", tier: "dev", cluster: null },
    ],
    activity: [
      { at: "2m ago", action: "aks.terraform_generated", target: "prod/aks-prod", tone: "ok" },
      { at: "14m ago", action: "terraform.run_started", target: "aks-prod-apply", tone: "info" },
      { at: "28m ago", action: "azure.tfstate_provisioned", target: "rg-devops/devclusteraccount/tfstate", tone: "ok" },
      { at: "48m ago", action: "cloud_provider.credentials_set", target: "azure · prod", tone: "ok" },
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
      { id: "r1", name: "aks-prod-apply", action: "apply", env: "prod", status: "running", elapsed: "12m 04s", stages: [
        { name: "init", status: "succeeded", dur: "42s" },
        { name: "plan", status: "succeeded", dur: "2m 18s" },
        { name: "apply", status: "running", dur: "9m 04s" },
      ]},
      { id: "r2", name: "aks-staging-apply", action: "apply", env: "staging", status: "succeeded", elapsed: "18m 22s", stages: [
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
    { repo: "manov7723-sys/deepagent", workflow: "deploy-cluster", branch: "prod", status: "running", dur: "12m 04s", actor: "manov" },
    { repo: "acme/app", workflow: "trivy-scan", branch: "main", status: "failed", dur: "42s", actor: "sriram" },
  ],
  alerts: [
    { name: "mem-usage high", target: "worker-abc123 · 92% for 12m", sev: "high", env: "prod" },
    { name: "p95-latency high", target: "app.example.com · 1.2s for 5m", sev: "warn", env: "prod" },
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

const DashboardPage = ({ onNav }) => {
  const proj = useProject();
  const toast = useToast();
  const [deployOpen, setDeployOpen] = useState(false);
  return html`
  <${PageHead} title=${proj.name} sub=${"Production deployment target on " + proj.cloudLabel + " (" + proj.clusterType + ")."} actions=${html`
    <${Btn} variant="primary" icon="◈" onClick=${() => onNav && onNav("chat")}>Open chat<//>
    <${Btn} icon="▲" onClick=${() => setDeployOpen(true)}>Deploy<//>
  `} />
  ${deployOpen && html`<${DeployAppWizard} proj=${proj} onClose=${() => setDeployOpen(false)} onSubmit=${(v) => { setDeployOpen(false); toast("Deploy " + v.repo + ":" + v.tag + " → " + v.env + " (" + v.strategy + " rollout) started"); }} />`}
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
          <li style=${{padding: "10px 0", borderBottom: "1px solid var(--border-soft)", fontSize: 13}}><${Badge} tone="danger">high<//> 1 open alert · <span class="mono">mem-usage</span> on prod</li>
          <li style=${{padding: "10px 0", borderBottom: "1px solid var(--border-soft)", fontSize: 13}}><${Badge} tone="info">pending<//> 2 approvals waiting</li>
          <li style=${{padding: "10px 0", fontSize: 13}}><${Badge} tone="warn">warn<//> State backend not set on <span class="mono">dev</span></li>
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

// ═════════════════════════════════════════════════════════════════════
// Chat wizards — the "Deploy my app" and "Create cluster" quick actions
// on the chat page mirror the guided flows the real agent runs when the
// user types "deploy" or "create cluster". Each wizard is 2-3 fields, a
// summary preview, and a Submit that: shows a toast, appends the wizard's
// summary + agent reply to the current chat, and (for cluster creation)
// queues a Terraform-plan approval visible on the Approvals page.
// ═════════════════════════════════════════════════════════════════════

const DEPLOY_METHOD_META = {
  manifests: {
    label: "Raw manifests",
    icon: "⌘",
    desc: "Agent generates Deployment + Service + Ingress YAMLs, applies with kubectl.",
    filesLabel: "kubectl apply preview",
  },
  helm: {
    label: "Helm chart",
    icon: "⎈",
    desc: "Agent generates a full Helm chart (Chart.yaml + templates + per-env values files) and runs helm upgrade --install.",
    filesLabel: "Chart preview",
  },
  kustomize: {
    label: "Kustomize",
    icon: "⌸",
    desc: "Agent generates a base + per-env overlays, applies with kubectl apply -k.",
    filesLabel: "Kustomize tree",
  },
};

const DeployAppWizard = ({ proj, onClose, onSubmit }) => {
  const [repo, setRepo] = useState((proj.repos && proj.repos[0]) || "manov7723-sys/deepagent");
  const [env, setEnv] = useState(proj.envs[0]?.key || "prod");
  const [tag, setTag] = useState("latest");
  const [strategy, setStrategy] = useState("rolling");
  const [method, setMethod] = useState("manifests");
  // Helm-specific fields (only shown when method === "helm").
  const appName = repo.split("/")[1] || repo;
  const [chartPath, setChartPath] = useState("helm/" + appName + "/");
  const [releaseName, setReleaseName] = useState(appName + "-" + env);
  const [kustomizeOverlay, setKustomizeOverlay] = useState("overlays/" + env);
  // Sync release name when env or repo changes.
  useEffect(() => { setReleaseName((repo.split("/")[1] || repo) + "-" + env); setChartPath("helm/" + (repo.split("/")[1] || repo) + "/"); setKustomizeOverlay("overlays/" + env); }, [repo, env]);
  const meta = DEPLOY_METHOD_META[method];
  return html`
    <${ModalFrame} onClose=${onClose} width=${580}>
      <div class="row between" style=${{marginBottom: 6}}>
        <div class="row gap-3" style=${{alignItems: "center"}}>
          <span style=${{width: 34, height: 34, borderRadius: 9, background: "var(--accent-soft)", color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center"}}>▲</span>
          <h2 style=${{fontSize: 18, margin: 0}}>Deploy my app<//>
        </div>
        <${Btn} variant="ghost" size="icon" onClick=${onClose}>✕<//>
      </div>
      <p class="muted" style=${{fontSize: 12.5, margin: "0 0 20px", lineHeight: 1.5}}>The agent will build the image from your repo, push it to the registry, and roll it out on <b>${proj.clusterName}</b>.</p>
      <div class="col gap-3">
        <${Field} label="Repository" required>
          <${Select} value=${repo} onChange=${setRepo} options=${(proj.repos && proj.repos.length ? proj.repos : ["manov7723-sys/deepagent", "manov7723-sys/marketing-site", "manov7723-sys/api"])} />
        <//>
        <${Field} label="Target environment" required>
          <${Select} value=${env} onChange=${setEnv} options=${proj.envs.map((e) => e.key)} />
        <//>
        <${Field} label="Image tag" hint="Git SHA or 'latest'. The agent commits changes directly to the default branch.">
          <${Input} value=${tag} onInput=${(e) => setTag(e.target.value)} placeholder="latest" />
        <//>

        <${Field} label="Deployment method" hint=${meta.desc}>
          <div class="row gap-2 wrap">
            ${Object.entries(DEPLOY_METHOD_META).map(([k, m]) => html`
              <button key=${k} class=${"chip " + (method === k ? "active" : "")} style=${{height: 40, padding: "0 14px", display: "flex", gap: 6, alignItems: "center"}} onClick=${() => setMethod(k)}>
                <span style=${{fontSize: 14}}>${m.icon}</span>
                <span>${m.label}</span>
              </button>`)}
          </div>
        <//>

        ${method === "helm" && html`
          <div style=${{padding: 12, background: "var(--accent-soft)", border: "1px solid var(--accent-line, var(--border))", borderRadius: 10}}>
            <div class="col gap-3">
              <div class="row gap-2" style=${{alignItems: "center", fontSize: 12}}>
                <${Icon} name="box" size=${14} />
                <b>Helm settings</b>
              </div>
              <${Field} label="Chart path (in repo)" hint="If it doesn't exist yet, the agent generates a chart here on first deploy.">
                <${Input} value=${chartPath} onInput=${(e) => setChartPath(e.target.value)} placeholder="helm/myapp/" />
              <//>
              <${Field} label="Release name" hint="Passed to helm upgrade --install. Convention: <app>-<env>.">
                <${Input} value=${releaseName} onInput=${(e) => setReleaseName(e.target.value)} />
              <//>
              <div style=${{fontSize: 12, color: "var(--text-muted)", lineHeight: 1.5}}>
                Per-env values: <span class="mono">values.yaml</span> (base) + <span class="mono">values-${env}.yaml</span> (override). The agent merges them.
              </div>
            </div>
          </div>`}

        ${method === "kustomize" && html`
          <div style=${{padding: 12, background: "var(--accent-soft)", border: "1px solid var(--accent-line, var(--border))", borderRadius: 10}}>
            <${Field} label="Overlay path (in repo)" hint="Kustomize base lives in kustomize/base/. This env's overlay is applied on top.">
              <${Input} value=${kustomizeOverlay} onInput=${(e) => setKustomizeOverlay(e.target.value)} placeholder="overlays/production" />
            <//>
          </div>`}

        <${Field} label="Rollout strategy">
          <div class="row gap-2 wrap">
            ${["rolling", "canary", "blue-green"].map((s) => html`<${Chip} active=${strategy === s} onClick=${() => setStrategy(s)}>${s}<//>`)}
          </div>
        <//>

        <div style=${{padding: 12, background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 10, fontSize: 12.5}}>
          <b style=${{fontSize: 12}}>${meta.filesLabel}</b>
          <div class="mono" style=${{marginTop: 6, lineHeight: 1.6, color: "var(--text-muted)", fontSize: 11.5}}>
            ${method === "manifests" && html`
              <div>+ k8s/<span style=${{color: "var(--accent)"}}>${env}</span>/deployment.yaml</div>
              <div>+ k8s/<span style=${{color: "var(--accent)"}}>${env}</span>/service.yaml</div>
              <div>+ k8s/<span style=${{color: "var(--accent)"}}>${env}</span>/ingress.yaml</div>
              <div style=${{marginTop: 6, color: "var(--text-faint)"}}>→ kubectl apply -f k8s/${env}/</div>`}
            ${method === "helm" && html`
              <div>+ <span class="mono">${chartPath}</span>Chart.yaml</div>
              <div>+ <span class="mono">${chartPath}</span>values.yaml <span class="faint">(base)</span></div>
              <div>+ <span class="mono">${chartPath}</span>values-<span style=${{color: "var(--accent)"}}>${env}</span>.yaml <span class="faint">(override)</span></div>
              <div>+ <span class="mono">${chartPath}</span>templates/deployment.yaml</div>
              <div>+ <span class="mono">${chartPath}</span>templates/service.yaml</div>
              <div>+ <span class="mono">${chartPath}</span>templates/ingress.yaml</div>
              <div>+ <span class="mono">${chartPath}</span>templates/_helpers.tpl</div>
              <div style=${{marginTop: 6, color: "var(--text-faint)"}}>→ helm upgrade --install <span style=${{color: "var(--accent)"}}>${releaseName}</span> ${chartPath} -f values.yaml -f values-${env}.yaml --set image.tag=${tag}</div>`}
            ${method === "kustomize" && html`
              <div>+ kustomize/base/deployment.yaml</div>
              <div>+ kustomize/base/service.yaml</div>
              <div>+ kustomize/base/kustomization.yaml</div>
              <div>+ kustomize/<span style=${{color: "var(--accent)"}}>${kustomizeOverlay}</span>/kustomization.yaml</div>
              <div>+ kustomize/<span style=${{color: "var(--accent)"}}>${kustomizeOverlay}</span>/patch-image.yaml</div>
              <div style=${{marginTop: 6, color: "var(--text-faint)"}}>→ kubectl apply -k kustomize/${kustomizeOverlay}</div>`}
          </div>
        </div>

        ${env === "prod" && html`
          <div style=${{padding: "10px 12px", background: "var(--warn-soft)", color: "var(--warn)", borderRadius: 8, fontSize: 12.5, display: "flex", gap: 8, alignItems: "flex-start"}}>
            <span>⚠</span><span>Release deploys require approval. The agent will queue this for the on-call reviewer.</span>
          </div>`}

        <div class="row gap-2" style=${{justifyContent: "flex-end", marginTop: 4}}>
          <${Btn} variant="ghost" onClick=${onClose}>Cancel<//>
          <${Btn} variant="primary" icon="▲" onClick=${() => onSubmit({ repo, env, tag, strategy, method, chartPath, releaseName, kustomizeOverlay })}>Deploy via ${meta.label}<//>
        </div>
      </div>
    <//>`;
};

const CreateClusterWizard = ({ proj, onClose, onSubmit }) => {
  const [name, setName] = useState(proj.clusterName + "-new");
  const [region, setRegion] = useState(proj.region);
  const [version, setVersion] = useState(proj.clusterVersion || "1.36");
  const [nodes, setNodes] = useState(3);
  const [vmSize, setVmSize] = useState(proj.cloud === "aws" ? "t3.medium" : proj.cloud === "azure" ? "Standard_D2s_v3" : "e2-standard-2");
  return html`
    <div style=${{position: "fixed", inset: 0, background: "var(--overlay)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20}} onClick=${onClose}>
      <div style=${{background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, boxShadow: "var(--shadow-lg)", maxWidth: 560, width: "100%", padding: 24}} onClick=${(e) => e.stopPropagation()}>
        <div class="row between" style=${{marginBottom: 6}}>
          <div class="row gap-3" style=${{alignItems: "center"}}>
            <span style=${{width: 34, height: 34, borderRadius: 9, background: "var(--info-soft, #14355a)", color: "var(--info, #60a5fa)", display: "flex", alignItems: "center", justifyContent: "center"}}>⛁</span>
            <h2 style=${{fontSize: 18, margin: 0}}>Create ${proj.clusterType} cluster</h2>
          </div>
          <${Btn} variant="ghost" size="icon" onClick=${onClose}>✕<//>
        </div>
        <p class="muted" style=${{fontSize: 12.5, margin: "0 0 20px", lineHeight: 1.5}}>Generates the Terraform module, commits it directly to your repo's default branch, and queues a plan for approval. Nothing is created in ${proj.cloudLabel} until an approver clicks Approve.</p>
        <div class="col gap-3">
          <${Field} label="Cluster name" required><${Input} value=${name} onInput=${(e) => setName(e.target.value)} /><//>
          <div class="row gap-2 wrap">
            <div style=${{flex: 1, minWidth: 200}}><${Field} label="Region"><${Input} value=${region} onInput=${(e) => setRegion(e.target.value)} /><//></div>
            <div style=${{flex: 1, minWidth: 160}}><${Field} label="Kubernetes"><${Select} value=${version} onChange=${setVersion} options=${["1.36","1.35","1.34","1.33","1.32","1.31"]} /><//></div>
          </div>
          <div class="row gap-2 wrap">
            <div style=${{flex: 1, minWidth: 160}}><${Field} label="Node count"><${Input} value=${String(nodes)} onInput=${(e) => setNodes(Number(e.target.value) || 1)} /><//></div>
            <div style=${{flex: 1, minWidth: 200}}><${Field} label="VM size"><${Input} value=${vmSize} onInput=${(e) => setVmSize(e.target.value)} /><//></div>
          </div>
          <div style=${{padding: 12, background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 10, fontSize: 12.5}}>
            <b style=${{fontSize: 12}}>Terraform plan preview</b>
            <div class="muted mono" style=${{marginTop: 6, lineHeight: 1.5, fontSize: 12}}>
              + azurerm_resource_group.rg (or equivalent)<br/>
              + ${proj.cloud === "aws" ? "aws_eks_cluster" : proj.cloud === "azure" ? "azurerm_kubernetes_cluster" : "google_container_cluster"}.<span style=${{color: "var(--accent)"}}>${name}</span><br/>
              + node_pool: ${nodes} × ${vmSize} in ${region}<br/>
              <b style=${{color: "var(--ok, #22c55e)"}}>Plan: 3 to add, 0 to change, 0 to destroy.</b>
            </div>
          </div>
          <div class="row gap-2" style=${{justifyContent: "flex-end", marginTop: 4}}>
            <${Btn} variant="ghost" onClick=${onClose}>Cancel<//>
            <${Btn} variant="primary" icon="⛁" onClick=${() => onSubmit({ name, region, version, nodes, vmSize })}>Generate plan &amp; request approval<//>
          </div>
        </div>
      </div>
    </div>`;
};

const ChatPage = () => {
  const proj = useProject();
  const toast = useToast();
  const approvals = useApprovals();
  const [messages, setMessages] = useState(proj.chatSeed);
  const [text, setText] = useState("");
  const [railOpen, setRailOpen] = useState(true);
  const [activeChat, setActiveChat] = useState("c1");
  const [wizard, setWizard] = useState(null); // "deploy" | "cluster" | null
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

  // Wizard submit handlers — each appends the user's summary + a canned agent
  // reply to the current chat, so the demo shows real flow, not just a toast.
  const onDeploySubmit = (v) => {
    setWizard(null);
    const methodTail = v.method === "helm"
      ? " via Helm chart (" + v.releaseName + ")"
      : v.method === "kustomize"
        ? " via Kustomize overlay (" + v.kustomizeOverlay + ")"
        : " via raw manifests";
    const userMsg = "Deploy " + v.repo + ":" + v.tag + " → " + v.env + " (" + v.strategy + " rollout)" + methodTail;
    const helmSteps = v.method === "helm"
      ? "Generating " + v.chartPath + "Chart.yaml + values.yaml + values-" + v.env + ".yaml + templates/. Running `helm upgrade --install " + v.releaseName + " " + v.chartPath + " -f values.yaml -f values-" + v.env + ".yaml --set image.tag=" + v.tag + "`. "
      : v.method === "kustomize"
        ? "Generating base + overlays/" + v.env + " + kustomization.yaml. Running `kubectl apply -k kustomize/" + v.kustomizeOverlay + "`. "
        : "Generating k8s/" + v.env + "/deployment.yaml + service.yaml + ingress.yaml. Running `kubectl apply -f k8s/" + v.env + "/`. ";
    const agentReply = v.env === "prod"
      ? helmSteps + "Because " + v.env + " is production, I've queued this deploy on the Approvals page — your on-call reviewer will get pinged."
      : helmSteps + "Rolling out on " + proj.clusterName + " (" + v.env + "). ETA ~2 minutes. I'll ping you here when the pods report ready.";
    setMessages((prev) => [...prev, { role: "user", text: userMsg }]);
    setTimeout(() => setMessages((prev) => [...prev, { role: "agent", text: agentReply }]), 500);
    toast(v.env === "prod" ? "Deploy (" + v.method + ") queued for approval" : "Deploy started via " + v.method);
    if (v.env === "prod") {
      approvals && approvals.add({
        kind: "deploy",
        title: "Deploy " + v.repo + ":" + v.tag + " to prod (" + v.method + ")",
        project: proj.slug,
        projectName: proj.name,
        submittedBy: "manoi",
        plan: { adds: v.method === "helm" ? 7 : 3, changes: 1, destroys: 0 },
        detail: v,
      });
    }
  };
  const onClusterSubmit = (v) => {
    setWizard(null);
    const userMsg = "Create " + proj.clusterType + " cluster '" + v.name + "' in " + v.region + " · " + v.nodes + "×" + v.vmSize + " · k8s " + v.version;
    const agentReply = "Generated Terraform for the " + proj.clusterType + " cluster (RG + cluster + node pool). Plan: 3 to add, 0 to change. Because this creates real infra, I've queued the plan on the Approvals page — nothing runs in " + proj.cloudLabel + " until you approve it.";
    setMessages((prev) => [...prev, { role: "user", text: userMsg }]);
    setTimeout(() => setMessages((prev) => [...prev, { role: "agent", text: agentReply }]), 500);
    toast("Cluster plan queued for approval");
    approvals && approvals.add({
      kind: "cluster-create",
      title: "Create " + proj.clusterType + " cluster " + v.name,
      project: proj.slug,
      projectName: proj.name,
      submittedBy: "manoi",
      plan: { adds: 3, changes: 0, destroys: 0 },
      detail: { ...v, cloud: proj.cloud, cloudLabel: proj.cloudLabel, clusterType: proj.clusterType },
    });
  };

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
            <div class="row gap-2" style=${{marginBottom: 10, justifyContent: "center", flexWrap: "wrap"}}>
              <button onClick=${() => setWizard("deploy")} style=${{display: "flex", gap: 8, alignItems: "center", padding: "8px 14px", borderRadius: 999, border: "1px solid var(--accent-line, var(--border))", background: "var(--accent-soft)", color: "var(--accent)", fontFamily: "inherit", fontSize: 12.5, fontWeight: 600, cursor: "pointer"}}>
                <span style=${{fontSize: 14}}>▲</span>
                <span>Deploy my app</span>
              </button>
              <button onClick=${() => setWizard("cluster")} style=${{display: "flex", gap: 8, alignItems: "center", padding: "8px 14px", borderRadius: 999, border: "1px solid var(--border)", background: "var(--surface-2)", color: "var(--text)", fontFamily: "inherit", fontSize: 12.5, fontWeight: 600, cursor: "pointer"}}>
                <span style=${{fontSize: 14}}>⛁</span>
                <span>Create ${proj.clusterType} cluster</span>
              </button>
              <button onClick=${() => { setText("Show cost breakdown for the last 30 days across all envs"); }} style=${{display: "flex", gap: 8, alignItems: "center", padding: "8px 14px", borderRadius: 999, border: "1px solid var(--border)", background: "var(--surface-2)", color: "var(--text-muted)", fontFamily: "inherit", fontSize: 12.5, cursor: "pointer"}}>
                <span style=${{fontSize: 14}}>$</span>
                <span>Cost breakdown</span>
              </button>
            </div>
            <div style=${{padding: 12, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 18, boxShadow: "var(--shadow-sm)"}}>
              <textarea class="textarea" style=${{border: "none", background: "transparent", outline: "none", width: "100%", fontSize: 15, minHeight: 24, maxHeight: 200, resize: "none", padding: "4px 6px", color: "var(--text)", fontFamily: "inherit"}} placeholder="Describe what you want to build or change…" value=${text} onInput=${(e) => setText(e.target.value)} onKeyDown=${(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } }} />
              <div class="row between" style=${{alignItems: "center", marginTop: 8}}>
                <div class="row gap-2"><${Btn} variant="ghost" size="icon" icon="+" /><${Btn} variant="ghost" size="sm" icon="▤">infra<//></div>
                <${Btn} variant="primary" size="icon" onClick=${send} disabled=${!text.trim()}>▸<//>
              </div>
            </div>
            <p class="faint" style=${{fontSize: 11, textAlign: "center", marginTop: 8}}>Deep Agent can read and write to your repos. Changes require approval before they touch prod.</p>
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
    </div>
    ${wizard === "deploy" && html`<${DeployAppWizard} proj=${proj} onClose=${() => setWizard(null)} onSubmit=${onDeploySubmit} />`}
    ${wizard === "cluster" && html`<${CreateClusterWizard} proj=${proj} onClose=${() => setWizard(null)} onSubmit=${onClusterSubmit} />`}
  `;
};

const CloudPage = () => {
  const proj = useProject();
  const toast = useToast();
  const [envFilter, setEnvFilter] = useState("all");
  const [connectOpen, setConnectOpen] = useState(false);
  const [disconnecting, setDisconnecting] = useState(null);
  const [disconnected, setDisconnected] = useState(new Set());
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
          <div class="row gap-2" style=${{marginTop: 14}}><${Btn} icon="▤" onClick=${() => toast("Opened stats for " + p.name)}>View stats<//><${Btn} variant="ghost" size="icon" onClick=${() => toast("Provider settings opened")}>⚙<//><${Btn} variant="ghost" size="icon" onClick=${() => setDisconnecting(p)}>🗑<//></div>
        <//>`)}
    <//>
    ${proj.cloud === "aws" && html`
      <${Card} title="Vault configuration" sub="Store AWS access key + secret in Vault so the agent reads them at runtime.">
        <div style=${{maxWidth: 520}}>
          <div class="row between" style=${{marginBottom: 14}}><span style=${{fontWeight: 600, fontSize: 13}}>Connection</span><${Badge} tone="warn">not connected<//></div>
          <div class="col gap-3">
            <${Field} label="Vault URL" required><${Input} placeholder="https://127.0.0.1:8200" /><//>
            <${Field} label="Vault token" required hint="Token with read/write on the KV mount (hvs.…)"><${Input} placeholder="hvs.•••••••••••" /><//>
            <div class="row gap-2"><${Btn} variant="primary" icon="🔗" onClick=${() => toast("Vault connection saved and verified")}>Save & test<//></div>
          </div>
        </div>
      <//>`}
    ${proj.cloud === "azure" && html`
      <${Card} title="Azure context" sub=${"Subscription: " + proj.provider.subscription}>
        <div style=${{maxWidth: 520}} class="col gap-3">
          <${Field} label="Subscription"><${Select} value=${proj.provider.subscription} onChange=${() => {}} options=${[proj.provider.subscription]} /><//>
          <${Field} label="Resource group"><${Select} value="rg-devops" onChange=${() => {}} options=${["rg-devops"]} /><//>
          <${Field} label="Region"><${Select} value=${proj.region} onChange=${() => {}} options=${[proj.region]} /><//>
          <div class="row gap-2"><${Btn} variant="primary" icon="✓" onClick=${() => toast("Context saved")}>Save context<//></div>
        </div>
      <//>`}
    ${proj.cloud === "gcp" && html`
      <${Card} title="GCP context" sub=${"Project: " + proj.provider.project}>
        <div style=${{maxWidth: 520}} class="col gap-3">
          <${Field} label="GCP project"><${Select} value=${proj.provider.project} onChange=${() => {}} options=${[proj.provider.project]} /><//>
          <${Field} label="Region"><${Select} value=${proj.region} onChange=${() => {}} options=${[proj.region]} /><//>
          <${Field} label="Service account"><${Input} value="dda-runtime@new-project-495604.iam.gserviceaccount.com" readonly=${true} /><//>
          <div class="row gap-2"><${Btn} variant="primary" icon="✓" onClick=${() => toast("Context saved")}>Save context<//></div>
        </div>
      <//>`}
    ${connectOpen && html`<${ConnectCloudModal} lockedCloud=${proj.cloud} onClose=${() => setConnectOpen(false)} onConnected=${(v) => toast("Provider connected · attached to " + v.env + " · agent is now managing " + v.cloud.toUpperCase() + " for this project")} />`}
    ${disconnecting && html`<${ConfirmModal} title=${"Disconnect " + disconnecting.name + "?"} description=${"Removes the cloud provider from this project. Environments bound to it will lose their target — deploys and Terraform runs will fail until a new provider is connected. Nothing is deleted in " + proj.cloudLabel + " itself."} confirmLabel="Disconnect" onClose=${() => setDisconnecting(null)} onConfirm=${() => { setDisconnected((s) => new Set([...s, disconnecting.name])); toast(disconnecting.name + " disconnected — envs are now unbound", "warn"); }} />`}
  `;
};

const ConnectCloudModal = ({ onClose, lockedCloud, onConnected }) => {
  const toast = useToast();
  const [step, setStep] = useState(1);
  const [cloud, setCloud] = useState(lockedCloud || "azure");
  const [envKey, setEnvKey] = useState("prod");
  const [signingIn, setSigningIn] = useState(false);
  const cloudMeta = {
    aws:   { name: "AWS",   detail: "IAM role · STS AssumeRole",     next: "Continues to AWS Console for role trust setup + verification.", provision: "IAM role wired, STS ExternalId issued" },
    azure: { name: "Azure", detail: "Service Principal · Entra ID",  next: "Opens Microsoft sign-in. Grants Contributor + Storage Blob Data Contributor on the subscription.", provision: "Service Principal created + roles granted in centralus" },
    gcp:   { name: "GCP",   detail: "Workload Identity Federation",  next: "Opens Google sign-in. Grants project.editor on the picked GCP project.", provision: "Service account impersonation configured" },
  };
  const meta = cloudMeta[cloud];
  const doSignIn = () => {
    setSigningIn(true);
    toast("Opening " + meta.name + " sign-in in a popup…");
    setTimeout(() => setStep(3), 900);
    setTimeout(() => {
      setSigningIn(false);
      toast(meta.name + " connected — " + meta.provision);
      onConnected && onConnected({ cloud, env: envKey });
      onClose();
    }, 3500);
  };
  return html`
    <${ModalFrame} onClose=${onClose} width=${580}>
      <div class="row between" style=${{marginBottom: 20}}>
        <h2 style=${{fontSize: 18, margin: 0}}>Connect cloud provider · Step ${step} of 3</h2>
        <${Btn} variant="ghost" size="icon" onClick=${onClose}>✕<//>
      </div>
      <div class="row gap-2" style=${{marginBottom: 20}}>
        ${[1, 2, 3].map((s) => html`<div style=${{flex: 1, height: 3, borderRadius: 999, background: step >= s ? "var(--accent)" : "var(--surface-3)"}}></div>`)}
      </div>
      ${step === 1 ? html`
        <div class="col gap-4">
          <${Field} label="Pick a cloud" hint=${lockedCloud ? "This project is locked to " + cloudMeta[lockedCloud].name + "." : "Each project targets a single cloud — locked at creation."}>
            <div class="row gap-2 wrap">
              ${[{k: "aws", n: "AWS"}, {k: "azure", n: "Azure"}, {k: "gcp", n: "GCP"}].map((c) => html`
                <button class=${"chip " + (cloud === c.k ? "active" : "")} style=${{height: 44, padding: "0 16px"}} disabled=${lockedCloud && lockedCloud !== c.k} onClick=${() => !lockedCloud && setCloud(c.k)}>☁ ${c.n}<//>`)}
            </div>
          <//>
          <${Field} label="Environment to attach to" hint="This env gets bound to the connected provider. Terraform runs + deploys for this env authenticate through it.">
            <${Select} value=${envKey} onChange=${setEnvKey} options=${["prod", "staging", "dev"]} />
          <//>
          <div style=${{padding: 12, background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 10, fontSize: 12.5}}>
            <b>${meta.name}</b> · ${meta.detail}<br/>
            <span class="muted">${meta.next}</span>
          </div>
          <div class="row gap-2" style=${{justifyContent: "flex-end", marginTop: 8}}>
            <${Btn} variant="ghost" onClick=${onClose}>Cancel<//>
            <${Btn} variant="primary" onClick=${() => setStep(2)}>Continue →<//>
          </div>
        </div>` : step === 2 ? html`
        <div class="col gap-4">
          <p class="muted" style=${{fontSize: 13, lineHeight: 1.6}}>Click below to open the <b>${meta.name}</b> sign-in popup. After you approve, the agent will auto-provision a Service Principal / role and grant it the least-privilege it needs to run Terraform + deploy pods. Nothing is created in ${meta.name} without your consent.</p>
          <div style=${{padding: 14, background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 10}}>
            <div class="faint" style=${{fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6}}>What the agent will do</div>
            <ul style=${{margin: 0, paddingLeft: 20, fontSize: 12.5, lineHeight: 1.7}}>
              <li>Complete OAuth sign-in with ${meta.name}</li>
              <li>Create a Service Principal in your tenant</li>
              <li>Grant Contributor + Storage Blob Data Contributor on the subscription</li>
              <li>Store the SP credentials encrypted (AES-256-GCM)</li>
              <li>Attach the provider to the <b>${envKey}</b> environment</li>
            </ul>
          </div>
          <${Btn} variant="primary" block icon="☁" loading=${signingIn} onClick=${doSignIn}>${signingIn ? "Signing in…" : "Sign in with " + meta.name}<//>
          <div class="row gap-2" style=${{justifyContent: "flex-end"}}>
            <${Btn} variant="ghost" onClick=${() => setStep(1)}>← Back<//>
          </div>
        </div>` : html`
        <div class="col gap-3" style=${{alignItems: "center", padding: "20px 0"}}>
          <div style=${{width: 56, height: 56, borderRadius: "50%", background: "var(--accent-soft)", color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center"}}>
            <div style=${{width: 24, height: 24, borderRadius: "50%", border: "3px solid var(--accent)", borderTopColor: "transparent", animation: "dda-spin 0.8s linear infinite"}}></div>
          </div>
          <b style=${{fontSize: 15}}>Provisioning ${meta.name} identity…</b>
          <span class="muted" style=${{fontSize: 12.5, textAlign: "center", maxWidth: 320, lineHeight: 1.5}}>Creating Service Principal, granting Contributor + Storage Blob Data Contributor, and attaching to <b>${envKey}</b>. Takes ~5 seconds.</span>
          <style>@keyframes dda-spin { to { transform: rotate(360deg); } }</style>
        </div>`}
    <//>`;
};

const InfraPage = () => {
  const proj = useProject();
  const toast = useToast();
  const [pipelineEnv, setPipelineEnv] = useState("prod");
  const [addCredsOpen, setAddCredsOpen] = useState(false);
  // Local override so Rerun can actually flip a pipeline row's status live.
  const [runOverrides, setRunOverrides] = useState({});
  const runs = proj.pipeline.filter((r) => r.env === pipelineEnv).map((r) => runOverrides[r.name] ? {...r, ...runOverrides[r.name]} : r);
  const sb = proj.stateBackend;
  return html`
    <${PageHead} title="Infrastructure" sub=${"Cloud credentials, Terraform state, and " + proj.clusterType + " cluster provisioning."} />
    <${Card} title="Cloud credentials" sub="Provider used to authenticate Terraform runs">
      <div class="row gap-2 wrap"><${Badge} tone="ok">${proj.cloudLabel} · prod<//><${Btn} icon="+" onClick=${() => setAddCredsOpen(true)}>Add credentials<//></div>
    <//>
    <${Card} title="Terraform state backend" sub=${"Uses " + proj.cloudLabel + " " + sb.label + " for this project."} maxWidth=${560}>
      <div class="col gap-3">
        <${Field} label="Environment"><${Select} value="prod" onChange=${() => {}} options=${proj.envs.map((e) => e.key)} /><//>
        ${sb.kind === "s3" && html`
          <${Field} label="S3 bucket"><${Input} value=${sb.bucket} /><//>
          <${Field} label="Region"><${Input} value=${sb.region} /><//>
          <${Field} label="DynamoDB lock table (optional)"><${Input} value=${sb.table} /><//>
          <div class="row gap-2"><${Btn} variant="primary" icon="✓" onClick=${() => toast("State backend saved")}>Save<//></div>`}
        ${sb.kind === "gcs" && html`
          <${Field} label="GCS bucket" hint="GCS uses object generations for locking — no separate lock table."><${Input} value=${sb.bucket} /><//>
          <div class="row gap-2"><${Btn} variant="primary" icon="✓" onClick=${() => toast("State backend saved")}>Save<//></div>`}
        ${sb.kind === "azurerm" && html`
          <${Field} label="Resource group"><${Input} value=${sb.resourceGroup} /><//>
          <${Field} label="Storage account" hint="Globally unique, 3-24 lowercase letters/digits."><${Input} value=${sb.storageAccount} /><//>
          <${Field} label="Blob container"><${Input} value=${sb.container} /><//>
          <div class="row gap-2"><${Btn} variant="primary" icon="✓" onClick=${() => toast("State backend saved")}>Save<//><${Btn} icon="☁" onClick=${() => toast("Provisioning RG + storage + container in Azure…")}>Provision in Azure<//></div>`}
      </div>
    <//>
    <${Card} title=${"Create " + proj.clusterType + " cluster"} sub=${"Interactive wizard for " + proj.cloudLabel} maxWidth=${560}>
      <div class="col gap-3">
        <${Field} label="Cluster name"><${Input} value=${proj.clusterName + "-new"} /><//>
        <${Field} label="Region"><${Input} value=${proj.region} /><//>
        <${Field} label="Kubernetes version"><${Select} value=${proj.clusterVersion} onChange=${() => {}} options=${["1.36","1.35","1.34","1.33","1.32","1.31","1.30"]} /><//>
        <${Field} label="Node count"><${Input} value=${String(proj.clusterNodes)} /><//>
        <div class="row gap-2"><${Btn} variant="primary" icon="⚡" onClick=${() => toast("Cluster wizard: pushed to repo and Terraform apply started")}>Push & apply<//><${Btn} onClick=${() => toast("Cluster manifest pushed to repo")}>Push only<//><${Btn} onClick=${() => toast("Terraform apply started")}>Apply only<//></div>
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
                <${Btn} size="sm" icon="↻" disabled=${r.status === "running"} onClick=${() => {
                  setRunOverrides((o) => ({...o, [r.name]: {status: "running", elapsed: "0s"}}));
                  toast("Rerunning " + r.name + "…");
                  setTimeout(() => {
                    setRunOverrides((o) => ({...o, [r.name]: {status: "succeeded", elapsed: "2m 14s"}}));
                    toast(r.name + " succeeded", "ok");
                  }, 2400);
                }}>Rerun<//>
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
    <//>
    ${addCredsOpen && html`<${AddCredentialsModal} proj=${proj} onClose=${() => setAddCredsOpen(false)} onAdd=${(v) => toast("Credentials encrypted (" + v.size + " bytes) and stored for env " + v.env)} />`}
  `;
};

const EnvironmentsPage = () => {
  const proj = useProject();
  const toast = useToast();
  const [active, setActive] = useState("prod");
  const [extraEnvs, setExtraEnvs] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const sb = proj.stateBackend;
  const sbLabel = sb.kind === "s3" ? sb.kind + " · " + sb.bucket
    : sb.kind === "gcs" ? sb.kind + " · " + sb.bucket
    : sb.kind + " · " + sb.resourceGroup + "/" + sb.storageAccount;
  const allEnvs = [...proj.envs, ...extraEnvs];
  return html`
    <${PageHead} title="Environments" sub=${"Deploy targets on " + proj.cloudLabel + ". Each env owns its own cluster + remote-state config."} actions=${html`<${Btn} variant="primary" icon="+" onClick=${() => setModalOpen(true)}>New environment<//>`} />
    <${Card} title="Active environment" sub="The env used by env-scoped pages by default.">
      <div class="row gap-2 wrap">
        ${allEnvs.map((e) => html`
          <button class="dda-env-tile" data-active=${active === e.key} onClick=${() => setActive(e.key)}>
            <div style=${{fontWeight: 700}}>${e.name}</div><div class="muted" style=${{fontSize: 11}}>${e.tier}</div>
          </button>`)}
      </div>
    <//>
    <${Card} title="All environments" sub=${allEnvs.length + " environments · " + allEnvs.filter((e) => e.cluster).length + " with cluster attached"}>
      <${Table} headers=${["Env", "Cloud", "Cluster", "State backend", "Members"]} rows=${allEnvs.map((e) => [
        html`<b>${e.name}</b> <${Badge} tone=${(e.tier === "production" || e.tier === "prod") ? "danger" : e.tier === "staging" ? "warn" : "info"}>${e.tier}<//>`,
        html`<${Badge} tone="info">${proj.cloud}<//>`,
        e.cluster ? html`<span class="mono">${e.cluster}</span>` : html`<span class="muted">—</span>`,
        html`<span class="mono faint">${sbLabel}</span>`,
        String((e.tier === "production" || e.tier === "prod") ? 5 : 3),
      ])} />
    <//>
    ${modalOpen && html`<${NewEnvModal} onClose=${() => setModalOpen(false)} onCreate=${(e) => { setExtraEnvs((x) => [...x, e]); toast('Environment "' + e.name + '" created'); setModalOpen(false); }} />`}`;
};

const NewEnvModal = ({ onClose, onCreate }) => {
  const [name, setName] = useState("");
  const [tier, setTier] = useState("staging");
  const create = () => {
    if (!name.trim()) return;
    const key = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-");
    onCreate({ key, name: name.trim(), tier, cluster: null });
  };
  return html`
    <div style=${{position: "fixed", inset: 0, background: "var(--overlay)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20}} onClick=${onClose}>
      <div style=${{background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, boxShadow: "var(--shadow-lg)", maxWidth: 480, width: "100%", padding: 24}} onClick=${(e) => e.stopPropagation()}>
        <div class="row between" style=${{marginBottom: 20}}>
          <h2 style=${{fontSize: 18}}>New environment</h2>
          <${Btn} variant="ghost" size="icon" onClick=${onClose}>✕<//>
        </div>
        <div class="col gap-3">
          <${Field} label="Name" required><${Input} value=${name} onInput=${(e) => setName(e.target.value)} placeholder="e.g. QA, staging-eu" /><//>
          <${Field} label="Tier">
            <div class="row gap-2 wrap">
              ${["dev", "staging", "prod"].map((t) => html`<${Chip} active=${tier === t} onClick=${() => setTier(t)}>${t}<//>`)}
            </div>
          <//>
          <div class="row gap-2" style=${{justifyContent: "flex-end", marginTop: 8}}>
            <${Btn} variant="ghost" onClick=${onClose}>Cancel<//>
            <${Btn} variant="primary" icon="+" disabled=${!name.trim()} onClick=${create}>Create environment<//>
          </div>
        </div>
      </div>
    </div>`;
};

const ConnectionPage = () => {
  const proj = useProject();
  const toast = useToast();
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
          <${Field} label="Environment" required><${Select} value="prod" onChange=${() => {}} options=${proj.envs.map((e) => e.key)} /><//>
          ${proj.cloud === "aws" && html`<${Field} label="Region" required><${Input} value=${proj.region} /><//>`}
          ${proj.cloud === "azure" && html`<${Field} label="Resource group" required><${Input} value="rg-devops" /><//>`}
          ${proj.cloud === "gcp" && html`<${Field} label="GCP project" required><${Input} value=${proj.provider.project} /><//>`}
          <${Field} label="Cluster name" required><${Input} value=${proj.clusterName} /><//>
          <div class="row gap-2"><${Btn} variant="primary" icon="⚡" onClick=${() => toast("Connecting to " + proj.clusterName + "…")}>Connect<//><${Btn} variant="ghost" onClick=${() => toast("Paste your kubeconfig in the field below")}>Paste kubeconfig instead<//></div>
        </div></div>
      <//>
    </div>`;
};

// Mock GitHub repos the user's account can attach — mirrors what the live
// AttachReposModal fetches from /integrations/github/repos.
const CICD_AVAILABLE_REPOS = [
  { fullName: "manov7723-sys/deepagent",       lang: "TypeScript", stars: 42, private: false, updated: "2m ago" },
  { fullName: "manov7723-sys/marketing-site",  lang: "TypeScript", stars: 8,  private: false, updated: "18m ago" },
  { fullName: "manov7723-sys/api",             lang: "Go",         stars: 15, private: true,  updated: "1h ago" },
  { fullName: "manov7723-sys/mobile-app",      lang: "Swift",      stars: 0,  private: true,  updated: "3h ago" },
  { fullName: "manov7723-sys/data-pipeline",   lang: "Python",     stars: 4,  private: true,  updated: "yesterday" },
  { fullName: "manov7723-sys/ml-notebooks",    lang: "Python",     stars: 2,  private: true,  updated: "2d ago" },
  { fullName: "manov7723-sys/legacy-monolith", lang: "Java",       stars: 1,  private: true,  updated: "1w ago" },
];

const AttachReposModal = ({ onClose, alreadyAttached, onAttach }) => {
  const [filter, setFilter] = useState("");
  const [selected, setSelected] = useState(new Set());
  const toggle = (r) => setSelected((s) => {
    const next = new Set(s);
    if (next.has(r)) next.delete(r); else next.add(r);
    return next;
  });
  const filtered = CICD_AVAILABLE_REPOS.filter((r) => !alreadyAttached.has(r.fullName) && r.fullName.toLowerCase().includes(filter.toLowerCase()));
  const langColor = (l) => l === "TypeScript" ? "#3178c6" : l === "Go" ? "#00add8" : l === "Python" ? "#3572a5" : l === "Java" ? "#b07219" : l === "Swift" ? "#f05138" : "#8b949e";
  return html`
    <div style=${{position: "fixed", inset: 0, background: "var(--overlay)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20}} onClick=${onClose}>
      <div style=${{background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, boxShadow: "var(--shadow-lg)", maxWidth: 620, width: "100%", padding: 24, maxHeight: "85vh", display: "flex", flexDirection: "column"}} onClick=${(e) => e.stopPropagation()}>
        <div class="row between" style=${{marginBottom: 6}}>
          <div class="row gap-3" style=${{alignItems: "center"}}>
            <span style=${{width: 34, height: 34, borderRadius: 9, background: "var(--accent-soft)", color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center"}}><${Icon} name="github" size=${18} /></span>
            <h2 style=${{fontSize: 18, margin: 0}}>Attach repositories</h2>
          </div>
          <${Btn} variant="ghost" size="icon" onClick=${onClose}>✕<//>
        </div>
        <p class="muted" style=${{fontSize: 12.5, margin: "0 0 16px", lineHeight: 1.5}}>Connected as <b class="mono">@manov7723-sys</b> · pick one or more repos to attach to this project. The agent will read them and commit workflow files directly to the default branch on push.</p>
        <${Input} value=${filter} onInput=${(e) => setFilter(e.target.value)} placeholder="Filter by name…" />
        <div style=${{flex: 1, overflowY: "auto", marginTop: 12, marginBottom: 12, border: "1px solid var(--border-soft)", borderRadius: 10}}>
          ${filtered.length === 0 ? html`<div class="muted" style=${{padding: 24, textAlign: "center", fontSize: 13}}>No unattached repos match "${filter}".</div>` : filtered.map((r) => {
            const on = selected.has(r.fullName);
            return html`
              <button onClick=${() => toggle(r.fullName)} style=${{display: "flex", width: "100%", padding: "10px 14px", gap: 12, alignItems: "center", background: on ? "var(--accent-soft)" : "transparent", border: "none", borderBottom: "1px solid var(--border-soft)", cursor: "pointer", color: "var(--text)", fontFamily: "inherit", textAlign: "left"}}>
                <span style=${{width: 18, height: 18, border: "2px solid " + (on ? "var(--accent)" : "var(--border)"), background: on ? "var(--accent)" : "transparent", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", color: "var(--accent-fg)", fontSize: 12, flex: "none"}}>${on ? "✓" : ""}</span>
                <div class="col" style=${{gap: 3, minWidth: 0, flex: 1}}>
                  <div class="row gap-2" style=${{alignItems: "center"}}>
                    <b class="mono" style=${{fontSize: 13.5}}>${r.fullName}</b>
                    ${r.private && html`<${Badge}>private<//>`}
                  </div>
                  <div class="row gap-3" style=${{fontSize: 11.5, color: "var(--text-muted)"}}>
                    <span class="row gap-1" style=${{alignItems: "center"}}><span style=${{width: 8, height: 8, borderRadius: "50%", background: langColor(r.lang)}}></span>${r.lang}</span>
                    <span>★ ${r.stars}</span>
                    <span>updated ${r.updated}</span>
                  </div>
                </div>
              </button>`;
          })}
        </div>
        <div class="row between" style=${{alignItems: "center"}}>
          <span class="faint" style=${{fontSize: 12}}>${selected.size} selected</span>
          <div class="row gap-2">
            <${Btn} variant="ghost" onClick=${onClose}>Cancel<//>
            <${Btn} variant="primary" icon="+" disabled=${selected.size === 0} onClick=${() => { onAttach([...selected].map((n) => CICD_AVAILABLE_REPOS.find((r) => r.fullName === n))); onClose(); }}>Attach ${selected.size || ""} repo${selected.size === 1 ? "" : "s"}<//>
          </div>
        </div>
      </div>
    </div>`;
};

// ═════════════════════════════════════════════════════════════════════
// Reusable modal primitives — used by everything below to keep
// destructive/confirmation/form flows consistent across pages.
// ═════════════════════════════════════════════════════════════════════

// Generic modal frame (dark backdrop, centered card, click-outside closes).
const ModalFrame = ({ onClose, width = 480, children }) => html`
  <div style=${{position: "fixed", inset: 0, background: "var(--overlay)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20}} onClick=${onClose}>
    <div style=${{background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, boxShadow: "var(--shadow-lg)", maxWidth: width, width: "100%", padding: 24, maxHeight: "85vh", overflowY: "auto"}} onClick=${(e) => e.stopPropagation()}>
      ${children}
    </div>
  </div>`;

// Standard destructive-action confirmation (Delete, Detach, Revoke, Disconnect).
const ConfirmModal = ({ title, description, confirmLabel = "Confirm", confirmTone = "danger", onConfirm, onClose, requireTyping }) => {
  const [typed, setTyped] = useState("");
  const canConfirm = !requireTyping || typed.trim() === requireTyping;
  return html`
    <${ModalFrame} onClose=${onClose}>
      <div class="row between" style=${{marginBottom: 12}}>
        <h2 style=${{fontSize: 17, margin: 0}}>${title}</h2>
        <${Btn} variant="ghost" size="icon" onClick=${onClose}>✕<//>
      </div>
      <p style=${{fontSize: 13, lineHeight: 1.6, margin: "0 0 16px", color: "var(--text-muted)"}}>${description}</p>
      ${requireTyping && html`
        <${Field} label=${'Type "' + requireTyping + '" to confirm'} required>
          <${Input} value=${typed} onInput=${(e) => setTyped(e.target.value)} placeholder=${requireTyping} />
        <//>`}
      <div class="row gap-2" style=${{justifyContent: "flex-end", marginTop: 16}}>
        <${Btn} variant="ghost" onClick=${onClose}>Cancel<//>
        <${Btn} variant=${confirmTone === "danger" ? "outline" : "primary"} disabled=${!canConfirm} onClick=${() => { onConfirm(); onClose(); }} style=${confirmTone === "danger" ? {color: "var(--danger)", borderColor: "var(--danger)"} : null}>${confirmLabel}<//>
      </div>
    <//>`;
};

// Small dropdown menu (used for project card ⋯, member ⋯, etc.).
const DropMenu = ({ items, onClose }) => html`
  <div style=${{position: "fixed", inset: 0, zIndex: 150}} onClick=${onClose}>
    <div style=${{position: "absolute", top: "auto", right: 30, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "var(--shadow-lg)", minWidth: 180, padding: 6, transform: "translate(0, 30px)"}} onClick=${(e) => e.stopPropagation()}>
      ${items.map((it) => html`
        <button key=${it.label} onClick=${() => { it.onSelect(); onClose(); }} style=${{display: "flex", width: "100%", padding: "8px 12px", background: "transparent", border: "none", borderRadius: 6, cursor: "pointer", color: it.tone === "danger" ? "var(--danger)" : "var(--text)", fontFamily: "inherit", fontSize: 13, textAlign: "left", gap: 8, alignItems: "center"}} onMouseOver=${(e) => e.currentTarget.style.background = "var(--surface-2)"} onMouseOut=${(e) => e.currentTarget.style.background = "transparent"}>
          ${it.icon && html`<span style=${{width: 16, textAlign: "center"}}>${it.icon}</span>`}
          <span>${it.label}</span>
        </button>`)}
    </div>
  </div>`;

// Invite member — real form with email, role, project scope.
const InviteMemberModal = ({ onClose, onInvite }) => {
  const [email, setEmail] = useState("");
  const [role, setRole] = useState("developer");
  const [projects, setProjects] = useState(new Set(["agent-aws"]));
  const toggleProj = (k) => setProjects((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const canInvite = email.includes("@") && email.includes(".") && projects.size > 0;
  return html`
    <${ModalFrame} onClose=${onClose} width=${520}>
      <div class="row between" style=${{marginBottom: 6}}>
        <div class="row gap-3" style=${{alignItems: "center"}}>
          <span style=${{width: 34, height: 34, borderRadius: 9, background: "var(--accent-soft)", color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center"}}><${Icon} name="mail" size=${16} /></span>
          <h2 style=${{fontSize: 18, margin: 0}}>Invite team member<//>
        </div>
        <${Btn} variant="ghost" size="icon" onClick=${onClose}>✕<//>
      </div>
      <p class="muted" style=${{fontSize: 12.5, margin: "0 0 16px", lineHeight: 1.5}}>They'll receive a signup link at this email. Link expires in 7 days.</p>
      <div class="col gap-3">
        <${Field} label="Email" required><${Input} type="email" value=${email} onInput=${(e) => setEmail(e.target.value)} placeholder="teammate@company.com" /><//>
        <${Field} label="Role" hint="Admins can invite others; developers can deploy; viewers are read-only.">
          <div class="row gap-2 wrap">
            ${[{k: "admin", l: "Admin"}, {k: "developer", l: "Developer"}, {k: "viewer", l: "Viewer"}].map((r) => html`<${Chip} active=${role === r.k} onClick=${() => setRole(r.k)}>${r.l}<//>`)}
          </div>
        <//>
        <${Field} label="Projects" hint="Which projects they can access. Add more later from Teams.">
          <div class="col gap-2">
            ${Object.values(PROJECTS).map((p) => html`
              <label style=${{display: "flex", padding: "8px 10px", gap: 8, alignItems: "center", background: projects.has(p.slug) ? "var(--accent-soft)" : "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 8, cursor: "pointer"}}>
                <input type="checkbox" checked=${projects.has(p.slug)} onChange=${() => toggleProj(p.slug)} />
                <b style=${{fontSize: 13}}>${p.name}</b>
                <${Badge}>${p.cloudLabel}<//>
              </label>`)}
          </div>
        <//>
        <div class="row gap-2" style=${{justifyContent: "flex-end", marginTop: 8}}>
          <${Btn} variant="ghost" onClick=${onClose}>Cancel<//>
          <${Btn} variant="primary" icon=${html`<${Icon} name="send" size=${14} />`} disabled=${!canInvite} onClick=${() => { onInvite({ email, role, projects: [...projects] }); onClose(); }}>Send invitation<//>
        </div>
      </div>
    <//>`;
};

// Test alert — mock trigger flow with delivery preview.
const TestAlertModal = ({ onClose, onFire }) => {
  const [kind, setKind] = useState("cpu");
  const [dest, setDest] = useState(new Set(["email", "slack"]));
  const [severity, setSeverity] = useState("high");
  const toggleDest = (k) => setDest((s) => { const n = new Set(s); n.has(k) ? n.delete(k) : n.add(k); return n; });
  const kinds = [
    { k: "cpu",     label: "High CPU on node",       metric: "container_cpu_usage_seconds_total > 80%" },
    { k: "memory",  label: "Memory pressure",         metric: "node_memory_MemAvailable_bytes < 10%" },
    { k: "restart", label: "Pod restart burst",       metric: "kube_pod_container_status_restarts_total > 5/5m" },
    { k: "5xx",     label: "HTTP 5xx spike",          metric: 'rate(http_requests_total{status=~"5.."}[5m]) > 1' },
  ];
  const active = kinds.find((x) => x.k === kind);
  return html`
    <${ModalFrame} onClose=${onClose} width=${540}>
      <div class="row between" style=${{marginBottom: 6}}>
        <div class="row gap-3" style=${{alignItems: "center"}}>
          <span style=${{width: 34, height: 34, borderRadius: 9, background: "var(--warn-soft, #7a5a1a)", color: "var(--warn)", display: "flex", alignItems: "center", justifyContent: "center"}}><${Icon} name="alert" size=${16} /></span>
          <h2 style=${{fontSize: 18, margin: 0}}>Fire test alert<//>
        </div>
        <${Btn} variant="ghost" size="icon" onClick=${onClose}>✕<//>
      </div>
      <p class="muted" style=${{fontSize: 12.5, margin: "0 0 16px", lineHeight: 1.5}}>Sends a real-shaped alert to your notification channels so you can verify oncall routing works end-to-end. Doesn't trigger any incident automation.</p>
      <div class="col gap-3">
        <${Field} label="Alert type">
          <div class="col gap-2">
            ${kinds.map((x) => html`
              <label style=${{display: "flex", padding: "10px 12px", background: kind === x.k ? "var(--accent-soft)" : "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 8, cursor: "pointer", gap: 10, alignItems: "center"}}>
                <input type="radio" name="k" checked=${kind === x.k} onChange=${() => setKind(x.k)} />
                <div class="col" style=${{gap: 2, flex: 1}}>
                  <b style=${{fontSize: 13}}>${x.label}</b>
                  <span class="mono faint" style=${{fontSize: 11}}>${x.metric}</span>
                </div>
              </label>`)}
          </div>
        <//>
        <${Field} label="Severity">
          <div class="row gap-2 wrap">
            ${[{k: "low", l: "Low", tone: "info"}, {k: "medium", l: "Medium", tone: "warn"}, {k: "high", l: "High", tone: "danger"}].map((s) => html`<${Chip} active=${severity === s.k} onClick=${() => setSeverity(s.k)}>${s.l}<//>`)}
          </div>
        <//>
        <${Field} label="Send to">
          <div class="row gap-2 wrap">
            ${[{k: "email", l: "📧 Email · oncall@example.com"}, {k: "slack", l: "💬 Slack · #alerts"}, {k: "pager", l: "📟 PagerDuty · deepagent-oncall"}].map((d) => html`
              <label style=${{display: "flex", padding: "6px 12px", background: dest.has(d.k) ? "var(--accent-soft)" : "var(--surface-2)", border: "1px solid " + (dest.has(d.k) ? "var(--accent-line, var(--border))" : "var(--border-soft)"), borderRadius: 20, cursor: "pointer", gap: 6, alignItems: "center", fontSize: 12.5}}>
                <input type="checkbox" checked=${dest.has(d.k)} onChange=${() => toggleDest(d.k)} style=${{margin: 0}} />
                <span>${d.l}</span>
              </label>`)}
          </div>
        <//>
        <div style=${{padding: 12, background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 8, fontSize: 12}}>
          <b style=${{fontSize: 12}}>Preview</b>
          <div class="muted mono" style=${{marginTop: 4, lineHeight: 1.5}}>
            <span style=${{color: severity === "high" ? "var(--danger)" : severity === "medium" ? "var(--warn)" : "var(--info)", fontWeight: 700}}>[${severity.toUpperCase()}]</span> ${active.label}<br/>
            metric: ${active.metric}<br/>
            channels: ${[...dest].join(", ") || "(none — pick at least one)"}
          </div>
        </div>
        <div class="row gap-2" style=${{justifyContent: "flex-end", marginTop: 4}}>
          <${Btn} variant="ghost" onClick=${onClose}>Cancel<//>
          <${Btn} variant="primary" icon="▲" disabled=${dest.size === 0} onClick=${() => { onFire({ kind: active.label, severity, dest: [...dest] }); onClose(); }}>Fire test alert<//>
        </div>
      </div>
    <//>`;
};

// Configure alerts — routing rules per severity → channel.
const ConfigureAlertsModal = ({ onClose, onSave }) => {
  const [rules, setRules] = useState([
    { severity: "high",   emails: "oncall@example.com", slack: "#alerts",           pager: "deepagent-oncall" },
    { severity: "medium", emails: "team@example.com",   slack: "#alerts-warn",      pager: "" },
    { severity: "low",    emails: "",                    slack: "#alerts-info",     pager: "" },
  ]);
  const upd = (i, k, v) => setRules((rs) => rs.map((r, idx) => idx === i ? { ...r, [k]: v } : r));
  return html`
    <${ModalFrame} onClose=${onClose} width=${620}>
      <div class="row between" style=${{marginBottom: 6}}>
        <h2 style=${{fontSize: 18, margin: 0}}>Configure alert routing<//>
        <${Btn} variant="ghost" size="icon" onClick=${onClose}>✕<//>
      </div>
      <p class="muted" style=${{fontSize: 12.5, margin: "0 0 16px", lineHeight: 1.5}}>Routing rules per severity. Empty channels mean "don't notify there." Rules apply across all clouds and all projects.</p>
      <div class="col gap-3">
        ${rules.map((r, i) => html`
          <div style=${{padding: 12, background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 10}}>
            <div class="row gap-2" style=${{alignItems: "center", marginBottom: 10}}>
              <${Badge} tone=${r.severity === "high" ? "danger" : r.severity === "medium" ? "warn" : "info"}>${r.severity}<//>
              <span class="muted" style=${{fontSize: 12}}>severity</span>
            </div>
            <div class="col gap-2">
              <div class="row gap-2" style=${{alignItems: "center"}}><span style=${{width: 60, fontSize: 12, color: "var(--text-muted)"}}>Email</span><div style=${{flex: 1}}><${Input} value=${r.emails} onInput=${(e) => upd(i, "emails", e.target.value)} placeholder="comma-separated emails" /></div></div>
              <div class="row gap-2" style=${{alignItems: "center"}}><span style=${{width: 60, fontSize: 12, color: "var(--text-muted)"}}>Slack</span><div style=${{flex: 1}}><${Input} value=${r.slack} onInput=${(e) => upd(i, "slack", e.target.value)} placeholder="#channel" /></div></div>
              <div class="row gap-2" style=${{alignItems: "center"}}><span style=${{width: 60, fontSize: 12, color: "var(--text-muted)"}}>Pager</span><div style=${{flex: 1}}><${Input} value=${r.pager} onInput=${(e) => upd(i, "pager", e.target.value)} placeholder="PagerDuty service key" /></div></div>
            </div>
          </div>`)}
        <div class="row gap-2" style=${{justifyContent: "flex-end", marginTop: 4}}>
          <${Btn} variant="ghost" onClick=${onClose}>Cancel<//>
          <${Btn} variant="primary" icon="✓" onClick=${() => { onSave(rules); onClose(); }}>Save routing<//>
        </div>
      </div>
    <//>`;
};

// Alert investigation drawer — runbook, history, related metrics.
const AlertInvestigateModal = ({ alert, onClose, onAck }) => html`
  <${ModalFrame} onClose=${onClose} width=${620}>
    <div class="row between" style=${{marginBottom: 6}}>
      <div class="row gap-3" style=${{alignItems: "center"}}>
        <${Badge} tone=${alert.sev === "high" ? "danger" : "warn"}>${alert.sev}<//>
        <h2 style=${{fontSize: 17, margin: 0}}>${alert.name}<//>
      </div>
      <${Btn} variant="ghost" size="icon" onClick=${onClose}>✕<//>
    </div>
    <div class="muted mono" style=${{fontSize: 12, marginBottom: 16}}>${alert.target} · env ${alert.env}</div>

    <div style=${{padding: 12, background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 10, marginBottom: 14}}>
      <div class="faint" style=${{fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6}}>Runbook</div>
      <ol style=${{margin: 0, paddingLeft: 20, fontSize: 13, lineHeight: 1.7}}>
        <li>Check current value in <b>Cloud stats → Observability</b>.</li>
        <li>Look for correlated deploys in the <b>Activity</b> tab in the last 30 min.</li>
        <li>If sustained, page the on-call channel and downgrade the affected env's traffic weight in <b>Promotions</b>.</li>
        <li>Ack this alert once resolved — auto-mutes similar alerts for 30 min.</li>
      </ol>
    </div>

    <div style=${{padding: 12, background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 10, marginBottom: 14}}>
      <div class="faint" style=${{fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6}}>Recent fires · last 24h</div>
      <div class="col gap-1">
        ${[["12:47", "fired", "danger"], ["11:20", "resolved (auto)", "ok"], ["09:03", "fired", "danger"], ["08:59", "resolved (auto)", "ok"]].map(([t, s, tone]) => html`
          <div class="row between" style=${{fontSize: 12, padding: "4px 0"}}>
            <span class="mono faint">${t}</span>
            <${Badge} tone=${tone}>${s}<//>
          </div>`)}
      </div>
    </div>

    <div style=${{padding: 12, background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 10, marginBottom: 16}}>
      <div class="faint" style=${{fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 6}}>Notified</div>
      <div class="row gap-2 wrap" style=${{fontSize: 12}}>
        <${Badge}>📧 oncall@example.com<//>
        <${Badge}>💬 #alerts (2m ago)<//>
        <${Badge}>📟 PagerDuty (ack pending)<//>
      </div>
    </div>

    <div class="row gap-2" style=${{justifyContent: "flex-end"}}>
      <${Btn} variant="ghost" onClick=${onClose}>Close<//>
      <${Btn} variant="primary" icon="✓" onClick=${() => { onAck(); onClose(); }}>Ack &amp; mute 30m<//>
    </div>
  <//>`;

// Change / choose plan — confirm switch with prorated preview.
const ChangePlanConfirmModal = ({ plan, current, onClose, onConfirm }) => html`
  <${ModalFrame} onClose=${onClose} width=${520}>
    <div class="row between" style=${{marginBottom: 6}}>
      <h2 style=${{fontSize: 18, margin: 0}}>Switch to <b>${plan.name}</b><//>
      <${Btn} variant="ghost" size="icon" onClick=${onClose}>✕<//>
    </div>
    <p class="muted" style=${{fontSize: 12.5, margin: "0 0 16px", lineHeight: 1.5}}>Your Visa ending 4242 will be charged the prorated difference immediately, then the new price on your next billing date.</p>
    <div style=${{padding: 14, background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 10, marginBottom: 16}}>
      <div class="row between" style=${{fontSize: 13, marginBottom: 6}}><span class="muted">From</span><b>${current.name} · ${current.price}/mo</b></div>
      <div class="row between" style=${{fontSize: 13, marginBottom: 6}}><span class="muted">To</span><b>${plan.name} · ${plan.price}/mo</b></div>
      <div class="row between" style=${{fontSize: 13, marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border-soft)"}}><span class="muted">Prorated charge today</span><b style=${{color: "var(--accent)"}}>~$${(parseFloat((plan.price || "0").replace("$", "")) - parseFloat((current.price || "0").replace("$", ""))).toFixed(2)}</b></div>
    </div>
    <div style=${{padding: 12, background: "var(--info-soft, #14355a)", color: "var(--info)", borderRadius: 8, fontSize: 12.5, marginBottom: 16, display: "flex", gap: 8, alignItems: "flex-start"}}>
      <span>ℹ</span><span>You can cancel or downgrade at any time — future months prorate the difference back as credit.</span>
    </div>
    <div class="row gap-2" style=${{justifyContent: "flex-end"}}>
      <${Btn} variant="ghost" onClick=${onClose}>Cancel<//>
      <${Btn} variant="primary" icon="✓" onClick=${() => { onConfirm(); onClose(); }}>Switch to ${plan.name}<//>
    </div>
  <//>`;

// Buy tokens — pack picker + payment method + confirm.
const BuyTokensModal = ({ pack, onClose, onBuy }) => {
  const [qty, setQty] = useState(1);
  const total = (parseFloat(pack.price.replace("$", "")) * qty).toFixed(2);
  return html`
    <${ModalFrame} onClose=${onClose} width=${480}>
      <div class="row between" style=${{marginBottom: 6}}>
        <h2 style=${{fontSize: 18, margin: 0}}>Buy ${pack.name}<//>
        <${Btn} variant="ghost" size="icon" onClick=${onClose}>✕<//>
      </div>
      <p class="muted" style=${{fontSize: 12.5, margin: "0 0 16px", lineHeight: 1.5}}>One-time purchase · agent tokens never expire and roll over month to month. Charged to your Visa ending 4242.</p>
      <div style=${{padding: 14, background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 10, marginBottom: 12}}>
        <div class="row between" style=${{fontSize: 13, marginBottom: 8}}><span class="muted">Pack</span><b>${pack.name}</b></div>
        <div class="row between" style=${{fontSize: 13, marginBottom: 8}}><span class="muted">Unit price</span><span class="mono">${pack.price}</span></div>
        <div class="row between" style=${{fontSize: 13, alignItems: "center"}}>
          <span class="muted">Quantity</span>
          <div class="row gap-2" style=${{alignItems: "center"}}>
            <button onClick=${() => setQty(Math.max(1, qty - 1))} style=${{width: 28, height: 28, borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", cursor: "pointer", fontSize: 14, fontWeight: 700}}>−</button>
            <span class="mono" style=${{minWidth: 30, textAlign: "center", fontWeight: 700}}>${qty}</span>
            <button onClick=${() => setQty(qty + 1)} style=${{width: 28, height: 28, borderRadius: 6, border: "1px solid var(--border)", background: "var(--surface)", color: "var(--text)", cursor: "pointer", fontSize: 14, fontWeight: 700}}>+</button>
          </div>
        </div>
        <div class="row between" style=${{fontSize: 14, fontWeight: 700, marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border-soft)"}}><span>Total today</span><span style=${{color: "var(--accent)"}}>$${total}</span></div>
      </div>
      <div class="row gap-2" style=${{alignItems: "center", marginBottom: 16, padding: 10, background: "var(--surface-2)", borderRadius: 8, fontSize: 12}}>
        <span style=${{width: 34, height: 22, background: "linear-gradient(135deg, #1a1f71, #f7b600)", borderRadius: 4, display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontWeight: 700, fontSize: 8}}>VISA</span>
        <span>Visa ending 4242 · Expires 12/28</span>
      </div>
      <div class="row gap-2" style=${{justifyContent: "flex-end"}}>
        <${Btn} variant="ghost" onClick=${onClose}>Cancel<//>
        <${Btn} variant="primary" icon="✓" onClick=${() => { onBuy({ pack: pack.name, qty, total }); onClose(); }}>Charge $${total}<//>
      </div>
    <//>`;
};

// Add credentials — cloud-adaptive form (Vault / SP / SA key).
const AddCredentialsModal = ({ proj, onClose, onAdd }) => {
  const [envKey, setEnvKey] = useState(proj.envs[0]?.key || "prod");
  const [pastedYaml, setPastedYaml] = useState("");
  const modeLabel = proj.cloud === "aws" ? "Vault (AWS access key + secret)"
                 : proj.cloud === "azure" ? "Service Principal (client id + secret)"
                 : "Service Account key (JSON)";
  return html`
    <${ModalFrame} onClose=${onClose} width=${540}>
      <div class="row between" style=${{marginBottom: 6}}>
        <h2 style=${{fontSize: 18, margin: 0}}>Add cloud credentials<//>
        <${Btn} variant="ghost" size="icon" onClick=${onClose}>✕<//>
      </div>
      <p class="muted" style=${{fontSize: 12.5, margin: "0 0 16px", lineHeight: 1.5}}>Adding a second set of credentials for <b>${proj.cloudLabel}</b> · <b>${envKey}</b>. Type: ${modeLabel}. Encrypted at rest (AES-256-GCM).</p>
      <div class="col gap-3">
        <${Field} label="Environment"><${Select} value=${envKey} onChange=${setEnvKey} options=${proj.envs.map((e) => e.key)} /><//>
        <${Field} label="Credential" required hint="Paste the JSON / YAML / secret as issued by your cloud console.">
          <textarea class="textarea mono" value=${pastedYaml} onInput=${(e) => setPastedYaml(e.target.value)} placeholder=${proj.cloud === "aws" ? "aws_access_key_id: …\naws_secret_access_key: …" : proj.cloud === "azure" ? "{ \"clientId\": \"…\", \"clientSecret\": \"…\", \"tenantId\": \"…\" }" : "{ \"type\": \"service_account\", … }"} style=${{border: "1px solid var(--border)", background: "var(--surface-2)", borderRadius: 8, padding: 10, minHeight: 140, resize: "vertical", width: "100%", color: "var(--text)", fontFamily: "var(--font-mono)", fontSize: 12}} />
        <//>
        <div class="row gap-2" style=${{justifyContent: "flex-end", marginTop: 4}}>
          <${Btn} variant="ghost" onClick=${onClose}>Cancel<//>
          <${Btn} variant="primary" icon="🔒" disabled=${!pastedYaml.trim()} onClick=${() => { onAdd({ env: envKey, size: pastedYaml.length }); onClose(); }}>Encrypt &amp; store<//>
        </div>
      </div>
    <//>`;
};

// Cost estimator + optimizer — dual-purpose modal.
const CostToolModal = ({ mode, onClose, onRun }) => {
  const [scope, setScope] = useState("this-project");
  const isEstimate = mode === "estimate";
  return html`
    <${ModalFrame} onClose=${onClose} width=${520}>
      <div class="row between" style=${{marginBottom: 6}}>
        <div class="row gap-3" style=${{alignItems: "center"}}>
          <span style=${{width: 34, height: 34, borderRadius: 9, background: "var(--accent-soft)", color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 16}}>$</span>
          <h2 style=${{fontSize: 18, margin: 0}}>${isEstimate ? "Estimate infrastructure cost" : "Analyze spend for savings"}<//>
        </div>
        <${Btn} variant="ghost" size="icon" onClick=${onClose}>✕<//>
      </div>
      <p class="muted" style=${{fontSize: 12.5, margin: "0 0 16px", lineHeight: 1.5}}>${isEstimate ? "Runs your Terraform through Infracost — shows monthly cost of the current plan before you apply it." : "Scans this project's cloud resources for obvious wins: idle nodes, oversized VMs, reserved-instance opportunities."}</p>
      <div class="col gap-3">
        <${Field} label="Scope">
          <div class="row gap-2 wrap">
            <${Chip} active=${scope === "this-project"} onClick=${() => setScope("this-project")}>This project only<//>
            <${Chip} active=${scope === "org"} onClick=${() => setScope("org")}>Whole workspace<//>
          </div>
        <//>
        ${isEstimate ? html`
          <${Field} label="Preview">
            <div style=${{padding: 12, background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 10}}>
              <div class="row between" style=${{fontSize: 13, marginBottom: 6}}><span class="muted">Compute (AKS/EKS nodes)</span><b class="mono">$142/mo</b></div>
              <div class="row between" style=${{fontSize: 13, marginBottom: 6}}><span class="muted">Storage + state</span><b class="mono">$8/mo</b></div>
              <div class="row between" style=${{fontSize: 13, marginBottom: 6}}><span class="muted">Networking (LB + egress)</span><b class="mono">$27/mo</b></div>
              <div class="row between" style=${{fontSize: 13, marginBottom: 6}}><span class="muted">Log analytics</span><b class="mono">$3/mo</b></div>
              <div class="row between" style=${{fontSize: 14, fontWeight: 700, marginTop: 10, paddingTop: 10, borderTop: "1px solid var(--border-soft)"}}><span>Estimated total</span><span style=${{color: "var(--accent)"}}>~$180/mo</span></div>
            </div>
          <//>` : html`
          <${Field} label="Findings so far">
            <div class="col gap-2">
              ${[["Idle node (0% CPU for 6h)", "aks-apppool-000001", "$27/mo", "danger"], ["Oversized VM · Standard_D8s_v3", "eks-worker-2", "$96/mo", "warn"], ["Unattached disk · 128 GB Premium SSD", "pv-orphan-3", "$18/mo", "warn"]].map(([finding, target, save, tone]) => html`
                <div class="row between" style=${{padding: 10, background: "var(--surface-2)", borderRadius: 8}}>
                  <div class="col" style=${{gap: 2, minWidth: 0}}>
                    <b style=${{fontSize: 12.5}}>${finding}</b>
                    <span class="mono faint" style=${{fontSize: 11}}>${target}</span>
                  </div>
                  <${Badge} tone=${tone}>save ${save}<//>
                </div>`)}
            </div>
          <//>`}
        <div class="row gap-2" style=${{justifyContent: "flex-end", marginTop: 4}}>
          <${Btn} variant="ghost" onClick=${onClose}>Close<//>
          <${Btn} variant="primary" icon="⚡" onClick=${() => { onRun({ mode, scope }); onClose(); }}>${isEstimate ? "Rerun estimate" : "Apply optimizations"}<//>
        </div>
      </div>
    <//>`;
};

const CicdPage = () => {
  const toast = useToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [attached, setAttached] = useState([
    { fullName: "manov7723-sys/deepagent",      lang: "TypeScript", branch: "main",    workflow: "ci.yml",     lastRun: "2m ago",   status: "succeeded" },
    { fullName: "manov7723-sys/marketing-site", lang: "TypeScript", branch: "main",    workflow: "deploy.yml", lastRun: "18m ago",  status: "succeeded" },
    { fullName: "manov7723-sys/api",            lang: "Go",         branch: "prod", workflow: "test.yml",   lastRun: "1h ago",   status: "failed" },
  ]);
  const attachedNames = new Set(attached.map((r) => r.fullName));
  const langColor = (l) => l === "TypeScript" ? "#3178c6" : l === "Go" ? "#00add8" : l === "Python" ? "#3572a5" : l === "Java" ? "#b07219" : l === "Swift" ? "#f05138" : "#8b949e";
  return html`
  <${PageHead} title="CI/CD & Repos" sub="Pipeline runs, workflow generators, and connected repositories." actions=${html`<${Btn} variant="primary" icon="+" onClick=${() => setModalOpen(true)}>Attach repo<//>`} />
  <${Card} title="Attached repositories" sub=${attached.length + " repo" + (attached.length === 1 ? "" : "s") + " · agent reads each on push"}>
    ${attached.length === 0 ? html`
      <div class="col center" style=${{padding: 30, textAlign: "center", gap: 10}}>
        <div class="muted" style=${{fontSize: 13}}>No repos attached to this project yet.</div>
        <${Btn} variant="primary" icon="+" onClick=${() => setModalOpen(true)}>Attach a repo<//>
      </div>` : html`
      <div class="col gap-2">
        ${attached.map((r) => html`
          <div style=${{padding: 12, background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 10}}>
            <div class="row between wrap" style=${{gap: 12, alignItems: "flex-start"}}>
              <div class="col" style=${{gap: 4, minWidth: 0}}>
                <div class="row gap-2" style=${{alignItems: "center"}}>
                  <${Icon} name="github" size=${16} />
                  <b class="mono" style=${{fontSize: 13.5}}>${r.fullName}</b>
                  <${Badge} tone=${r.status === "succeeded" ? "ok" : r.status === "failed" ? "danger" : "info"}>${r.status}<//>
                </div>
                <div class="row gap-3" style=${{fontSize: 11.5, color: "var(--text-muted)"}}>
                  <span class="row gap-1" style=${{alignItems: "center"}}><span style=${{width: 8, height: 8, borderRadius: "50%", background: langColor(r.lang)}}></span>${r.lang}</span>
                  <span class="mono">${r.branch}</span>
                  <span class="mono">${r.workflow}</span>
                  <span>last run ${r.lastRun}</span>
                </div>
              </div>
              <div class="row gap-2">
                <${Btn} size="sm" onClick=${() => toast("Triggering " + r.workflow + " on " + r.fullName)}>Run workflow<//>
                <${Btn} size="sm" variant="ghost" onClick=${() => { setAttached((xs) => xs.filter((x) => x.fullName !== r.fullName)); toast(r.fullName + " detached from project", "warn"); }}>Detach<//>
              </div>
            </div>
          </div>`)}
      </div>`}
  <//>
  <${Card} title="Recent pipeline runs" sub="Latest 20 across all attached repos">
    <${Table} headers=${["Repo", "Workflow", "Branch", "Status", "Duration", "Actor"]} rows=${MOCK.pipelines.map((p) => [
      html`<span class="mono">${p.repo}</span>`, p.workflow, html`<span class="mono">${p.branch}</span>`,
      html`<${Badge} tone=${p.status === "succeeded" ? "ok" : p.status === "failed" ? "danger" : p.status === "running" ? "info" : "warn"}>${p.status}<//>`,
      html`<span class="tnum">${p.dur}</span>`, p.actor,
    ])} />
  <//>
  ${modalOpen && html`<${AttachReposModal} onClose=${() => setModalOpen(false)} alreadyAttached=${attachedNames} onAttach=${(repos) => {
    setAttached((xs) => [...xs, ...repos.map((r) => ({ ...r, branch: "main", workflow: "ci.yml", lastRun: "just now", status: "succeeded" }))]);
    toast(repos.length + " repo" + (repos.length === 1 ? "" : "s") + " attached — agent is now watching for pushes");
  }} />`}
  `;
};

const AlertsPage = () => {
  const toast = useToast();
  const [acked, setAcked] = useState(new Set());
  const [testOpen, setTestOpen] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [investigating, setInvestigating] = useState(null);
  return html`
  <${PageHead} title="Alerts" sub="CloudWatch, Azure Monitor, GCP Monitoring, and in-cluster Prometheus." actions=${html`<${Btn} onClick=${() => setTestOpen(true)}>Test alert<//><${Btn} variant="primary" icon="⚙" onClick=${() => setConfigOpen(true)}>Configure<//>`} />
  <div style=${{display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14}}>
    <${Stat} label="Open alerts" value=${String(Math.max(0, 3 - acked.size))} sub="5 total" icon="!" />
    <${Stat} label="High severity" value="1" sub="needs action" icon="⚠" />
    <${Stat} label="Security" value="0" sub="clean" icon="🛡" />
    <${Stat} label="Mean ack" value="14m" sub="last 30d" icon="◑" />
  </div>
  <div class="col gap-2">
    ${MOCK.alerts.map((a) => html`
      <${Card}>
        <div class="row between">
          <div class="col gap-1">
            <div class="row gap-2" style=${{alignItems: "center"}}><b>${a.name}</b><${Badge} tone=${a.sev === "high" ? "danger" : "warn"}>${a.sev}<//><${Badge} tone="info">${a.env}<//>${acked.has(a.name) && html`<${Badge} tone="ok">acked<//>`}</div>
            <span class="muted" style=${{fontSize: 12.5}}>${a.target}</span>
          </div>
          <div class="row gap-2">
            <${Btn} size="sm" onClick=${() => setInvestigating(a)}>Investigate<//>
            <${Btn} size="sm" variant="primary" disabled=${acked.has(a.name)} onClick=${() => { setAcked((s) => new Set([...s, a.name])); toast(a.name + " acked"); }}>Ack<//>
          </div>
        </div>
      <//>`)}
  </div>
  ${testOpen && html`<${TestAlertModal} onClose=${() => setTestOpen(false)} onFire=${(v) => toast('"' + v.kind + '" test alert (' + v.severity + ') sent to ' + v.dest.join(", "))} />`}
  ${configOpen && html`<${ConfigureAlertsModal} onClose=${() => setConfigOpen(false)} onSave=${(r) => toast("Alert routing saved · " + r.length + " rules active")} />`}
  ${investigating && html`<${AlertInvestigateModal} alert=${investigating} onClose=${() => setInvestigating(null)} onAck=${() => { setAcked((s) => new Set([...s, investigating.name])); toast(investigating.name + " acked · muted for 30m"); }} />`}
  `;
};

const CostPage = () => {
  const toast = useToast();
  const [costTool, setCostTool] = useState(null); // "estimate" | "optimize"
  return html`
  <${PageHead} title="Cost" sub="Multi-cloud spend rollup, budget tracking, and optimization findings." actions=${html`<${Btn} onClick=${() => setCostTool("estimate")}>Estimate infra<//><${Btn} variant="primary" icon="⚡" onClick=${() => setCostTool("optimize")}>Optimize<//>`} />
  ${costTool && html`<${CostToolModal} mode=${costTool} onClose=${() => setCostTool(null)} onRun=${(v) => toast(v.mode === "estimate" ? "Rerunning Infracost against " + v.scope + "…" : "Applying 3 optimizations, saves ~$141/mo")} />`}
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
};

const UptimePage = () => {
  const toast = useToast();
  const [extra, setExtra] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const monitors = [...MOCK.monitors, ...extra];
  return html`
  <${PageHead} title="Uptime" sub="External HTTP monitors for the project's endpoints." actions=${html`<${Btn} variant="primary" icon="+" onClick=${() => setModalOpen(true)}>New monitor<//>`} />
  <${Card} title="Monitors" sub=${monitors.length + " active · 30d avg uptime 99.94%"}>
    <${Table} headers=${["URL", "Status", "Uptime 30d", "p50", "Last check"]} rows=${monitors.map((m) => [
      html`<span class="mono">${m.url}</span>`,
      html`<${Badge} tone=${m.status === "up" ? "ok" : "warn"}>${m.status}<//>`,
      html`<span class="tnum">${m.uptime}</span>`,
      html`<span class="tnum">${m.p50}</span>`,
      html`<span class="faint">${m.last} ago</span>`,
    ])} />
  <//>
  ${modalOpen && html`<${NewMonitorModal} onClose=${() => setModalOpen(false)} onCreate=${(m) => { setExtra((x) => [...x, m]); toast('Monitor for ' + m.url + ' added'); setModalOpen(false); }} />`}`;
};

// ═════════════════════════════════════════════════════════════════════
// Scheduler — deploy later. Cron-driven promotions of an image tag into
// a target env at a specific time. Mirrors src/lib/scheduler intent.
// ═════════════════════════════════════════════════════════════════════

const SCHEDULE_PRESETS = {
  "every-day-9":     { label: "Every day at 09:00 UTC",       cron: "0 9 * * *" },
  "weekdays-22":     { label: "Weekdays at 22:00 UTC",        cron: "0 22 * * 1-5" },
  "sundays-3":       { label: "Sundays at 03:00 UTC",         cron: "0 3 * * 0" },
  "every-4h":        { label: "Every 4 hours",                cron: "0 */4 * * *" },
  "once":            { label: "Once — at a specific time",    cron: "" },
  "custom":          { label: "Custom cron expression",       cron: "" },
};

const NewScheduleModal = ({ proj, onClose, onCreate }) => {
  const [name, setName] = useState("");
  const [repo, setRepo] = useState((proj.repos && proj.repos[0]) || "manov7723-sys/deepagent");
  const [tag, setTag] = useState("latest");
  const [env, setEnv] = useState(proj.envs[0]?.key || "prod");
  const [preset, setPreset] = useState("every-day-9");
  const [customCron, setCustomCron] = useState("0 12 * * *");
  const [onceAt, setOnceAt] = useState("");
  const [enabled, setEnabled] = useState(true);
  const canCreate = name.trim() && (preset !== "once" || onceAt) && (preset !== "custom" || customCron.trim());
  const create = () => {
    const cronStr = preset === "custom" ? customCron : preset === "once" ? "@once " + onceAt : SCHEDULE_PRESETS[preset].cron;
    onCreate({ name: name.trim(), repo, tag, env, cron: cronStr, label: preset === "custom" ? "Custom · " + customCron : preset === "once" ? "Once · " + onceAt : SCHEDULE_PRESETS[preset].label, enabled });
  };
  return html`
    <${ModalFrame} onClose=${onClose} width=${560}>
      <div class="row between" style=${{marginBottom: 6}}>
        <div class="row gap-3" style=${{alignItems: "center"}}>
          <span style=${{width: 34, height: 34, borderRadius: 9, background: "var(--accent-soft)", color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center"}}><${Icon} name="clock" size=${16} /></span>
          <h2 style=${{fontSize: 18, margin: 0}}>New scheduled deploy<//>
        </div>
        <${Btn} variant="ghost" size="icon" onClick=${onClose}>✕<//>
      </div>
      <p class="muted" style=${{fontSize: 12.5, margin: "0 0 16px", lineHeight: 1.5}}>Deploys the image on the schedule below. Runs on the agent's cron worker — no need to keep this browser open.</p>
      <div class="col gap-3">
        <${Field} label="Name" required><${Input} value=${name} onInput=${(e) => setName(e.target.value)} placeholder="Nightly release cut" /><//>
        <${Field} label="Image" required>
          <div class="row gap-2">
            <div style=${{flex: 1}}><${Select} value=${repo} onChange=${setRepo} options=${proj.repos && proj.repos.length ? proj.repos : ["manov7723-sys/deepagent", "manov7723-sys/api", "manov7723-sys/marketing-site"]} /></div>
            <div style=${{width: 140}}><${Input} value=${tag} onInput=${(e) => setTag(e.target.value)} placeholder="tag / SHA" /></div>
          </div>
        <//>
        <${Field} label="Target environment"><${Select} value=${env} onChange=${setEnv} options=${proj.envs.map((e) => e.key)} /><//>
        <${Field} label="When">
          <${Select} value=${preset} onChange=${setPreset} options=${Object.keys(SCHEDULE_PRESETS).map((k) => ({value: k, label: SCHEDULE_PRESETS[k].label}))} />
        <//>
        ${preset === "custom" && html`
          <${Field} label="Custom cron expression" hint="Standard 5-field cron. Runs in UTC.">
            <${Input} value=${customCron} onInput=${(e) => setCustomCron(e.target.value)} placeholder="0 12 * * *" />
          <//>`}
        ${preset === "once" && html`
          <${Field} label="Run at (ISO time, UTC)" hint="e.g. 2026-08-15T09:00:00Z">
            <${Input} value=${onceAt} onInput=${(e) => setOnceAt(e.target.value)} placeholder="2026-08-15T09:00:00Z" />
          <//>`}
        <label class="row gap-2" style=${{alignItems: "center", padding: "8px 10px", background: "var(--surface-2)", borderRadius: 8, cursor: "pointer", fontSize: 13}}>
          <input type="checkbox" checked=${enabled} onChange=${() => setEnabled(!enabled)} />
          <span>Enable this schedule immediately</span>
        </label>
        <div style=${{padding: 12, background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 8, fontSize: 12}}>
          <b style=${{fontSize: 12}}>Summary</b>
          <div class="muted" style=${{marginTop: 4, lineHeight: 1.6}}>Deploy <span class="mono">${repo}:${tag}</span> → <b>${env}</b> · ${preset === "custom" ? "cron " + customCron : preset === "once" ? "once at " + (onceAt || "…") : SCHEDULE_PRESETS[preset].label}</div>
        </div>
        <div class="row gap-2" style=${{justifyContent: "flex-end", marginTop: 4}}>
          <${Btn} variant="ghost" onClick=${onClose}>Cancel<//>
          <${Btn} variant="primary" icon="+" disabled=${!canCreate} onClick=${create}>Create schedule<//>
        </div>
      </div>
    <//>`;
};

const SchedulerPage = () => {
  const proj = useProject();
  const toast = useToast();
  const [modalOpen, setModalOpen] = useState(false);
  const [schedules, setSchedules] = useState([
    { id: "s1", name: "Nightly release cut",      repo: "manov7723-sys/deepagent",      tag: "main",      env: "prod", label: "Every day at 09:00 UTC",  cron: "0 9 * * *",   enabled: true,  lastRun: "9h ago",   nextRun: "in 15h", lastStatus: "succeeded" },
    { id: "s2", name: "Staging weekly refresh",   repo: "manov7723-sys/api",            tag: "latest",    env: "staging",    label: "Sundays at 03:00 UTC",    cron: "0 3 * * 0",   enabled: true,  lastRun: "5 days ago", nextRun: "in 2 days", lastStatus: "succeeded" },
    { id: "s3", name: "Marketing site refresh",   repo: "manov7723-sys/marketing-site", tag: "main",      env: "prod", label: "Every 4 hours",           cron: "0 */4 * * *", enabled: false, lastRun: "2 days ago", nextRun: "paused",    lastStatus: "succeeded" },
    { id: "s4", name: "One-off: launch drop",     repo: "manov7723-sys/deepagent",      tag: "v3.0.0",    env: "prod", label: "Once · 2026-08-15T09:00:00Z", cron: "@once 2026-08-15T09:00:00Z", enabled: true, lastRun: "—", nextRun: "Aug 15, 2026 · 09:00 UTC", lastStatus: "pending" },
  ]);
  const toggle = (id) => setSchedules((xs) => xs.map((x) => x.id === id ? { ...x, enabled: !x.enabled, nextRun: x.enabled ? "paused" : "in 15h" } : x));
  const remove = (id) => setSchedules((xs) => xs.filter((x) => x.id !== id));
  const runNow = (s) => {
    setSchedules((xs) => xs.map((x) => x.id === s.id ? { ...x, lastRun: "just now", lastStatus: "running" } : x));
    toast("Running " + s.name + " now — deploy started to " + s.env);
    setTimeout(() => setSchedules((xs) => xs.map((x) => x.id === s.id ? { ...x, lastStatus: "succeeded" } : x)), 3200);
  };
  const active = schedules.filter((s) => s.enabled).length;
  return html`
    <${PageHead} title="Scheduler" sub="Deploy later — schedule an image + env for automatic rollout. Cron runs on the agent worker; you don't need this browser open." actions=${html`<${Btn} variant="primary" icon="+" onClick=${() => setModalOpen(true)}>New schedule<//>`} />
    <div style=${{display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14}}>
      <${Stat} label="Active schedules" value=${String(active)} sub=${schedules.length + " total"} icon="◷" />
      <${Stat} label="Next run" value=${schedules.find((s) => s.enabled)?.nextRun ?? "—"} sub="soonest enabled" icon="▸" />
      <${Stat} label="Runs today" value="12" sub="succeeded: 12 · failed: 0" icon="✓" />
      <${Stat} label="Cron worker" value="live" sub="last heartbeat 4s ago" icon="◐" />
    </div>
    <${Card} title="All schedules" sub=${schedules.length + " schedule" + (schedules.length === 1 ? "" : "s")}>
      ${schedules.length === 0 ? html`
        <div class="col center" style=${{padding: 30, textAlign: "center", gap: 10}}>
          <div class="muted" style=${{fontSize: 13}}>No schedules yet.</div>
          <${Btn} variant="primary" icon="+" onClick=${() => setModalOpen(true)}>Create your first schedule<//>
        </div>` : html`
        <div class="col gap-2">
          ${schedules.map((s) => html`
            <div key=${s.id} style=${{padding: 12, background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 10, opacity: s.enabled ? 1 : 0.6}}>
              <div class="row between wrap" style=${{gap: 12, alignItems: "flex-start"}}>
                <div class="col" style=${{gap: 4, minWidth: 0, flex: 1}}>
                  <div class="row gap-2 wrap" style=${{alignItems: "center"}}>
                    <b style=${{fontSize: 14}}>${s.name}</b>
                    <${Badge} tone=${s.enabled ? "ok" : "default"}>${s.enabled ? "enabled" : "paused"}<//>
                    <${Badge} tone=${s.lastStatus === "succeeded" ? "ok" : s.lastStatus === "failed" ? "danger" : s.lastStatus === "running" ? "info" : "warn"}>last: ${s.lastStatus}<//>
                    <${Badge} tone="info">${s.env}<//>
                  </div>
                  <div class="row gap-3 wrap" style=${{fontSize: 12, color: "var(--text-muted)"}}>
                    <span class="mono">${s.repo}:${s.tag}</span>
                    <span>·</span>
                    <span>${s.label}</span>
                    <span class="mono faint" style=${{fontSize: 11}}>${s.cron}</span>
                  </div>
                  <div class="row gap-3 wrap" style=${{fontSize: 11.5, color: "var(--text-faint)", marginTop: 2}}>
                    <span>Last run: ${s.lastRun}</span>
                    <span>·</span>
                    <span>Next run: ${s.nextRun}</span>
                  </div>
                </div>
                <div class="row gap-2">
                  <${Btn} size="sm" icon="▸" onClick=${() => runNow(s)}>Run now<//>
                  <${Btn} size="sm" variant="ghost" onClick=${() => { toggle(s.id); toast(s.name + (s.enabled ? " paused" : " enabled")); }}>${s.enabled ? "Pause" : "Resume"}<//>
                  <${Btn} size="sm" variant="ghost" onClick=${() => { remove(s.id); toast(s.name + " deleted", "warn"); }}>Delete<//>
                </div>
              </div>
            </div>`)}
        </div>`}
    <//>
    <${Card} title="Recent scheduled runs" sub="Last 8">
      <${Table} headers=${["Schedule", "Env", "Started", "Duration", "Status"]} rows=${[
        ["Nightly release cut",    "prod", "9h ago",    "2m 14s", "succeeded"],
        ["Nightly release cut",    "prod", "1d 9h ago", "2m 08s", "succeeded"],
        ["Marketing site refresh", "prod", "6h ago",    "48s",    "succeeded"],
        ["Marketing site refresh", "prod", "10h ago",   "51s",    "succeeded"],
        ["Staging weekly refresh", "staging",    "5d ago",    "3m 22s", "succeeded"],
        ["Nightly release cut",    "prod", "2d 9h ago", "4m 03s", "failed"],
        ["Nightly release cut",    "prod", "3d 9h ago", "2m 11s", "succeeded"],
        ["Marketing site refresh", "prod", "14h ago",   "42s",    "succeeded"],
      ].map(([n, e, s, d, st]) => [
        html`<b>${n}</b>`,
        html`<${Badge} tone="info">${e}<//>`,
        html`<span class="faint">${s}</span>`,
        html`<span class="tnum">${d}</span>`,
        html`<${Badge} tone=${st === "succeeded" ? "ok" : "danger"}>${st}<//>`,
      ])} />
    <//>
    ${modalOpen && html`<${NewScheduleModal} proj=${proj} onClose=${() => setModalOpen(false)} onCreate=${(v) => { setSchedules((xs) => [{ id: "s" + Date.now(), ...v, lastRun: "—", nextRun: v.enabled ? "in ~15h" : "paused", lastStatus: "pending" }, ...xs]); toast('Schedule "' + v.name + '" created — next run ' + (v.enabled ? "queued" : "paused")); setModalOpen(false); }} />`}
  `;
};

const NewMonitorModal = ({ onClose, onCreate }) => {
  const [url, setUrl] = useState("https://");
  const create = () => {
    if (!url.trim() || url === "https://") return;
    onCreate({ url: url.trim(), status: "up", uptime: "100.00%", p50: "—", last: "just now" });
  };
  return html`
    <div style=${{position: "fixed", inset: 0, background: "var(--overlay)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20}} onClick=${onClose}>
      <div style=${{background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, boxShadow: "var(--shadow-lg)", maxWidth: 480, width: "100%", padding: 24}} onClick=${(e) => e.stopPropagation()}>
        <div class="row between" style=${{marginBottom: 20}}>
          <h2 style=${{fontSize: 18}}>New uptime monitor</h2>
          <${Btn} variant="ghost" size="icon" onClick=${onClose}>✕<//>
        </div>
        <div class="col gap-3">
          <${Field} label="URL to monitor" required hint="Checked from 3 regions every 60 seconds."><${Input} value=${url} onInput=${(e) => setUrl(e.target.value)} placeholder="https://api.example.com/healthz" /><//>
          <div class="row gap-2" style=${{justifyContent: "flex-end", marginTop: 8}}>
            <${Btn} variant="ghost" onClick=${onClose}>Cancel<//>
            <${Btn} variant="primary" icon="+" disabled=${!url.trim() || url === "https://"} onClick=${create}>Create monitor<//>
          </div>
        </div>
      </div>
    </div>`;
};

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
      <div style=${{minWidth: 220}}><${Field} label="Environment"><${Select} value="prod" onChange=${() => {}} options=${proj.envs.map((e) => e.key)} /><//></div>
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

// ═════════════════════════════════════════════════════════════════════
// Cloud stats page — mirrors src/app/(app)/p/[projectSlug]/stats/*
// Tabs (matches TABS in ProjectStatsClient.tsx):
//   Compute · Network · Storage · Databases · Observability · Logs
// Observability tab has:
//   KPI tiles → Cluster monitoring → CloudWatch/AzureMonitor/GCPMonitor
//   alarms panel (whichever cloud the project is on) → Prometheus + Grafana
// Logs tab has a live-ish log tail viewer (mock).
// ═════════════════════════════════════════════════════════════════════

const CLOUD_RESOURCES = {
  compute: {
    aws:   [{ name: "eks-node-01", type: "EC2 · t3.medium", region: "us-east-1a", cpu: 62, mem: 71, status: "running" },
            { name: "eks-node-02", type: "EC2 · t3.medium", region: "us-east-1b", cpu: 44, mem: 58, status: "running" },
            { name: "eks-node-03", type: "EC2 · t3.medium", region: "us-east-1c", cpu: 71, mem: 68, status: "running" }],
    azure: [{ name: "aks-syspool-000000", type: "VM · Standard_B2s", region: "centralus-1", cpu: 41, mem: 67, status: "running" },
            { name: "aks-apppool-000000", type: "VM · Standard_B2s", region: "centralus-1", cpu: 68, mem: 72, status: "running" }],
    gcp:   [{ name: "gke-node-abc123", type: "GCE · e2-standard-2", region: "us-central1-a", cpu: 55, mem: 62, status: "running" },
            { name: "gke-node-def456", type: "GCE · e2-standard-2", region: "us-central1-b", cpu: 47, mem: 60, status: "running" }],
  },
  network: {
    aws:   [{ name: "eks-lb-frontend", type: "ALB", region: "us-east-1", ingress: "3.221.87.44", conns: 142, status: "active" },
            { name: "vpc-eks-01", type: "VPC · 10.0.0.0/16", region: "us-east-1", ingress: "—", conns: 6, status: "active" }],
    azure: [{ name: "aks-lb-standard", type: "Load Balancer", region: "centralus", ingress: "20.83.14.220", conns: 108, status: "active" },
            { name: "aks-vnet", type: "VNet · 10.100.0.0/16", region: "centralus", ingress: "—", conns: 4, status: "active" }],
    gcp:   [{ name: "gke-ingress", type: "HTTP(S) LB", region: "global", ingress: "34.117.198.44", conns: 89, status: "active" },
            { name: "gke-vpc-default", type: "VPC · auto", region: "global", ingress: "—", conns: 5, status: "active" }],
  },
  storage: {
    aws:   [{ name: "app-uploads", type: "S3", region: "us-east-1", size: "412 GB", conns: 0, status: "available" },
            { name: "eks-tfstate", type: "S3", region: "us-east-1", size: "8 MB", conns: 0, status: "available" }],
    azure: [{ name: "tfstate1772", type: "Storage Account", region: "centralus", size: "6 MB", conns: 0, status: "available" },
            { name: "appdata", type: "Storage Account", region: "centralus", size: "128 GB", conns: 0, status: "available" }],
    gcp:   [{ name: "app-uploads-prod", type: "GCS", region: "us-central1", size: "289 GB", conns: 0, status: "available" }],
  },
  data: {
    aws:   [{ name: "app-postgres", type: "RDS Postgres 16", region: "us-east-1", size: "db.t3.medium", conns: 24, status: "available" }],
    azure: [{ name: "app-cosmos", type: "Cosmos DB", region: "centralus", size: "400 RU/s", conns: 12, status: "available" }],
    gcp:   [{ name: "app-cloudsql", type: "Cloud SQL · Postgres 16", region: "us-central1", size: "db-custom-2", conns: 18, status: "available" }],
  },
};

const CloudTabPanel = ({ proj, cat }) => {
  const resources = CLOUD_RESOURCES[cat]?.[proj.cloud] || [];
  if (resources.length === 0) return html`<${Card}><div class="muted" style=${{padding: 40, textAlign: "center", fontSize: 13}}>No ${cat} resources synced from ${proj.cloudLabel} yet. Click Refresh to pull them.</div><//>`;
  return html`
    <${TileGrid} minTile=${340}>
      ${resources.map((r) => html`
        <${Card}>
          <div class="row between" style=${{alignItems: "flex-start"}}>
            <div class="col" style=${{gap: 3, minWidth: 0}}>
              <b class="mono" style=${{fontSize: 13.5}}>${r.name}</b>
              <span class="faint" style=${{fontSize: 12}}>${r.type} · ${r.region}</span>
            </div>
            <${Badge} tone=${r.status === "running" || r.status === "active" || r.status === "available" ? "ok" : "warn"}>${r.status}<//>
          </div>
          ${cat === "compute" && html`
            <div class="col gap-2" style=${{marginTop: 14}}>
              ${[["CPU", r.cpu, "var(--accent)"], ["Memory", r.mem, "var(--info)"]].map(([label, val, color]) => html`
                <div class="col gap-1">
                  <div class="row between" style=${{fontSize: 12}}><span class="muted">${label}</span><span class="mono">${val}%</span></div>
                  <div style=${{height: 6, background: "var(--surface-3)", borderRadius: 999}}><div style=${{width: val + "%", height: "100%", background: color, borderRadius: 999}}></div></div>
                </div>`)}
            </div>`}
          ${cat === "network" && r.ingress !== "—" && html`
            <div style=${{marginTop: 12, padding: "8px 10px", background: "var(--surface-2)", borderRadius: 8, fontSize: 12}}>
              <div class="row between"><span class="muted">Public IP</span><span class="mono">${r.ingress}</span></div>
              <div class="row between" style=${{marginTop: 3}}><span class="muted">Active conns</span><span class="mono" style=${{fontWeight: 700}}>${r.conns}</span></div>
            </div>`}
          ${cat === "storage" && html`
            <div style=${{marginTop: 12, padding: "8px 10px", background: "var(--surface-2)", borderRadius: 8, fontSize: 12}}>
              <div class="row between"><span class="muted">Used</span><span class="mono" style=${{fontWeight: 700}}>${r.size}</span></div>
            </div>`}
          ${cat === "data" && html`
            <div style=${{marginTop: 12, padding: "8px 10px", background: "var(--surface-2)", borderRadius: 8, fontSize: 12}}>
              <div class="row between"><span class="muted">Instance</span><span class="mono">${r.size}</span></div>
              <div class="row between" style=${{marginTop: 3}}><span class="muted">Active conns</span><span class="mono" style=${{fontWeight: 700}}>${r.conns}</span></div>
            </div>`}
        <//>`)}
    <//>`;
};

const CLOUD_ALARM_META = {
  aws:   { name: "CloudWatch alarms",   sub: "EKS node alarms (CPU, status check, memory, disk) → SNS email + Alerts tab.", tint: "oklch(0.72 0.19 45 / 0.2)", tintFg: "oklch(0.72 0.19 45)", label: "CW" },
  azure: { name: "Azure Monitor alarms", sub: "AKS node alarms (CPU %, disk, memory, restart) → Action Group email + Alerts tab.", tint: "oklch(0.7 0.17 235 / 0.2)", tintFg: "oklch(0.7 0.17 235)", label: "AM" },
  gcp:   { name: "GCP Monitor alarms",  sub: "GKE node alarms (CPU, memory, disk, restarts) → Notification Channels + Alerts tab.", tint: "oklch(0.74 0.17 158 / 0.2)", tintFg: "oklch(0.74 0.17 158)", label: "GM" },
};

const CloudAlarmsPanel = ({ proj }) => {
  const toast = useToast();
  const meta = CLOUD_ALARM_META[proj.cloud];
  const [setupOpen, setSetupOpen] = useState(false);
  const [emailInput, setEmailInput] = useState("oncall@example.com");
  const [alarms, setAlarms] = useState([
    { name: proj.clusterName + "-node-cpu-high", metric: "CPU utilization", threshold: "> 80% for 5m", state: "OK", target: proj.clusterName + " · systempool" },
    { name: proj.clusterName + "-node-memory-high", metric: "Memory pressure", threshold: "> 85% for 5m", state: "OK", target: proj.clusterName + " · systempool" },
    { name: proj.clusterName + "-node-disk-space", metric: "Disk utilization", threshold: "> 90%", state: "IN_ALARM", target: proj.clusterName + " · apppool" },
    { name: proj.clusterName + "-pod-restart-burst", metric: "Pod restarts", threshold: "> 5 in 5m", state: "OK", target: proj.clusterName + " · default namespace" },
  ]);
  const stateTone = { OK: "ok", IN_ALARM: "danger", INSUFFICIENT_DATA: "warn" };
  return html`
    <${Card} title=${meta.name} sub=${meta.sub} actions=${html`
      <div class="row gap-2" style=${{alignItems: "center"}}>
        <${Badge} tone="ok">${alarms.filter((a) => a.state === "OK").length} OK<//>
        ${alarms.filter((a) => a.state === "IN_ALARM").length > 0 && html`<${Badge} tone="danger">${alarms.filter((a) => a.state === "IN_ALARM").length} FIRING<//>`}
        <${Btn} size="sm" icon="⚙" onClick=${() => setSetupOpen(!setupOpen)}>${setupOpen ? "Hide setup" : "Configure"}<//>
      </div>`}>
      ${setupOpen && html`
        <div style=${{padding: 14, background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 10, marginBottom: 14}}>
          <div class="col gap-3">
            <${Field} label="Notification email" hint="A single address subscribed to the alarm topic. Change here anytime; existing alarms re-point automatically.">
              <${Input} value=${emailInput} onInput=${(e) => setEmailInput(e.target.value)} />
            <//>
            <${Field} label="Cluster">
              <${Select} value=${proj.clusterName} onChange=${() => {}} options=${[proj.clusterName]} />
            <//>
            <div class="row gap-2">
              <${Btn} variant="primary" icon="✓" onClick=${() => { toast("4 alarms provisioned to " + meta.label + " → email " + emailInput); setSetupOpen(false); }}>Set up alarms<//>
              <${Btn} onClick=${() => setSetupOpen(false)}>Cancel<//>
            </div>
          </div>
        </div>`}
      <div class="col gap-2">
        ${alarms.map((a) => html`
          <div style=${{padding: 12, background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 10}}>
            <div class="row between wrap" style=${{gap: 8}}>
              <div class="col" style=${{gap: 3, minWidth: 0}}>
                <div class="row gap-2" style=${{alignItems: "center"}}>
                  <span style=${{width: 26, height: 26, borderRadius: 7, background: meta.tint, color: meta.tintFg, display: "flex", alignItems: "center", justifyContent: "center", fontSize: 9, fontWeight: 800, flex: "none"}}>${meta.label}</span>
                  <b class="mono" style=${{fontSize: 13}}>${a.name}</b>
                  <${Badge} tone=${stateTone[a.state]}>${a.state}<//>
                </div>
                <div class="faint mono" style=${{fontSize: 11.5}}>${a.metric} · ${a.threshold} · ${a.target}</div>
              </div>
              <div class="row gap-1">
                ${a.state === "IN_ALARM" ? html`<${Btn} size="sm" onClick=${() => toast("Opening runbook for " + a.name)}>Investigate<//>` : ""}
                <${Btn} size="sm" variant="ghost" onClick=${() => toast("Editing " + a.name)}>Edit<//>
              </div>
            </div>
          </div>`)}
      </div>
    <//>`;
};

const LOG_STREAMS = [
  { pod: "app-frontend-7f9c8b-xk2vp",  namespace: "default",     source: "container/app" },
  { pod: "app-frontend-7f9c8b-qm44s",  namespace: "default",     source: "container/app" },
  { pod: "worker-6bc4d2-r7f92",        namespace: "default",     source: "container/worker" },
  { pod: "api-59d84fd-9tpnx",          namespace: "default",     source: "container/api" },
  { pod: "coredns-6d4b75cb6d-abc12",   namespace: "kube-system", source: "container/coredns" },
];

const LOG_LEVELS = ["INFO", "WARN", "ERROR", "DEBUG"];
const LOG_TEMPLATES = [
  "HTTP 200 GET /api/health responded in {ms}ms",
  "HTTP 200 GET /api/users?limit=50 responded in {ms}ms",
  "HTTP 201 POST /api/orders responded in {ms}ms",
  "processed message id=msg_{id} in {ms}ms",
  "cache hit for key user:{id}",
  "background worker picked up job id=job_{id}",
  "connected to Postgres pool (idle={ms}, active={id})",
  "HTTP 404 GET /api/orders/{id} not found",
  "slow query detected: 'select … from users where …' took {ms}ms",
  "readiness probe passed",
];

const ClusterLogsPanel = ({ proj }) => {
  const toast = useToast();
  const [level, setLevel] = useState("all");
  const [stream, setStream] = useState("all");
  const [text, setText] = useState("");
  const [paused, setPaused] = useState(false);
  const [lines, setLines] = useState(() => {
    const out = [];
    for (let i = 0; i < 40; i++) {
      const s = LOG_STREAMS[i % LOG_STREAMS.length];
      const lvl = i % 11 === 0 ? "ERROR" : i % 7 === 0 ? "WARN" : "INFO";
      const tpl = LOG_TEMPLATES[i % LOG_TEMPLATES.length];
      const msg = tpl.replace(/\{ms\}/g, String(Math.floor(20 + ((i * 37) % 380)))).replace(/\{id\}/g, String(1000 + i));
      out.push({ ts: new Date(Date.now() - (40 - i) * 4000).toISOString().slice(11, 19), pod: s.pod, ns: s.namespace, level: lvl, msg });
    }
    return out;
  });
  useEffect(() => {
    if (paused) return;
    const t = setInterval(() => {
      setLines((prev) => {
        const s = LOG_STREAMS[Math.floor(prev.length % LOG_STREAMS.length)];
        const lvl = Math.random() < 0.06 ? "ERROR" : Math.random() < 0.15 ? "WARN" : "INFO";
        const tpl = LOG_TEMPLATES[Math.floor(Math.random() * LOG_TEMPLATES.length)];
        const msg = tpl.replace(/\{ms\}/g, String(Math.floor(20 + Math.random() * 380))).replace(/\{id\}/g, String(Math.floor(Math.random() * 9000)));
        return [...prev.slice(-99), { ts: new Date().toISOString().slice(11, 19), pod: s.pod, ns: s.namespace, level: lvl, msg }];
      });
    }, 1600);
    return () => clearInterval(t);
  }, [paused]);
  const filtered = lines.filter((l) => (level === "all" || l.level === level) && (stream === "all" || l.pod === stream) && (!text || l.msg.toLowerCase().includes(text.toLowerCase()) || l.pod.toLowerCase().includes(text.toLowerCase())));
  const lvlColor = { INFO: "var(--info)", WARN: "var(--warn)", ERROR: "var(--danger)", DEBUG: "var(--text-faint)" };
  return html`
    <${Card} title="Cluster logs" sub=${"Live tail from " + proj.clusterName + " · " + LOG_STREAMS.length + " streams · retention 7d"}
      actions=${html`<div class="row gap-2" style=${{alignItems: "center"}}><${Dot} tone=${paused ? "warn" : "ok"} /><span class="faint" style=${{fontSize: 12}}>${paused ? "paused" : "streaming"}</span><${Btn} size="sm" icon=${paused ? "▸" : "⏸"} onClick=${() => setPaused(!paused)}>${paused ? "Resume" : "Pause"}<//><${Btn} size="sm" icon="↓" onClick=${() => toast("Downloading last 10k lines…")}>Export<//></div>`}>
      <div class="row gap-2 wrap" style=${{marginBottom: 12}}>
        <div style=${{minWidth: 140}}><${Select} value=${level} onChange=${setLevel} options=${["all", ...LOG_LEVELS]} /></div>
        <div style=${{minWidth: 220}}><${Select} value=${stream} onChange=${setStream} options=${["all", ...LOG_STREAMS.map((s) => s.pod)]} /></div>
        <div style=${{flex: 1, minWidth: 220}}><${Input} value=${text} onInput=${(e) => setText(e.target.value)} placeholder="Filter (e.g. 500, /api/users, error)" /></div>
      </div>
      <div style=${{background: "#0a0d14", border: "1px solid var(--border)", borderRadius: 10, padding: 10, maxHeight: 460, overflowY: "auto", fontFamily: "var(--font-mono)", fontSize: 12, lineHeight: 1.55}}>
        ${filtered.length === 0 ? html`<div style=${{padding: 20, textAlign: "center", color: "var(--text-faint)", fontSize: 12}}>No log lines match the filter.</div>` : filtered.slice(-100).map((l, i) => html`
          <div key=${i} style=${{padding: "2px 6px", display: "grid", gridTemplateColumns: "70px 60px 210px 1fr", gap: 10, borderRadius: 4, whiteSpace: "nowrap"}}>
            <span style=${{color: "#7c8598"}}>${l.ts}</span>
            <span style=${{color: lvlColor[l.level] || "#9ca3af", fontWeight: 700}}>${l.level}</span>
            <span style=${{color: "#a5b4fc", overflow: "hidden", textOverflow: "ellipsis"}}>${l.pod}</span>
            <span style=${{color: "#e2e8f0", overflow: "hidden", textOverflow: "ellipsis"}}>${l.msg}</span>
          </div>`)}
      </div>
    <//>`;
};

const StatsPage = () => {
  const proj = useProject();
  const toast = useToast();
  const [tab, setTab] = useState("compute");
  const [envFilter, setEnvFilter] = useState("prod");
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
  const TABS = [
    { key: "compute", label: "Compute" },
    { key: "network", label: "Network" },
    { key: "storage", label: "Storage" },
    { key: "data",    label: "Databases" },
    { key: "observability", label: "Observability" },
    { key: "logs",    label: "Logs" },
  ];
  return html`
    <${PageHead} title="Cloud stats" sub=${"Live nodes from " + proj.clusterName + " · " + proj.cloudLabel + " · " + CLOUD_ALARM_META[proj.cloud].label + " alarms wired"} actions=${html`<${Btn} variant="outline" icon="↻" onClick=${() => toast("Syncing cluster inventory from " + proj.cloudLabel + "…")}>Refresh from cloud<//>`} />
    <div class="row gap-2 wrap" style=${{alignItems: "center"}}>
      ${TABS.map((t) => html`<${Chip} active=${tab === t.key} onClick=${() => setTab(t.key)}>${t.label}<//>`)}
      <div class="row gap-2" style=${{marginLeft: "auto"}}>
        ${["all", ...proj.envs.map((e) => e.key)].map((e) => html`<${Chip} active=${envFilter === e} onClick=${() => setEnvFilter(e)}>${e}<//>`)}
      </div>
    </div>

    ${(tab === "compute" || tab === "network" || tab === "storage" || tab === "data") && html`<${CloudTabPanel} proj=${proj} cat=${tab} />`}

    ${tab === "logs" && html`<${ClusterLogsPanel} proj=${proj} />`}

    ${tab === "observability" && html`<${ObservabilityTab} proj=${proj} />`}
  `;
};

// ═════════════════════════════════════════════════════════════════════
// Observability tab — verbatim clone of src/components/domain/
// ClusterMonitoringPanel + PrometheusMetricsPanel + AppHealthPanel +
// AppMetricsScrapeForm as they render in the LIVE app. Sections below
// map 1:1 to the live component tree.
// ═════════════════════════════════════════════════════════════════════

// Small sparkline helper reused by every metric card.
const Spark = ({ data, w = 200, h = 40, tone = "var(--accent)" }) => {
  if (!data || data.length < 2) return html`<div style=${{height: h}}></div>`;
  const max = Math.max(...data), min = Math.min(...data);
  const range = max - min || 1;
  const step = w / (data.length - 1);
  const pts = data.map((v, i) => (i * step) + "," + (h - ((v - min) / range) * (h - 4) - 2)).join(" ");
  const areaPts = "0," + h + " " + pts + " " + w + "," + h;
  return html`
    <svg viewBox="0 0 ${w} ${h}" style=${{width: "100%", height: h, display: "block"}} preserveAspectRatio="none">
      <polygon points=${areaPts} fill=${tone} opacity="0.15" />
      <polyline points=${pts} fill="none" stroke=${tone} stroke-width="1.8" />
    </svg>`;
};

// Small preset-metric card with big value + sparkline (mirrors PrometheusMetricsPanel row).
const MetricCard = ({ label, value, unit, tone = "var(--accent)", data }) => html`
  <div style=${{padding: 14, background: "var(--surface)", border: "1px solid var(--border-soft)", borderRadius: 10}}>
    <div class="faint" style=${{fontSize: 11.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em"}}>${label}</div>
    <div class="row gap-1" style=${{alignItems: "baseline", marginTop: 4, marginBottom: 8}}>
      <span class="tnum" style=${{fontSize: 22, fontWeight: 800, letterSpacing: "-.02em"}}>${value}</span>
      ${unit && html`<span class="faint" style=${{fontSize: 12}}>${unit}</span>`}
    </div>
    <${Spark} data=${data} tone=${tone} />
  </div>`;

const InClusterMonitoringBlock = ({ proj, activeEnv, setActiveEnv, status }) => {
  const toast = useToast();
  const [installing, setInstalling] = useState(false);
  const install = () => {
    setInstalling(true);
    toast("Installing kube-prometheus-stack + Loki into " + activeEnv + "'s cluster via Helm…");
    // In the live app this poll flips to "live" after ~2-5min. Wireframe: 4s.
    setTimeout(() => { setInstalling(false); toast("Prometheus + Grafana + Loki ready in " + activeEnv, "ok"); }, 4000);
  };
  const ready = status === "live" && !installing;
  return html`
    <${Card} title="In-cluster monitoring" sub="kube-prometheus-stack runs inside this environment's cluster — installed and queried entirely by the app."
      actions=${html`
        <div class="row gap-2" style=${{alignItems: "center"}}>
          <${Dot} tone=${ready ? "ok" : installing ? "warn" : "danger"} />
          <span class="faint" style=${{fontSize: 12}}>${installing ? "installing…" : ready ? "live" : "not installed"}</span>
        </div>`}>
      <div class="col gap-3">
        <div class="row gap-2 wrap">
          ${proj.envs.map((e) => html`
            <${Chip} active=${e.key === activeEnv} onClick=${() => setActiveEnv(e.key)}>
              ${e.name}${!e.cluster && html`<span class="faint" style=${{fontSize: 11, marginLeft: 4}}>· no cluster</span>`}
            <//>`)}
        </div>
        ${!ready && !installing && html`
          <span class="muted" style=${{fontSize: 13, lineHeight: 1.6}}>
            Click below and the app deploys Prometheus + Grafana + Loki (logs) into <b>${activeEnv}</b>'s cluster via Helm,
            and auto-provisions a dashboard scoped to this application. Runs as pods in your cluster (not on our servers,
            not exposed publicly) and is shown in-app through the cluster connection. Pods come up over ~2–5 minutes.
          </span>`}
        ${installing && html`
          <div class="col gap-1">
            <span style=${{fontSize: 13}}>⏳ Installing kube-prometheus-stack…</span>
            <span class="muted" style=${{fontSize: 12.5}}>Installing Prometheus + Grafana + Loki via Helm into <b>${activeEnv}</b>'s cluster. You can leave this page; it keeps running. The panel updates on its own.</span>
          </div>`}
        <div class="row gap-2">
          <${Btn} variant=${ready ? "outline" : "primary"} icon="↓" loading=${installing} onClick=${install}>
            ${installing ? "Installing…" : ready ? "Re-run / upgrade" : "Install monitoring"}
          <//>
        </div>
      </div>
    <//>`;
};

const AppHealthPanel = ({ namespace }) => {
  // Mirrors src/components/domain/AppHealthPanel.tsx — "Is my app up?" plain-
  // language view: each app shows Available/Degraded/Down.
  const apps = [
    { name: "app-frontend", kind: "Deployment", desired: 2, ready: 2, status: "available" },
    { name: "worker",       kind: "Deployment", desired: 1, ready: 1, status: "available" },
    { name: "api",          kind: "Deployment", desired: 2, ready: 1, status: "degraded" },
  ];
  const tone = { available: "ok", degraded: "warn", down: "danger" };
  const label = { available: "Available", degraded: "Degraded", down: "Down" };
  return html`
    <${Card} title="App health" sub=${'Is my app up? — plain-language view of workloads in namespace "' + namespace + '".'}
      actions=${html`<span class="faint" style=${{fontSize: 12}}>Polls every 15s</span>`}>
      <div class="col gap-2">
        ${apps.map((a) => html`
          <div class="row between" style=${{padding: "10px 12px", background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 8, alignItems: "center"}}>
            <div class="col" style=${{gap: 2}}>
              <b class="mono" style=${{fontSize: 13.5}}>${a.name}</b>
              <span class="faint" style=${{fontSize: 11.5}}>${a.kind} · ${a.ready}/${a.desired} replicas ready</span>
            </div>
            <div class="row gap-2" style=${{alignItems: "center"}}>
              <${Dot} tone=${tone[a.status]} />
              <${Badge} tone=${tone[a.status]}>${label[a.status]}<//>
            </div>
          </div>`)}
      </div>
    <//>`;
};

const ScopeBlock = ({ namespace, setNamespace, workload, setWorkload, namespaces }) => html`
  <${Card} title="Scope" sub=${'Locked to namespace "' + namespace + '"' + (workload ? ', workload "' + workload + '"' : "") + ' — metrics, logs and Grafana all scope to it.'}>
    <div class="row gap-3 wrap">
      <div style=${{minWidth: 220}}>
        <${Field} label="Namespace (lock)" hint="The embedded Grafana logs + metrics follow this namespace.">
          <${Select} value=${namespace} onChange=${setNamespace} options=${namespaces} />
        <//>
      </div>
      <div style=${{minWidth: 220, flex: 1}}>
        <${Field} label="Workload (optional)" hint="Deployment / Helm release name. Blank = whole namespace.">
          <${Input} value=${workload} onInput=${(e) => setWorkload(e.target.value)} placeholder="all workloads" />
        <//>
      </div>
    </div>
  <//>`;

const PodMetricsPanel = ({ namespace, workload }) => {
  // Mirrors PrometheusMetricsPanel "Pod metrics (resources)" with appPresets().
  const presets = [
    { key: "cpu",      label: "CPU cores",      value: "0.42",  unit: "cores", tone: "var(--accent)", data: genSeries(11, 0.42, 0.15, 0) },
    { key: "mem",      label: "Memory (GiB)",   value: "1.28",  unit: "GiB",   tone: "var(--info)",   data: genSeries(12, 1.28, 0.35, 0) },
    { key: "pods",     label: "Running pods",   value: "5",     unit: "",      tone: "var(--ok)",     data: genSeries(13, 5, 0.6, 0) },
    { key: "ready",    label: "Replicas ready", value: "5",     unit: "",      tone: "var(--ok)",     data: genSeries(14, 5, 0.4, 0) },
    { key: "restarts", label: "Restarts (1h)",  value: "0",     unit: "",      tone: "var(--warn)",   data: genSeries(15, 0.3, 0.5, 0) },
  ];
  return html`
    <${Card} title="Pod metrics (resources)" sub=${'From in-cluster Prometheus (namespace "' + namespace + '"' + (workload ? ", workload " + workload : "") + ")"}
      actions=${html`<span class="row gap-2" style=${{alignItems: "center"}}><${Dot} tone="ok" /><span class="faint" style=${{fontSize: 12}}>scraping · 8s ago</span></span>`}>
      <div style=${{display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12}}>
        ${presets.map((p) => html`<${MetricCard} ...${p} />`)}
      </div>
    <//>`;
};

const ServiceMetricsPanel = ({ namespace }) => {
  const toast = useToast();
  const [query, setQuery] = useState("");
  const [runResult, setRunResult] = useState(null);
  const friendly = [
    { label: "Running pods",                   q: 'count(kube_pod_status_phase{namespace="' + namespace + '",phase="Running"})', unit: "pods" },
    { label: "Pod restarts (1h)",              q: 'sum(increase(kube_pod_container_status_restarts_total{namespace="' + namespace + '"}[1h]))' },
    { label: "CPU used",                       q: 'sum(rate(container_cpu_usage_seconds_total{namespace="' + namespace + '"}[5m]))', unit: "cores" },
    { label: "Memory used",                    q: 'sum(container_memory_working_set_bytes{namespace="' + namespace + '"}) / 1024^2', unit: "MiB" },
    { label: "Total requests",                 q: 'sum(http_requests_total{namespace="' + namespace + '"})' },
    { label: "Request rate",                   q: 'sum(rate(http_requests_total{namespace="' + namespace + '"}[5m]))', unit: "req/s" },
    { label: "Error rate (5xx)",               q: 'sum(rate(http_requests_total{namespace="' + namespace + '",status=~"5.."}[5m]))', unit: "req/s" },
    { label: "p95 latency",                    q: 'histogram_quantile(0.95, sum(rate(http_request_duration_seconds_bucket{namespace="' + namespace + '"}[5m])) by (le))', unit: "s" },
    { label: "Apps being monitored",           q: 'count(up{namespace="' + namespace + '"} == 1)' },
  ];
  const presets = [
    { key: "up",     label: "Targets up",           value: "6",    unit: "",     tone: "var(--ok)",     data: genSeries(21, 6, 0.5, 0) },
    { key: "req",    label: "Request rate (req/s)", value: "128",  unit: "/s",   tone: "var(--accent)", data: genSeries(22, 128, 22, 60) },
    { key: "err",    label: "5xx errors (req/s)",   value: "0.4",  unit: "/s",   tone: "var(--danger)", data: genSeries(23, 0.4, 0.3, 0) },
    { key: "p95",    label: "p95 latency (s)",      value: "0.32", unit: "s",    tone: "var(--warn)",   data: genSeries(24, 0.32, 0.08, 0.1) },
    { key: "appcpu", label: "App CPU (cores)",      value: "0.18", unit: "cores",tone: "var(--info)",   data: genSeries(25, 0.18, 0.06, 0) },
    { key: "appmem", label: "App memory (MiB)",     value: "218",  unit: "MiB",  tone: "var(--accent)", data: genSeries(26, 218, 24, 100) },
  ];
  const runQuery = (q) => {
    setQuery(q);
    setRunResult({ query: q, sample: (Math.random() * 100).toFixed(2), at: new Date().toISOString().slice(11, 19) });
    toast("PromQL executed against in-cluster Prometheus");
  };
  return html`
    <${Card} title="Service metrics (app)" sub=${"From the app's scraped /metrics (namespace \"" + namespace + "\")"}
      actions=${html`<span class="row gap-2" style=${{alignItems: "center"}}><${Dot} tone="ok" /><span class="faint" style=${{fontSize: 12}}>live</span></span>`}>
      <div style=${{display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 12, marginBottom: 14}}>
        ${presets.map((p) => html`<${MetricCard} ...${p} />`)}
      </div>
      <div style=${{marginTop: 10, padding: 12, background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 10}}>
        <div class="faint" style=${{fontSize: 11.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", marginBottom: 8}}>Query Prometheus</div>
        <div class="row gap-2" style=${{marginBottom: 10}}>
          <div style=${{flex: 1}}><${Input} value=${query} onInput=${(e) => setQuery(e.target.value)} placeholder='e.g. up{namespace="default"}' /></div>
          <${Btn} variant="primary" icon="▸" onClick=${() => runQuery(query || 'up{namespace="' + namespace + '"}')}>Run<//>
        </div>
        ${runResult && html`
          <div class="mono" style=${{background: "#0a0d14", color: "#e2e8f0", padding: 10, borderRadius: 6, fontSize: 12, marginBottom: 10}}>
            <div style=${{color: "#7c8598"}}>${runResult.at} → query executed</div>
            <div>${runResult.query}</div>
            <div style=${{marginTop: 4}}>result: <span style=${{color: "#a5b4fc"}}>${runResult.sample}</span></div>
          </div>`}
        <div class="faint" style=${{fontSize: 11, marginBottom: 6}}>Plain-language questions (click to run):</div>
        <div class="row gap-2 wrap">
          ${friendly.map((f) => html`<${Chip} onClick=${() => runQuery(f.q)}>${f.label}<//>`)}
        </div>
      </div>
    <//>`;
};

const AppMetricsScrapeForm = ({ namespace }) => {
  const toast = useToast();
  const [kind, setKind] = useState("ServiceMonitor");
  const [target, setTarget] = useState("app-frontend");
  const [port, setPort] = useState("metrics");
  const [path, setPath] = useState("/metrics");
  return html`
    <${Card} title="Add scrape target" sub=${"Create a " + kind + " so in-cluster Prometheus scrapes the app's own /metrics endpoint (request rate, latency, custom metrics)."}>
      <div class="col gap-3">
        <div class="row gap-2 wrap">
          <${Chip} active=${kind === "ServiceMonitor"} onClick=${() => setKind("ServiceMonitor")}>ServiceMonitor<//>
          <${Chip} active=${kind === "PodMonitor"} onClick=${() => setKind("PodMonitor")}>PodMonitor<//>
        </div>
        <div class="row gap-3 wrap">
          <div style=${{flex: 1, minWidth: 200}}><${Field} label="Target (Service / Deployment)"><${Input} value=${target} onInput=${(e) => setTarget(e.target.value)} /><//></div>
          <div style=${{minWidth: 120}}><${Field} label="Port"><${Input} value=${port} onInput=${(e) => setPort(e.target.value)} /><//></div>
          <div style=${{minWidth: 140}}><${Field} label="Path"><${Input} value=${path} onInput=${(e) => setPath(e.target.value)} /><//></div>
        </div>
        <div class="row gap-2">
          <${Btn} variant="primary" icon="+" onClick=${() => toast(kind + "/" + target + " applied to namespace " + namespace)}>Create ${kind}<//>
          <${Btn} onClick=${() => toast("Rendered YAML — check the Terraform/K8s tab")}>Preview YAML<//>
        </div>
      </div>
    <//>`;
};

const GrafanaEmbed = ({ namespace }) => {
  const toast = useToast();
  const panels = [
    { title: "CPU usage",   value: "0.42 cores", data: genSeries(31, 0.42, 0.15, 0), tone: "var(--accent)" },
    { title: "Memory",      value: "1.28 GiB",   data: genSeries(32, 1.28, 0.35, 0), tone: "var(--info)" },
    { title: "Request rate", value: "128 req/s", data: genSeries(33, 128, 22, 60),   tone: "var(--ok)" },
    { title: "p95 latency", value: "0.32 s",     data: genSeries(34, 0.32, 0.08, 0.1),tone: "var(--warn)" },
  ];
  return html`
    <${Card} title="Grafana" sub=${'Live Grafana dashboard for this application — metrics and logs (embedded via reverse proxy from the in-cluster Grafana in namespace "' + namespace + '").'}
      actions=${html`<${Btn} size="sm" icon="↗" onClick=${() => toast("Opening full Grafana in a new tab…")}>Open full Grafana<//>`}>
      <div style=${{background: "#181b1f", border: "1px solid var(--border)", borderRadius: 10, padding: 14}}>
        <div class="row gap-2" style=${{alignItems: "center", marginBottom: 12, padding: "6px 10px", background: "#22252a", borderRadius: 6}}>
          <span style=${{width: 22, height: 22, borderRadius: 4, background: "linear-gradient(135deg, #ff9830, #f05a28)", display: "flex", alignItems: "center", justifyContent: "center", color: "#fff", fontWeight: 800, fontSize: 11}}>G</span>
          <span style=${{color: "#e2e8f0", fontSize: 13, fontWeight: 600}}>Application dashboard</span>
          <span style=${{color: "#8b95a5", fontSize: 11, marginLeft: 8}}>namespace=${namespace}</span>
          <span style=${{marginLeft: "auto", color: "#8b95a5", fontSize: 11}}>Last 6 hours · Refresh 30s</span>
        </div>
        <div style=${{display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10}}>
          ${panels.map((p) => html`
            <div style=${{padding: 12, background: "#22252a", borderRadius: 6}}>
              <div class="row between" style=${{marginBottom: 8}}>
                <span style=${{color: "#e2e8f0", fontSize: 12, fontWeight: 600}}>${p.title}</span>
                <span style=${{color: p.tone, fontSize: 14, fontWeight: 700, fontFamily: "var(--font-mono)"}}>${p.value}</span>
              </div>
              <${Spark} data=${p.data} tone=${p.tone} h=${60} />
            </div>`)}
        </div>
        <div style=${{marginTop: 10, padding: 10, background: "#22252a", borderRadius: 6}}>
          <div style=${{color: "#e2e8f0", fontSize: 12, fontWeight: 600, marginBottom: 6}}>Logs (Loki)</div>
          <div class="mono" style=${{color: "#a5b4fc", fontSize: 11, lineHeight: 1.5}}>
            <div><span style=${{color: "#7c8598"}}>14:32:11</span> app-frontend HTTP 200 GET /api/health responded in 24ms</div>
            <div><span style=${{color: "#7c8598"}}>14:32:12</span> worker processed message id=msg_4218 in 89ms</div>
            <div><span style=${{color: "#7c8598"}}>14:32:14</span> api HTTP 200 GET /api/users?limit=50 responded in 142ms</div>
            <div><span style=${{color: "#eab308"}}>14:32:15</span> app-frontend slow query detected: took 812ms</div>
          </div>
        </div>
      </div>
    <//>`;
};

const ObservabilityTab = ({ proj }) => {
  const [activeEnv, setActiveEnv] = useState(proj.envs[0]?.key || "prod");
  // Once "installed" the wireframe stays in the "live" state so the client can
  // demo the whole panel tree. The install button in InClusterMonitoringBlock
  // toggles between not-installed → installing → live.
  const [status, setStatus] = useState("live");
  const [namespace, setNamespace] = useState("default");
  const [workload, setWorkload] = useState("");
  const namespaces = ["default", "monitoring", "kube-system", "cert-manager", "ingress-nginx"];
  const ready = status === "live";
  return html`
    <${InClusterMonitoringBlock} proj=${proj} activeEnv=${activeEnv} setActiveEnv=${setActiveEnv} status=${status} />
    ${ready && html`
      <${AppHealthPanel} namespace=${namespace} />
      <${ScopeBlock} namespace=${namespace} setNamespace=${setNamespace} workload=${workload} setWorkload=${setWorkload} namespaces=${namespaces} />
      <${PodMetricsPanel} namespace=${namespace} workload=${workload} />
      <${ServiceMetricsPanel} namespace=${namespace} />
      <${AppMetricsScrapeForm} namespace=${namespace} />
      <${GrafanaEmbed} namespace=${namespace} />
      <${CloudAlarmsPanel} proj=${proj} />
    `}
  `;
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
    images: { dev: "sha-a1b2c3d", staging: "sha-9e4f7ab", prod: "sha-7e2f8d0" },
    tags: { dev: "2m ago", staging: "12m ago", prod: "3d ago" },
    health: { dev: "healthy", staging: "healthy", prod: "healthy" },
  },
  {
    id: "api",
    name: "api",
    repo: "manov7723-sys/deepagent/api",
    lang: "TypeScript · Node.js",
    images: { dev: "sha-4d2e1fb", staging: "sha-4d2e1fb", prod: "sha-c3d4e5f" },
    tags: { dev: "8m ago", staging: "4h ago", prod: "2d ago" },
    health: { dev: "healthy", staging: "healthy", prod: "healthy" },
  },
  {
    id: "worker",
    name: "worker",
    repo: "manov7723-sys/deepagent/worker",
    lang: "Go",
    images: { dev: "sha-8b1a2c4", staging: null, prod: null },
    tags: { dev: "22m ago", staging: null, prod: null },
    health: { dev: "healthy", staging: null, prod: null },
  },
];

const PROMO_HISTORY_SEED = [
  { app: "app-frontend", from: "staging", to: "prod", image: "sha-7e2f8d0", by: "manov", when: "3d ago", status: "succeeded" },
  { app: "api", from: "dev", to: "staging", image: "sha-4d2e1fb", by: "manov", when: "4h ago", status: "succeeded" },
  { app: "api", from: "staging", to: "prod", image: "sha-c3d4e5f", by: "sriram", when: "2d ago", status: "succeeded" },
  { app: "app-frontend", from: "dev", to: "staging", image: "sha-9e4f7ab", by: "manov", when: "12m ago", status: "succeeded" },
  { app: "worker", from: "dev", to: "staging", image: "sha-e7f4b12", by: "manov", when: "6h ago", status: "failed" },
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
        ${to === "prod" && html`
          <div style=${{padding: "10px 14px", background: "var(--warn-soft)", color: "var(--warn)", borderRadius: 8, fontSize: 12.5, marginBottom: 20, display: "flex", gap: 8, alignItems: "flex-start"}}>
            <span>⚠</span>
            <span>Promoting to <b>prod</b> triggers a production deploy. Approvers on the Approvals page will be notified.</span>
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
  const toast = useToast();
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
    toast(app.name + " promoted " + from + " → " + to);
  };

  const envs = ["dev", "staging", "prod"];
  const envTone = { dev: "info", staging: "warn", prod: "danger" };
  const envSub = { dev: "development", staging: "pre-production", prod: "production" };

  return html`
    <${PageHead} title="Promotions" sub=${"Promote a deployed image between environments (dev → staging → prod) on " + proj.clusterName + "."} actions=${html`<${Btn} variant="primary" icon="+" onClick=${() => toast("Pick an app below and click → staging or → prod to promote")}>New promotion<//>`} />
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
// My Account area pages — matches src/app/(app)/u/* + src/app/(app)/account/*
// ═════════════════════════════════════════════════════════════════════
const UserDashboardPage = ({ onNav }) => {
  const toast = useToast();
  return html`
  <${PageHead} title="Welcome back, manoi" sub="Your DeepAgent workspace at a glance." actions=${html`<${Btn} variant="primary" icon=${html`<${Icon} name="plus" size=${14} />`} onClick=${() => { toast("Opening new-project wizard…"); onNav && onNav("u-projects"); }}>New project<//>`} />
  <div style=${{display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))", gap: 14}}>
    <${Stat} label="Active projects" value="3" sub="9 environments total" icon=${html`<${Icon} name="projects" size=${16} />`} />
    <${Stat} label="Deploys this month" value="312" sub="▲ 12% vs last month" icon=${html`<${Icon} name="cicd" size=${16} />`} />
    <${Stat} label="Agent runs" value="1.4k" sub="of 5k included" icon=${html`<${Icon} name="bot" size=${16} />`} />
    <${Stat} label="Cloud spend" value="$12.1k" sub="▲ 5% · across 3 projects" icon=${html`<${Icon} name="dollar" size=${16} />`} />
  </div>
  <${Card} title="Your projects" sub="3 active" actions=${html`<${Btn} variant="ghost" size="sm" onClick=${() => onNav && onNav("u-projects")}>All projects →<//>`}>
    <div class="col" style=${{gap: 0}}>
      ${Object.values(PROJECTS).map((p) => html`
        <div class="row between" style=${{padding: "12px 0", borderBottom: "1px solid var(--border-soft)", alignItems: "center"}}>
          <div class="row gap-3" style=${{alignItems: "center"}}>
            <span style=${{width: 34, height: 34, borderRadius: 9, background: "var(--accent)", color: "var(--accent-fg)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800}}>${p.cloudLabel[0]}</span>
            <div class="col" style=${{gap: 2}}>
              <b style=${{fontSize: 13.5}}>${p.name}</b>
              <span class="faint" style=${{fontSize: 12}}>${p.envs.length} envs · ${p.clusterType} · ${p.region}</span>
            </div>
          </div>
          <div class="row gap-2">
            <${Badge} tone="info">${p.cloudLabel}<//>
            <${Btn} variant="ghost" size="sm" onClick=${() => onNav && onNav("dashboard")}>Open →<//>
          </div>
        </div>`)}
    </div>
  <//>
  <div class="row gap-4 wrap" style=${{alignItems: "flex-start"}}>
    <div style=${{flex: 1, minWidth: 380}}>
      <${Card} title="Usage this cycle" sub="Resets on the 1st" actions=${html`<${Btn} variant="ghost" size="sm" onClick=${() => onNav && onNav("u-usage")}>Details →<//>`}>
        ${[
          { label: "Agent runs", used: 1420, limit: 5000, color: "var(--accent)" },
          { label: "Deploys", used: 312, limit: 1000, color: "var(--ok)" },
          { label: "Seats", used: 3, limit: 5, color: "var(--info)" },
        ].map((u) => html`
          <div class="col gap-1" style=${{marginBottom: 12}}>
            <div class="row between" style=${{fontSize: 13}}><span style=${{fontWeight: 600}}>${u.label}</span><span class="mono muted">${u.used} / ${u.limit}</span></div>
            <div style=${{height: 8, background: "var(--surface-3)", borderRadius: 999, overflow: "hidden"}}>
              <div style=${{width: (u.used/u.limit*100) + "%", height: "100%", background: u.color, borderRadius: 999}}></div>
            </div>
          </div>`)}
      <//>
    </div>
    <div style=${{flex: 1, minWidth: 320}}>
      <${Card} title="Plan" sub="Pro" actions=${html`<${Badge} tone="accent">Pro<//>`}>
        <div class="col gap-2">
          <div style=${{fontSize: 28, fontWeight: 800, letterSpacing: "-.02em"}}>$99<span class="faint" style=${{fontSize: 14, fontWeight: 500}}>/mo</span></div>
          <div class="faint" style=${{fontSize: 12.5}}>Renews Aug 14, 2026 · Visa ending 4242</div>
          <div class="row gap-2" style=${{marginTop: 8}}>
            <${Btn} variant="primary" size="sm" onClick=${() => onNav && onNav("u-subscription")}>Manage plan<//>
            <${Btn} size="sm" onClick=${() => { toast("Upgrade to Enterprise — sales contact opened"); }}>Upgrade<//>
          </div>
        </div>
      <//>
    </div>
  </div>
`;
};

const UserProjectsPage = ({ onNav }) => {
  const toast = useToast();
  const [extra, setExtra] = useState([]);
  const [modalOpen, setModalOpen] = useState(false);
  const [menuFor, setMenuFor] = useState(null);
  const [confirmDelete, setConfirmDelete] = useState(null);
  const [deleted, setDeleted] = useState(new Set());
  const all = [...Object.values(PROJECTS), ...extra].filter((p) => !deleted.has(p.slug));
  return html`
  <${PageHead} title="Projects" sub="Every product you're running on DeepAgent." actions=${html`<${Btn} variant="primary" icon=${html`<${Icon} name="plus" size=${14} />`} onClick=${() => setModalOpen(true)}>New project<//>`} />
  <${TileGrid} minTile=${300} maxTile=${420}>
    ${all.map((p) => html`
      <${Card}>
        <div class="row gap-3" style=${{alignItems: "flex-start"}}>
          <span style=${{width: 44, height: 44, borderRadius: 11, background: "var(--accent)", color: "var(--accent-fg)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 15, flex: "none"}}>${p.cloudLabel[0]}</span>
          <div class="col" style=${{gap: 3, minWidth: 0, flex: 1}}>
            <b style=${{fontSize: 14}}>${p.name}</b>
            <span class="faint" style=${{fontSize: 12, lineHeight: 1.4}}>${p.clusterType} · ${p.region}</span>
          </div>
          <div style=${{position: "relative"}}>
            <${Btn} variant="ghost" size="icon" onClick=${() => setMenuFor(menuFor === p.slug ? null : p.slug)}><${Icon} name="more" size=${16} /><//>
            ${menuFor === p.slug && html`<${DropMenu} onClose=${() => setMenuFor(null)} items=${[
              { icon: "→", label: "Open project", onSelect: () => onNav && onNav("dashboard") },
              { icon: "✎", label: "Rename",       onSelect: () => toast("Rename modal opened") },
              { icon: "⧉", label: "Duplicate",    onSelect: () => toast("Cloning " + p.name + "…") },
              { icon: "🗑", label: "Delete project", tone: "danger", onSelect: () => setConfirmDelete(p) },
            ]} />`}
          </div>
        </div>
        <div style=${{marginTop: 14, padding: "10px 12px", background: "var(--surface-2)", borderRadius: 8, fontSize: 12}}>
          <div class="row between"><span class="muted">Envs</span><span class="mono">${p.envs.length}</span></div>
          <div class="row between" style=${{marginTop: 4}}><span class="muted">Cluster</span><span class="mono">${p.clusterName}</span></div>
          <div class="row between" style=${{marginTop: 4}}><span class="muted">Monthly cost</span><span class="mono" style=${{fontWeight: 700}}>$${p.provider.cost + 900}</span></div>
        </div>
        <div class="row gap-2" style=${{marginTop: 12}}>
          <${Badge} tone="info">${p.cloudLabel}<//>
          <${Badge} tone="ok">healthy<//>
        </div>
      <//>`)}
    <${Card}>
      <div class="col center" style=${{padding: "36px 12px", textAlign: "center", gap: 10}}>
        <span style=${{width: 44, height: 44, borderRadius: 11, background: "var(--surface-3)", color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center"}}><${Icon} name="plus" size=${20} /></span>
        <div style=${{fontWeight: 700, fontSize: 14}}>New project</div>
        <div class="muted" style=${{fontSize: 12.5}}>Wire up a repo → pick a cloud → ship.</div>
        <${Btn} variant="outline" size="sm" onClick=${() => setModalOpen(true)}>Create project<//>
      </div>
    <//>
  <//>
  ${modalOpen && html`<${NewProjectModal} onClose=${() => setModalOpen(false)} onCreate=${(p) => { setExtra((x) => [...x, p]); toast('Project "' + p.name + '" created'); setModalOpen(false); }} />`}
  ${confirmDelete && html`<${ConfirmModal} title=${'Delete "' + confirmDelete.name + '"?'} description=${'This tears down every environment, disconnects the cloud provider, and archives all pipeline history. This action cannot be undone.'} confirmLabel="Delete project" requireTyping=${confirmDelete.name} onClose=${() => setConfirmDelete(null)} onConfirm=${() => { setDeleted((s) => new Set([...s, confirmDelete.slug])); toast('Project "' + confirmDelete.name + '" scheduled for deletion', "warn"); }} />`}
`;
};

const NewProjectModal = ({ onClose, onCreate }) => {
  const [name, setName] = useState("");
  const [cloud, setCloud] = useState("aws");
  const cloudLabel = { aws: "AWS", azure: "Azure", gcp: "GCP" };
  const clusterType = { aws: "EKS", azure: "AKS", gcp: "GKE" };
  const create = () => {
    if (!name.trim()) return;
    const nm = name.trim();
    onCreate({
      name: nm,
      slug: nm.toLowerCase().replace(/[^a-z0-9]+/g, "-"),
      cloud, cloudLabel: cloudLabel[cloud],
      clusterType: clusterType[cloud], region: cloud === "aws" ? "us-east-1" : cloud === "azure" ? "eastus" : "us-central1",
      clusterName: nm.toLowerCase().replace(/[^a-z0-9]+/g, "-") + "-dev",
      envs: [{ key: "prod", name: "prod", tier: "prod", cluster: null }],
      provider: { cost: 350 },
    });
  };
  return html`
    <div style=${{position: "fixed", inset: 0, background: "var(--overlay)", zIndex: 200, display: "flex", alignItems: "center", justifyContent: "center", padding: 20}} onClick=${onClose}>
      <div style=${{background: "var(--surface)", border: "1px solid var(--border)", borderRadius: 16, boxShadow: "var(--shadow-lg)", maxWidth: 520, width: "100%", padding: 24}} onClick=${(e) => e.stopPropagation()}>
        <div class="row between" style=${{marginBottom: 20}}>
          <h2 style=${{fontSize: 18}}>New project</h2>
          <${Btn} variant="ghost" size="icon" onClick=${onClose}>✕<//>
        </div>
        <div class="col gap-3">
          <${Field} label="Project name" required><${Input} value=${name} onInput=${(e) => setName(e.target.value)} placeholder="e.g. billing-api" /><//>
          <${Field} label="Target cloud">
            <div class="row gap-2 wrap">
              ${["aws", "azure", "gcp"].map((c) => html`<${Chip} active=${cloud === c} onClick=${() => setCloud(c)} icon="☁">${cloudLabel[c]}<//>`)}
            </div>
          <//>
          <div class="row gap-2" style=${{justifyContent: "flex-end", marginTop: 8}}>
            <${Btn} variant="ghost" onClick=${onClose}>Cancel<//>
            <${Btn} variant="primary" icon="+" disabled=${!name.trim()} onClick=${create}>Create project<//>
          </div>
        </div>
      </div>
    </div>`;
};

const UserTeamsPage = () => {
  const toast = useToast();
  const [inviteOpen, setInviteOpen] = useState(false);
  const [pending, setPending] = useState([
    { email: "alice@acme.com", role: "developer", project: "agent (AWS)", inviter: "manoi", expires: "6 days" },
    { email: "bob@acme.com", role: "viewer", project: "agent (Azure)", inviter: "manoi", expires: "3 days" },
  ]);
  return html`
  <${PageHead} title="Teams" sub="Members across all your DeepAgent projects." actions=${html`<${Btn} variant="primary" icon=${html`<${Icon} name="plus" size=${14} />`} onClick=${() => setInviteOpen(true)}>Invite member<//>`} />
  ${inviteOpen && html`<${InviteMemberModal} onClose=${() => setInviteOpen(false)} onInvite=${(v) => { setPending((p) => [{ email: v.email, role: v.role, project: v.projects.map((s) => PROJECTS[s]?.name).filter(Boolean).join(", "), inviter: "manoi", expires: "7 days" }, ...p]); toast("Invitation sent to " + v.email); }} />`}
  <${Card} title="Pending invitations" sub="2 pending" actions=${html`<${Badge} tone="info">2<//>`}>
    ${[
      { email: "alice@acme.com", role: "developer", project: "agent (AWS)", inviter: "manoi", expires: "6 days" },
      { email: "bob@acme.com", role: "viewer", project: "agent (Azure)", inviter: "manoi", expires: "3 days" },
    ].map((i) => html`
      <div class="row between" style=${{padding: "12px 0", borderBottom: "1px solid var(--border-soft)", alignItems: "center"}}>
        <div class="row gap-3" style=${{alignItems: "center"}}>
          <${Icon} name="mail" size=${18} />
          <div class="col" style=${{gap: 3}}>
            <b class="mono" style=${{fontSize: 13}}>${i.email}</b>
            <span class="faint" style=${{fontSize: 12}}>${i.role} · ${i.project} · by ${i.inviter} · expires in ${i.expires}</span>
          </div>
        </div>
        <div class="row gap-2">
          <${Btn} size="sm" onClick=${() => toast("Invite resent to " + i.email)}>Resend<//>
          <${Btn} size="sm" variant="ghost" onClick=${() => toast("Invite for " + i.email + " revoked", "warn")}><${Icon} name="x" size=${14} /> Revoke<//>
        </div>
      </div>`)}
  <//>
  <${Card} title="Members" sub="5 total" actions=${html`<${Badge} tone="ok">5<//>`}>
    <${Table} headers=${["Member", "Role", "Shared projects", "Last active", ""]} rows=${[
      ["manoi vv", "admin", ["agent (AWS)", "agent (GCP)", "agent (Azure)"], "just now", ""],
      ["sriram", "admin", ["agent (AWS)", "agent (Azure)"], "2h ago", ""],
      ["dev1", "developer", ["agent (AWS)"], "1d ago", ""],
      ["dev2", "viewer", ["agent (GCP)"], "3d ago", ""],
      ["alice", "developer", ["agent (Azure)"], "1w ago", ""],
    ].map(([name, role, projects, active]) => [
      html`<div class="row gap-2" style=${{alignItems: "center"}}><span style=${{width: 30, height: 30, borderRadius: "50%", background: "var(--surface-3)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 700, fontSize: 11}}>${name.split(" ").map((p) => p[0]).join("").toUpperCase()}</span><b>${name}</b></div>`,
      html`<${Badge} tone=${role === "admin" ? "accent" : role === "developer" ? "info" : "default"}>${role}<//>`,
      html`<div class="row gap-1 wrap">${projects.slice(0, 3).map((p) => html`<${Badge}>${p}<//>`)}</div>`,
      html`<span class="faint">${active}</span>`,
      html`<${Btn} variant="ghost" size="icon" onClick=${() => toast("Member " + name + " menu opened")}><${Icon} name="more" size=${14} /><//>`,
    ])} />
  <//>
`;
};

const UserSubscriptionPage = () => {
  const toast = useToast();
  const [currentPlan, setCurrentPlan] = useState({ name: "Pro", price: "$99" });
  const [changingTo, setChangingTo] = useState(null);
  const [buyingPack, setBuyingPack] = useState(null);
  return html`
  <${PageHead} title="Subscription" sub="Plan, invoices, and payment method." />
  <${Card}>
    <div class="row between wrap" style=${{gap: 20, alignItems: "center"}}>
      <div class="row gap-4" style=${{alignItems: "center", minWidth: 0}}>
        <span style=${{width: 56, height: 56, borderRadius: 14, background: "var(--accent-soft)", color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center", flex: "none"}}><${Icon} name="zap" size=${28} /></span>
        <div class="col" style=${{gap: 4, minWidth: 0}}>
          <div class="row gap-2" style=${{alignItems: "center"}}><b style=${{fontSize: 16}}>Pro</b><${Badge} tone="accent">current<//></div>
          <div style=${{fontSize: 14}}>$99/month · Renews Aug 14, 2026 · Visa •••• 4242</div>
        </div>
      </div>
      <${Btn} variant="outline" onClick=${() => document.getElementById("plans-section")?.scrollIntoView({behavior: "smooth"})}>Change plan<//>
    </div>
  <//>
  <div id="plans-section">
  <${Card} title="All plans" sub="Change at any time — billing prorates">
    <${TileGrid} minTile=${240} maxTile="1fr">
      ${[
        { name: "Starter", price: "$29", desc: "Solo builders & prototypes", features: ["3 projects", "1k agent runs/mo", "1 seat"], popular: false },
        { name: "Pro", price: "$99", desc: "Teams shipping to production", features: ["Unlimited projects", "5k agent runs/mo", "5 seats", "24/7 alerts"], popular: true },
        { name: "Enterprise", price: "Custom", desc: "SSO, audit, dedicated support", features: ["Everything in Pro", "SAML SSO", "Dedicated CSM", "SOC 2 reports"], popular: false },
      ].map((p) => {
        const isCurrent = p.name === currentPlan.name;
        return html`
        <div style=${{padding: 20, background: isCurrent ? "var(--accent-soft)" : "var(--surface)", border: isCurrent ? "2px solid var(--accent)" : "1px solid var(--border-soft)", borderRadius: 12, position: "relative"}}>
          ${p.popular && !isCurrent && html`<span style=${{position: "absolute", top: -10, right: 20, background: "var(--accent)", color: "var(--accent-fg)", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700}}>POPULAR</span>`}
          ${isCurrent && html`<span style=${{position: "absolute", top: -10, right: 20, background: "var(--ok)", color: "white", padding: "2px 8px", borderRadius: 4, fontSize: 11, fontWeight: 700}}>CURRENT</span>`}
          <div style=${{fontWeight: 800, fontSize: 15, marginBottom: 4}}>${p.name}</div>
          <div style=${{fontSize: 28, fontWeight: 800, letterSpacing: "-.02em"}}>${p.price}${p.price !== "Custom" && html`<span class="faint" style=${{fontSize: 13, fontWeight: 500}}>/mo</span>`}</div>
          <div class="muted" style=${{fontSize: 12, marginBottom: 14}}>${p.desc}</div>
          <ul style=${{listStyle: "none", padding: 0, margin: "0 0 16px", fontSize: 13}}>
            ${p.features.map((f) => html`<li class="row gap-2" style=${{padding: "3px 0", alignItems: "center"}}><${Icon} name="check" size=${12} stroke=${2.5} /><span>${f}</span></li>`)}
          </ul>
          <${Btn} variant=${isCurrent ? "outline" : "primary"} block disabled=${isCurrent} onClick=${() => p.price === "Custom" ? toast("Sales contact form opened — Enterprise pricing is bespoke") : setChangingTo(p)}>${isCurrent ? "Current plan" : p.price === "Custom" ? "Contact sales" : "Choose plan"}<//>
        </div>`;
      })}
    <//>
  <//>
  </div>
  <${Card} title="Top up agent tokens" sub="One-time purchases · never expire" actions=${html`<${Badge} tone="ok">3.6k tokens left<//>`}>
    <${TileGrid} minTile=${220} maxTile="1fr">
      ${[
        { icon: "zap", name: "100K tokens", price: "$19", desc: "+100k agent tokens" },
        { icon: "zap", name: "500K tokens", price: "$79", desc: "+500k agent tokens" },
        { icon: "zap", name: "2M tokens", price: "$249", desc: "+2M agent tokens" },
      ].map((t) => html`
        <div style=${{padding: 16, background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 10}}>
          <div class="row gap-2" style=${{alignItems: "center", marginBottom: 8}}>
            <${Icon} name=${t.icon} size=${16} />
            <b style=${{fontSize: 13.5}}>${t.name}</b>
          </div>
          <div style=${{fontSize: 20, fontWeight: 800}}>${t.price} <span class="faint" style=${{fontSize: 11}}>one-time</span></div>
          <div class="muted" style=${{fontSize: 12, marginBottom: 10}}>${t.desc}</div>
          <${Btn} variant="outline" block size="sm" onClick=${() => setBuyingPack(t)}>Buy<//>
        </div>`)}
    <//>
  <//>
  <${Card} title="Invoices" sub="3 total">
    <${Table} headers=${["Invoice", "Date", "Amount", "Status", ""]} rows=${[
      ["INV-2026-07", "Jul 14, 2026", "$99.00", html`<${Badge} tone="ok">paid<//>`, html`<div class="row gap-1"><${Btn} size="sm" variant="ghost" onClick=${() => toast("Invoice opened in new tab")}>View<//><${Btn} size="sm" variant="ghost" onClick=${() => toast("PDF downloaded")}>PDF<//></div>`],
      ["INV-2026-06", "Jun 14, 2026", "$99.00", html`<${Badge} tone="ok">paid<//>`, html`<div class="row gap-1"><${Btn} size="sm" variant="ghost" onClick=${() => toast("Invoice opened in new tab")}>View<//><${Btn} size="sm" variant="ghost" onClick=${() => toast("PDF downloaded")}>PDF<//></div>`],
      ["INV-2026-05", "May 14, 2026", "$99.00", html`<${Badge} tone="ok">paid<//>`, html`<div class="row gap-1"><${Btn} size="sm" variant="ghost" onClick=${() => toast("Invoice opened in new tab")}>View<//><${Btn} size="sm" variant="ghost" onClick=${() => toast("PDF downloaded")}>PDF<//></div>`],
    ]} />
  <//>
  <${Card} title="Payment method">
    <div class="row between" style=${{alignItems: "center"}}>
      <div class="row gap-3" style=${{alignItems: "center"}}>
        <span style=${{width: 44, height: 30, background: "linear-gradient(135deg, #1a1f71, #f7b600)", borderRadius: 6, display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontWeight: 700, fontSize: 10, letterSpacing: 1}}>VISA</span>
        <div class="col" style=${{gap: 2}}>
          <b style=${{fontSize: 13.5}}>Visa ending in 4242</b>
          <span class="faint" style=${{fontSize: 12}}>Expires 12/28</span>
        </div>
      </div>
      <${Btn} onClick=${() => toast("Stripe billing portal opened in a new tab")}>Open Stripe portal<//>
    </div>
  <//>
  ${changingTo && html`<${ChangePlanConfirmModal} plan=${changingTo} current=${currentPlan} onClose=${() => setChangingTo(null)} onConfirm=${() => { setCurrentPlan({ name: changingTo.name, price: changingTo.price }); toast("Plan switched to " + changingTo.name + " — first prorated invoice already emailed"); }} />`}
  ${buyingPack && html`<${BuyTokensModal} pack=${buyingPack} onClose=${() => setBuyingPack(null)} onBuy=${(v) => toast(v.pack + " × " + v.qty + " charged $" + v.total + " · tokens added to your account")} />`}
`;
};

const UserUsagePage = () => {
  const toast = useToast();
  return html`
  <${PageHead} title="Usage" sub="Consumption this billing cycle." actions=${html`<${Btn} onClick=${() => toast("Usage CSV export queued — email in 2 min")}>Export CSV<//>`} />
  <${TileGrid} minTile=${220} maxTile="1fr">
    ${[
      { label: "Agent runs", used: 1420, limit: 5000 },
      { label: "Deploys", used: 312, limit: 1000 },
      { label: "Seats", used: 3, limit: 5 },
      { label: "Environments", used: 9, limit: null },
    ].map((m) => {
      const pct = m.limit ? (m.used / m.limit) * 100 : null;
      const tone = pct == null ? "var(--info)" : pct >= 95 ? "var(--danger)" : pct >= 80 ? "var(--warn)" : "var(--accent)";
      return html`
        <div class="card card-pad">
          <div class="faint" style=${{fontSize: 11.5, textTransform: "uppercase", letterSpacing: ".06em", fontWeight: 700}}>${m.label}</div>
          <div style=${{fontSize: 26, fontWeight: 800, letterSpacing: "-.02em", margin: "6px 0"}}>${m.used}<span class="faint" style=${{fontSize: 14, fontWeight: 500}}> / ${m.limit == null ? "∞" : m.limit}</span></div>
          <div style=${{height: 8, background: "var(--surface-3)", borderRadius: 999, overflow: "hidden"}}>
            <div style=${{width: (pct == null ? 100 : Math.min(100, pct)) + "%", height: "100%", background: tone, borderRadius: 999}}></div>
          </div>
        </div>`;
    })}
  <//>
  <${Card} title="Agent token consumption" sub="Last 12 weeks" actions=${html`<${Badge}>12w<//>`}>
    <div style=${{height: 200, display: "flex", alignItems: "flex-end", gap: 8, padding: 20, background: "var(--surface-2)", borderRadius: 8}}>
      ${Array.from({length: 12}, (_, i) => 40 + Math.sin(i * 0.5) * 30 + i * 4).map((h, i) => html`
        <div style=${{flex: 1, background: "var(--accent)", opacity: 0.6 + (i / 12) * 0.4, borderRadius: "4px 4px 0 0", height: h + "%", position: "relative"}}></div>`)}
    </div>
    <div class="row between" style=${{marginTop: 8, fontSize: 11, color: "var(--text-muted)"}}>
      <span>12 weeks ago</span><span>Now</span>
    </div>
  <//>
`;
};

const AccountProfilePage = ({ onNav }) => {
  const toast = useToast();
  const session = { name: "manoi vv", email: "manoi@example.com", role: "Super admin", title: "Platform Engineer", memberSince: "Jan 2025" };
  return html`
    <${PageHead} title="Profile" sub="Your DeepAgent identity + connected accounts." actions=${html`<${Btn} onClick=${() => onNav("account-edit-profile")}>Edit profile<//>`} />
    <${Card}>
      <div class="row gap-4" style=${{alignItems: "center"}}>
        <div style=${{position: "relative"}}>
          <span style=${{width: 84, height: 84, borderRadius: 20, background: "var(--accent)", color: "var(--accent-fg)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 30}}>MV</span>
          <button class="btn ghost icon sm" style=${{position: "absolute", bottom: -4, right: -4, background: "var(--surface)", border: "1px solid var(--border)", borderRadius: "50%"}} onClick=${() => onNav("account-edit-profile")}><${Icon} name="edit" size=${12} /></button>
        </div>
        <div class="col" style=${{gap: 6}}>
          <div class="row gap-2" style=${{alignItems: "center"}}>
            <h2 style=${{fontSize: 22, margin: 0, letterSpacing: "-.02em"}}>${session.name}</h2>
            <${Badge} tone="accent">${session.role}<//>
          </div>
          <div class="muted" style=${{fontSize: 13}}>${session.email}</div>
          <div class="faint" style=${{fontSize: 12.5}}>${session.title} · Member since ${session.memberSince}</div>
        </div>
      </div>
    <//>
    <${Card} title="My projects" sub="First 3 shown" actions=${html`<${Btn} variant="ghost" size="sm" onClick=${() => onNav("u-projects")}>All projects →<//>`}>
      <${TileGrid} minTile=${240} maxTile=${360}>
        ${Object.values(PROJECTS).map((p) => html`
          <div style=${{padding: 14, background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 10}}>
            <div class="row gap-3" style=${{alignItems: "center"}}>
              <span style=${{width: 36, height: 36, borderRadius: 9, background: "var(--accent)", color: "var(--accent-fg)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 13, flex: "none"}}>${p.cloudLabel[0]}</span>
              <div class="col" style=${{gap: 2, minWidth: 0}}>
                <b style=${{fontSize: 13.5}}>${p.name}</b>
                <span class="faint" style=${{fontSize: 11.5}}>${p.clusterType} · ${p.region}</span>
              </div>
            </div>
          </div>`)}
      <//>
    <//>
    <${Card} title="Connected accounts" sub="OAuth sign-ins">
      ${[
        { provider: "github", label: "GitHub", handle: "manov7723-sys", connected: true },
        { provider: "gitlab", label: "GitLab", handle: null, connected: false },
      ].map((a) => html`
        <div class="row between" style=${{padding: "12px 0", borderBottom: "1px solid var(--border-soft)", alignItems: "center"}}>
          <div class="row gap-3" style=${{alignItems: "center"}}><${Icon} name=${a.provider} size=${20} /><div class="col" style=${{gap: 2}}><b style=${{fontSize: 13.5}}>${a.label}</b><span class="faint" style=${{fontSize: 12}}>${a.connected ? "@" + a.handle : "Not connected"}</span></div></div>
          ${a.connected ? html`<${Btn} size="sm" onClick=${() => toast(a.label + " disconnected", "warn")}>Disconnect<//>` : html`<${Btn} size="sm" variant="primary" onClick=${() => toast("Opening " + a.label + " sign-in…")}>Connect ${a.label}<//>`}
        </div>`)}
    <//>
    <${Card} title="Security">
      ${[
        { icon: "lock", title: "Password", desc: "Last changed 3 months ago", cta: "Change", nav: "account-change-password" },
        { icon: "shield", title: "Two-factor authentication", desc: "Enabled via authenticator app", cta: "Manage", nav: "account-2fa-manage" },
        { icon: "key", title: "Active sessions", desc: "2 devices signed in", cta: "Review", nav: null },
      ].map((s) => html`
        <div class="row between" style=${{padding: "14px 0", borderBottom: "1px solid var(--border-soft)", alignItems: "center"}}>
          <div class="row gap-3" style=${{alignItems: "center"}}>
            <span style=${{width: 36, height: 36, borderRadius: 9, background: "var(--surface-3)", color: "var(--text)", display: "flex", alignItems: "center", justifyContent: "center", flex: "none"}}><${Icon} name=${s.icon} size=${16} /></span>
            <div class="col" style=${{gap: 2}}><b style=${{fontSize: 13.5}}>${s.title}</b><span class="faint" style=${{fontSize: 12}}>${s.desc}</span></div>
          </div>
          <${Btn} size="sm" disabled=${!s.nav} onClick=${() => s.nav && onNav(s.nav)}>${s.cta}<//>
        </div>`)}
    <//>
  `;
};

const AccountEditProfilePage = ({ onNav }) => {
  const [firstName, setFirstName] = useState("manoi");
  const [lastName, setLastName] = useState("vv");
  const [email, setEmail] = useState("manoi@example.com");
  const [title, setTitle] = useState("Platform Engineer");
  return html`
    <div style=${{maxWidth: 680, width: "100%"}} class="col gap-5">
      <${PageHead} title="Edit profile" sub="Update your personal information." />
      <${Card}>
        <div class="row gap-4" style=${{alignItems: "center", paddingBottom: 20, borderBottom: "1px solid var(--border-soft)", marginBottom: 20}}>
          <span style=${{width: 68, height: 68, borderRadius: 18, background: "var(--accent)", color: "var(--accent-fg)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 22}}>MV</span>
          <div class="row gap-2"><${Btn}>Upload photo<//><${Btn} variant="ghost">Remove<//></div>
        </div>
        <div class="col gap-4">
          <div class="row gap-3" style=${{alignItems: "flex-start"}}>
            <div style=${{flex: 1}}><${Field} label="First name" required><${Input} value=${firstName} onInput=${(e) => setFirstName(e.target.value)} /><//></div>
            <div style=${{flex: 1}}><${Field} label="Last name"><${Input} value=${lastName} onInput=${(e) => setLastName(e.target.value)} /><//></div>
          </div>
          <${Field} label="Email" required><${Input} type="email" value=${email} onInput=${(e) => setEmail(e.target.value)} /><//>
          <${Field} label="Job title"><${Input} value=${title} onInput=${(e) => setTitle(e.target.value)} /><//>
          <${Field} label="Timezone"><${Select} value="America/Los_Angeles" onChange=${() => {}} options=${["America/Los_Angeles", "America/New_York", "Europe/London", "Europe/Berlin", "Asia/Tokyo"]} /><//>
          <div class="row gap-2" style=${{marginTop: 8}}>
            <${Btn} variant="ghost" onClick=${() => onNav("account-profile")}>Cancel<//>
            <${Btn} variant="primary" icon=${html`<${Icon} name="check" size=${14} />`} onClick=${() => onNav("account-profile")}>Save changes<//>
          </div>
        </div>
      <//>
    </div>`;
};

const AccountChangePasswordPage = ({ onNav }) => {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [msg, setMsg] = useState(null);
  const reqs = [
    { met: next.length >= 8, label: "At least 8 characters" },
    { met: /[A-Z]/.test(next), label: "One uppercase letter" },
    { met: /[a-z]/.test(next), label: "One lowercase letter" },
    { met: /[0-9]/.test(next), label: "One digit" },
    { met: /[^A-Za-z0-9]/.test(next), label: "One special character" },
    { met: next && next === confirm, label: "Passwords match" },
  ];
  const canSubmit = current && reqs.every((r) => r.met);
  return html`
    <div style=${{maxWidth: 560, width: "100%"}} class="col gap-5">
      <${PageHead} title="Change password" sub="Use a strong password you don't reuse elsewhere." />
      <${Card}>
        <div class="col gap-4">
          <${Field} label="Current password" required><${Input} type="password" value=${current} onInput=${(e) => setCurrent(e.target.value)} /><//>
          <${Field} label="New password" required><${Input} type="password" value=${next} onInput=${(e) => setNext(e.target.value)} /><//>
          <${Field} label="Confirm new password" required><${Input} type="password" value=${confirm} onInput=${(e) => setConfirm(e.target.value)} /><//>
          <ul style=${{listStyle: "none", padding: 0, margin: 0}}>
            ${reqs.map((r) => html`
              <li style=${{display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: r.met ? "var(--ok)" : "var(--text-muted)", padding: "3px 0"}}>
                <${Icon} name=${r.met ? "check" : "x"} size=${12} />
                <span>${r.label}</span>
              </li>`)}
          </ul>
          ${msg && html`<p style=${{fontSize: 13, color: "var(--ok)", margin: 0}}>${msg}</p>`}
          <div class="row gap-2" style=${{marginTop: 8}}>
            <${Btn} variant="ghost" onClick=${() => onNav("account-profile")}>Cancel<//>
            <${Btn} variant="primary" disabled=${!canSubmit} onClick=${() => { setMsg("Password updated."); setCurrent(""); setNext(""); setConfirm(""); setTimeout(() => onNav("account-profile"), 800); }}>Update password<//>
          </div>
        </div>
      <//>
    </div>`;
};

const Account2faManagePage = ({ onNav }) => {
  const [enabled, setEnabled] = useState(true);
  const [codes, setCodes] = useState(["a4kf-jt91", "88nq-d2mp", "xz7g-1frl", "mvpc-e0h6", "9kdz-yq34", "r7bt-suoe"]);
  const [regenNote, setRegenNote] = useState(null);
  return html`
    <div style=${{maxWidth: 680, width: "100%"}} class="col gap-5">
      <${PageHead} title="Two-factor authentication" sub="Add a second layer of security to your account." />
      <${Card}>
        <div class="row between" style=${{alignItems: "center"}}>
          <div class="row gap-3" style=${{alignItems: "center"}}>
            <span style=${{width: 44, height: 44, borderRadius: 12, background: enabled ? "var(--ok-soft)" : "var(--surface-3)", color: enabled ? "var(--ok)" : "var(--text-muted)", display: "flex", alignItems: "center", justifyContent: "center", flex: "none"}}><${Icon} name="shield" size=${22} /></span>
            <div class="col" style=${{gap: 3}}>
              <div class="row gap-2" style=${{alignItems: "center"}}><b style=${{fontSize: 14}}>Authenticator app</b>${enabled && html`<${Badge} tone="ok">Enabled<//>`}</div>
              <span class="faint" style=${{fontSize: 12}}>${enabled ? "Google Authenticator · added Jan 2025" : "Not enabled"}</span>
            </div>
          </div>
          <label class="row gap-2" style=${{cursor: "pointer", alignItems: "center"}} onClick=${() => setEnabled(!enabled)}>
            <span style=${{width: 36, height: 20, borderRadius: 999, background: enabled ? "var(--accent)" : "var(--surface-3)", padding: 2, transition: "background .15s"}}>
              <span style=${{width: 16, height: 16, borderRadius: "50%", background: "white", display: "block", transform: enabled ? "translateX(16px)" : "translateX(0)", transition: "transform .15s"}}></span>
            </span>
          </label>
        </div>
      <//>
      ${enabled && html`
        <${Card} title="Backup codes" sub=${codes.length + " of 10 codes remaining"} actions=${html`<${Btn} onClick=${() => { setCodes(["new1-a4k7", "new2-88nq", "new3-xz71", "new4-mvpr", "new5-9kdz", "new6-r7bt", "new7-4fjt", "new8-mn8x", "new9-e2ph", "new10-yhb"]); setRegenNote("Copy these now — they won't be shown again."); }}>Regenerate<//>`}>
          ${regenNote && html`<div style=${{padding: "10px 14px", background: "var(--warn-soft)", color: "var(--warn)", borderRadius: 8, fontSize: 12.5, marginBottom: 14}}>${regenNote}</div>`}
          <div style=${{display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(140px, 1fr))", gap: 8}}>
            ${codes.map((c) => html`<span class="mono" style=${{padding: "8px 12px", background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 8, fontSize: 13, textAlign: "center"}}>${c}</span>`)}
          </div>
        <//>`}
      <${Btn} variant="ghost" onClick=${() => onNav("account-profile")}>← Back to profile<//>
    </div>`;
};

// ═════════════════════════════════════════════════════════════════════
// Nav
// ═════════════════════════════════════════════════════════════════════
// ═════════════════════════════════════════════════════════════════════
// Approvals page — pending Terraform plans + deploys waiting on a human.
// Reads from the shared ApprovalsContext so entries created by the chat's
// "Create cluster" / "Deploy my app" wizards show up here immediately.
// ═════════════════════════════════════════════════════════════════════

const PlanDiff = ({ detail, cloudLabel }) => {
  // Cluster-create plan: show Terraform-style resource additions.
  // Deploy plan: shape depends on the deployment method (raw manifests / Helm / kustomize).
  const app = detail?.repo ? (detail.repo.split("/")[1] || detail.repo) : "";
  const rows = detail && detail.name ? [
    { op: "+", type: (detail.cloud === "aws" ? "aws" : detail.cloud === "azure" ? "azurerm" : "google") + "_resource_group", name: "rg", tone: "ok" },
    { op: "+", type: (detail.cloud === "aws" ? "aws_eks_cluster" : detail.cloud === "azure" ? "azurerm_kubernetes_cluster" : "google_container_cluster"), name: detail.name, tone: "ok" },
    { op: "+", type: "node_pool", name: (detail.nodes || 3) + "× " + (detail.vmSize || ""), tone: "ok" },
  ] : detail && detail.repo && detail.method === "helm" ? [
    { op: "+", type: "helm_release", name: detail.releaseName || (app + "-" + detail.env), tone: "ok" },
    { op: "~", type: "helm_values", name: "values-" + detail.env + ".yaml (image.tag=" + detail.tag + ")", tone: "warn" },
    { op: "~", type: "kubernetes_deployment", name: app + " (via chart template)", tone: "warn" },
    { op: "~", type: "kubernetes_service", name: app + " (via chart template)", tone: "warn" },
    { op: "+", type: "kubernetes_ingress", name: app + " (via chart template)", tone: "ok" },
  ] : detail && detail.repo && detail.method === "kustomize" ? [
    { op: "~", type: "kustomize_overlay", name: detail.kustomizeOverlay || ("overlays/" + detail.env), tone: "warn" },
    { op: "~", type: "kubernetes_deployment", name: app + " (image=" + detail.tag + ")", tone: "warn" },
    { op: "+", type: "kubernetes_service", name: app, tone: "ok" },
  ] : detail && detail.repo ? [
    { op: "~", type: "kubernetes_deployment", name: app + " (image=" + detail.tag + ")", tone: "warn" },
    { op: "+", type: "kubernetes_service", name: app, tone: "ok" },
    { op: "+", type: "kubernetes_ingress", name: app, tone: "ok" },
  ] : [];
  return html`
    <div class="mono" style=${{background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 8, padding: 12, fontSize: 12, lineHeight: 1.7}}>
      ${rows.map((r) => html`
        <div class="row gap-2" style=${{alignItems: "center"}}>
          <span style=${{color: r.tone === "ok" ? "var(--ok, #22c55e)" : "var(--warn, #eab308)", fontWeight: 700, width: 14, textAlign: "center"}}>${r.op}</span>
          <span style=${{color: "var(--text)"}}>${r.type}</span>
          <span style=${{color: "var(--text-muted)"}}>.</span>
          <span style=${{color: "var(--accent)"}}>${r.name}</span>
        </div>`)}
    </div>`;
};

const ApprovalsPage = () => {
  const toast = useToast();
  const approvals = useApprovals();
  const [detailId, setDetailId] = useState(null);
  if (!approvals) return html`<${PageHead} title="Approvals" sub="Loading…" />`;
  const pending = approvals.items.filter((a) => a.status === "pending");
  const resolved = approvals.items.filter((a) => a.status !== "pending").slice(0, 8);
  const detail = detailId ? approvals.items.find((a) => a.id === detailId) : null;
  return html`
    <${PageHead} title="Approvals" sub=${pending.length + " pending · every risky change waits here for a human review."} />
    <div style=${{display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(200px, 1fr))", gap: 14}}>
      <${Stat} label="Pending" value=${String(pending.length)} sub="waiting on you" icon="◑" />
      <${Stat} label="Approved (30d)" value=${String(approvals.items.filter((a) => a.status === "approved").length)} sub="deployed" icon="✓" />
      <${Stat} label="Rejected (30d)" value=${String(approvals.items.filter((a) => a.status === "rejected").length)} sub="blocked" icon="✕" />
      <${Stat} label="Median wait" value="14m" sub="oncall review" icon="◷" />
    </div>
    <${Card} title="Pending" sub=${pending.length + " item" + (pending.length === 1 ? "" : "s")}>
      ${pending.length === 0 ? html`<div class="muted" style=${{padding: 30, textAlign: "center", fontSize: 13}}>Nothing waiting. Ask the agent to "create a cluster" or "deploy my app to release" to see one appear.</div>` : html`
        <div class="col" style=${{gap: 10}}>
          ${pending.map((a) => html`
            <div style=${{padding: 14, background: "var(--surface-2)", border: "1px solid var(--border-soft)", borderRadius: 10}}>
              <div class="row between wrap" style=${{gap: 12, alignItems: "flex-start"}}>
                <div class="col" style=${{gap: 6, minWidth: 0, flex: 1}}>
                  <div class="row gap-2 wrap" style=${{alignItems: "center"}}>
                    <${Badge} tone=${a.kind === "cluster-create" ? "info" : "warn"}>${a.kind === "cluster-create" ? "cluster.create" : "deploy.release"}<//>
                    <b style=${{fontSize: 14}}>${a.title}</b>
                    <${Badge}>${a.projectName}<//>
                  </div>
                  <div class="faint mono" style=${{fontSize: 12}}>${a.submittedBy} · ${a.at} · plan: <span style=${{color: "var(--ok, #22c55e)"}}>+${a.plan.adds}</span> <span style=${{color: "var(--warn, #eab308)"}}>~${a.plan.changes}</span> <span style=${{color: "var(--danger, #f43f5e)"}}>-${a.plan.destroys}</span></div>
                </div>
                <div class="row gap-2">
                  <${Btn} size="sm" onClick=${() => setDetailId(detailId === a.id ? null : a.id)}>${detailId === a.id ? "Hide plan" : "View plan"}<//>
                  <${Btn} size="sm" variant="ghost" onClick=${() => { approvals.resolve(a.id, "rejected"); toast(a.title + " rejected", "warn"); }}>Reject<//>
                  <${Btn} size="sm" variant="primary" icon="✓" onClick=${() => { approvals.resolve(a.id, "approved"); toast(a.title + " approved — apply started"); setDetailId(null); }}>Approve &amp; apply<//>
                </div>
              </div>
              ${detailId === a.id && html`
                <div style=${{marginTop: 12}}>
                  <${PlanDiff} detail=${a.detail} cloudLabel=${a.detail?.cloudLabel} />
                  ${a.detail?.name && html`
                    <div class="muted" style=${{fontSize: 12, marginTop: 8, lineHeight: 1.6}}>Target: <b>${a.detail.cloudLabel}</b> · region <span class="mono">${a.detail.region}</span> · k8s <span class="mono">${a.detail.version}</span> · ${a.detail.nodes} × <span class="mono">${a.detail.vmSize}</span></div>`}
                  ${a.detail?.repo && html`
                    <div class="muted" style=${{fontSize: 12, marginTop: 8, lineHeight: 1.6}}>
                      Image: <span class="mono">${a.detail.repo}:${a.detail.tag}</span> · env <b>${a.detail.env}</b> · <b>${a.detail.strategy}</b> rollout · method <b>${a.detail.method || "manifests"}</b>
                      ${a.detail.method === "helm" && html`<div style=${{marginTop: 4}}>Helm: chart <span class="mono">${a.detail.chartPath}</span> · release <span class="mono">${a.detail.releaseName}</span></div>`}
                      ${a.detail.method === "kustomize" && html`<div style=${{marginTop: 4}}>Kustomize overlay: <span class="mono">${a.detail.kustomizeOverlay}</span></div>`}
                    </div>`}
                </div>`}
            </div>`)}
        </div>`}
    <//>
    ${resolved.length > 0 && html`
      <${Card} title="Recent decisions" sub="Last 8">
        <${Table} headers=${["Change", "Project", "Decision", "By", "When"]} rows=${resolved.map((a) => [
          html`<div class="col" style=${{gap: 2}}><b>${a.title}</b><span class="mono faint" style=${{fontSize: 11}}>${a.kind}</span></div>`,
          html`<${Badge}>${a.projectName}<//>`,
          html`<${Badge} tone=${a.status === "approved" ? "ok" : "danger"}>${a.status}<//>`,
          a.decidedBy || "manoi",
          html`<span class="faint">${a.decidedAt || "just now"}</span>`,
        ])} />
      <//>`}
  `;
};

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
  scheduler: { label: "Scheduler", icon: "clock", component: SchedulerPage },
  cost: { label: "Cost", icon: "dollar", component: CostPage },
  tasks: { label: "Tasks", icon: "tasks", component: SimplePage("Tasks", "Autonomous agent runs — scheduled or on-demand.") },
  knowledge: { label: "Knowledge", icon: "book", component: SimplePage("Knowledge", "Runbooks, incident postmortems, reference docs.") },
  approvals: { label: "Approvals", icon: "approve", component: ApprovalsPage },
  alerts: { label: "Alerts", icon: "alert", component: AlertsPage },
  activity: { label: "Activity", icon: "activity", component: SimplePage("Activity", "Every audit-worthy action in the project.") },
  settings: { label: "Settings", icon: "settings", component: SimplePage("Project settings", "General, integrations, members, danger zone.") },
  // My Account area
  "u-dashboard": { label: "Dashboard", icon: "dashboard", component: UserDashboardPage },
  "u-projects": { label: "Projects", icon: "projects", component: UserProjectsPage },
  "u-teams": { label: "Teams", icon: "teams", component: UserTeamsPage },
  "u-subscription": { label: "Subscription", icon: "card", component: UserSubscriptionPage },
  "u-usage": { label: "Usage", icon: "gauge", component: UserUsagePage },
  "u-settings": { label: "Settings", icon: "settings", component: (props) => html`<${AccountProfilePage} ...${props} />` },
  // Account sub-pages (reached from Profile page + user menu)
  "account-profile": { label: "Profile", icon: "user", component: AccountProfilePage },
  "account-edit-profile": { label: "Edit profile", icon: "edit", component: AccountEditProfilePage },
  "account-change-password": { label: "Change password", icon: "lock", component: AccountChangePasswordPage },
  "account-2fa-manage": { label: "Two-factor", icon: "shield", component: Account2faManagePage },
};

const NAV_GROUPS_PROJECT = [
  { label: null, items: ["dashboard","chat","cicd","environments","cloud","infra","topology"] },
  { label: "Deploy", items: ["promotions"] },
  { label: "Connection", items: ["github","connection","stats","uptime","scheduler"] },
  { label: null, items: ["cost","tasks","knowledge","approvals","alerts","activity","settings"] },
];

// User (My Account) area nav — matches nav-registry.ts user area lines 18-37.
const NAV_GROUPS_USER = [
  { label: null, items: ["u-dashboard","u-projects","u-teams","u-subscription","u-usage","u-settings"] },
];

// Which area does a given page belong to?
const areaOfPage = (id) => {
  if (id.startsWith("u-") || id.startsWith("account-")) return "user";
  return "project";
};

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

const Sidebar = ({ active, onSelect, activeProject, onSwitchProject, area }) => {
  const groups = area === "user" ? NAV_GROUPS_USER : NAV_GROUPS_PROJECT;
  return html`
    <aside class="dda-sidebar col">
      <div class="dda-sidebar-head row between">
        <div class="row gap-2" style=${{alignItems: "center"}}>
          <span style=${{width: 34, height: 34, borderRadius: 10, background: "var(--accent)", color: "var(--accent-fg)", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 14}}>◐</span>
          <div class="col">
            <span style=${{fontWeight: 800, fontSize: 13.5, letterSpacing: "-.01em"}}>DeepAgent DevOps</span>
            <span class="faint" style=${{fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".08em", fontWeight: 700}}>${area === "user" ? "My Account" : "Autonomous infra"}</span>
          </div>
        </div>
      </div>
      ${area === "project" ? html`
        <div style=${{padding: "0 12px 8px"}}>
          <${ProjectSwitcher} activeSlug=${activeProject} onSwitch=${onSwitchProject} />
        </div>` : html`
        <div style=${{padding: "0 12px 8px"}}>
          <div style=${{padding: "10px 12px", background: "var(--accent-soft)", borderRadius: 10, display: "flex", gap: 10, alignItems: "center"}}>
            <${Icon} name="user" size=${18} />
            <div class="col" style=${{gap: 1}}>
              <b style=${{fontSize: 12.5}}>My Account</b>
              <span class="faint" style=${{fontSize: 11}}>User-level settings</span>
            </div>
          </div>
        </div>`}
      <nav class="col gap-1 dda-sidebar-nav">
        ${groups.map((g) => html`
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
};

const UserMenu = ({ session, onLogout, onNav }) => {
  const [open, setOpen] = useState(false);
  const initials = (session.name || session.email || "?").split(/\s+|@/).map((p) => p[0]).slice(0, 2).join("").toUpperCase();
  const items = [
    { icon: "user", label: "Profile", nav: "account-profile" },
    { icon: "edit", label: "Edit profile", nav: "account-edit-profile" },
    { icon: "lock", label: "Change password", nav: "account-change-password" },
    { icon: "shield", label: "Two-factor auth", nav: "account-2fa-manage" },
    { icon: "card", label: "Subscription", nav: "u-subscription" },
    { icon: "gauge", label: "Usage", nav: "u-usage" },
  ];
  return html`
    <div style=${{position: "relative"}}>
      <button class="btn ghost icon sm" style=${{fontSize: 11, fontWeight: 700}} onClick=${() => setOpen(!open)}>${initials}</button>
      ${open && html`
        <div style=${{position: "absolute", top: "calc(100% + 6px)", right: 0, minWidth: 260, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "var(--shadow-lg)", zIndex: 150, overflow: "hidden"}}>
          <div style=${{padding: "12px 14px", borderBottom: "1px solid var(--border-soft)"}}>
            <div style=${{fontWeight: 700, fontSize: 13.5}}>${session.name || session.email}</div>
            <div class="faint" style=${{fontSize: 12}}>${session.email}${session.via ? " · via " + session.via : ""}</div>
          </div>
          <div style=${{padding: 6}}>
            ${items.map((i) => html`
              <button style=${{display: "flex", width: "100%", padding: "8px 10px", background: "transparent", border: "none", textAlign: "left", cursor: "pointer", color: "var(--text)", fontFamily: "inherit", fontSize: 13, alignItems: "center", gap: 10, borderRadius: 6}} onClick=${() => { setOpen(false); onNav(i.nav); }} onMouseOver=${(e) => e.currentTarget.style.background = "var(--surface-3)"} onMouseOut=${(e) => e.currentTarget.style.background = "transparent"}>
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

const AreaSwitcher = ({ area, onSwitch }) => {
  const [open, setOpen] = useState(false);
  const areas = [
    { key: "project", label: "Project workspace", icon: "box", sub: "Deploy + infra + agents" },
    { key: "user", label: "My Account", icon: "user", sub: "Profile · subscription · usage" },
  ];
  const active = areas.find((a) => a.key === area);
  return html`
    <div style=${{position: "relative"}}>
      <button class="btn sm" onClick=${() => setOpen(!open)}>
        <${Icon} name=${active.icon} size=${14} />
        <span>${active.label}</span>
        <${Icon} name="chevD" size=${12} />
      </button>
      ${open && html`
        <div style=${{position: "absolute", top: "calc(100% + 6px)", right: 0, minWidth: 260, background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 10, boxShadow: "var(--shadow-lg)", zIndex: 150, overflow: "hidden"}}>
          <div style=${{fontSize: 10.5, textTransform: "uppercase", letterSpacing: ".06em", color: "var(--text-faint)", padding: "10px 14px 6px", fontWeight: 700}}>Switch workspace</div>
          ${areas.map((a) => html`
            <button style=${{display: "flex", width: "100%", padding: "10px 14px", background: a.key === area ? "var(--surface-3)" : "transparent", border: "none", textAlign: "left", cursor: "pointer", color: "var(--text)", fontFamily: "inherit", fontSize: 13, alignItems: "center", gap: 12}} onClick=${() => { setOpen(false); onSwitch(a.key); }}>
              <span style=${{width: 32, height: 32, borderRadius: 8, background: "var(--accent-soft)", color: "var(--accent)", display: "flex", alignItems: "center", justifyContent: "center", flex: "none"}}><${Icon} name=${a.icon} size=${16} /></span>
              <div class="col" style=${{gap: 2}}><b style=${{fontSize: 13}}>${a.label}</b><span class="faint" style=${{fontSize: 11.5}}>${a.sub}</span></div>
              ${a.key === area && html`<span class="faint" style=${{marginLeft: "auto"}}>✓</span>`}
            </button>`)}
        </div>`}
    </div>`;
};

const Topbar = ({ theme, onToggleTheme, project, session, onLogout, area, onSwitchArea, onNav }) => html`
  <header class="dda-topbar row between" style=${{display: "flex", alignItems: "center"}}>
    <div class="row gap-3" style=${{alignItems: "center"}}>
      <${Btn} variant="ghost" size="icon"><${Icon} name="menu" size=${18} /><//>
      <div class="row gap-2" style=${{fontSize: 13, color: "var(--text-muted)", alignItems: "center"}}>
        ${area === "user" ? html`
          <span>My Account</span>
        ` : html`
          <span>Projects</span><span class="faint">/</span><span style=${{color: "var(--text)", fontWeight: 600}}>${project.name}</span>
          <${Badge} tone="info">${project.cloudLabel}<//>
        `}
      </div>
    </div>
    <div style=${{flex: 1, maxWidth: 520, margin: "0 24px"}}>
      <div class="input row gap-2" style=${{cursor: "default", color: "var(--text-faint)", alignItems: "center"}}>
        <${Icon} name="search" size=${16} /><span>Search resources, repos, agents…</span><span style=${{marginLeft: "auto", fontSize: 11, padding: "1px 6px", border: "1px solid var(--border)", borderRadius: 4}}>⌘K</span>
      </div>
    </div>
    <div class="row gap-2">
      <${AreaSwitcher} area=${area} onSwitch=${onSwitchArea} />
      <${Btn} variant="ghost" size="icon" onClick=${onToggleTheme}><${Icon} name=${theme === "dark" ? "sun" : "moon"} size=${16} /><//>
      <${Btn} variant="ghost" size="icon"><${Icon} name="bell" size=${16} /><//>
      <${UserMenu} session=${session} onLogout=${onLogout} onNav=${onNav} />
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

// Stack of active toasts, rendered fixed at the bottom-right. Every button
// with an actionable side-effect calls toast("…") and users see confirmation.
const ToastHost = ({ items, onDismiss }) => html`
  <div style=${{position: "fixed", bottom: 20, right: 20, display: "flex", flexDirection: "column", gap: 8, zIndex: 9999, pointerEvents: "none"}}>
    ${items.map((t) => html`
      <div key=${t.id} onClick=${() => onDismiss(t.id)} style=${{
        pointerEvents: "auto",
        cursor: "pointer",
        background: t.tone === "error" ? "var(--danger-soft, #7a1f2a)" : t.tone === "warn" ? "var(--warn-soft, #7a5a1a)" : "var(--ok-soft, #1a4736)",
        color: "var(--text-strong, #eef2ff)",
        border: "1px solid " + (t.tone === "error" ? "var(--danger, #f43f5e)" : t.tone === "warn" ? "var(--warn, #eab308)" : "var(--ok, #22c55e)"),
        padding: "10px 14px",
        borderRadius: 8,
        fontSize: 13,
        boxShadow: "0 8px 24px rgba(0,0,0,0.35)",
        maxWidth: 340,
        minWidth: 220,
      }}>${t.msg}</div>
    `)}
  </div>`;

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
  // Toast queue — stable ids, auto-dismiss after 3.5s.
  const [toasts, setToasts] = useState([]);
  const toast = (msg, tone = "ok") => {
    const id = Date.now() + "-" + Math.random().toString(36).slice(2, 7);
    setToasts((t) => [...t, {id, msg, tone}]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), 3500);
  };
  const dismissToast = (id) => setToasts((t) => t.filter((x) => x.id !== id));

  // Approvals queue — seeded with 2 sample entries so the Approvals page has
  // demo content even before the user opens the chat wizards.
  const [approvalItems, setApprovalItems] = useState([
    {
      id: "sample-1",
      kind: "cluster-create",
      title: "Create EKS cluster agent-prod",
      project: "agent-aws", projectName: "agent (AWS)",
      submittedBy: "sriram", at: "12m ago",
      status: "pending",
      plan: { adds: 3, changes: 0, destroys: 0 },
      detail: { name: "agent-prod", region: "us-east-1", version: "1.36", nodes: 3, vmSize: "t3.medium", cloud: "aws", cloudLabel: "AWS", clusterType: "EKS" },
    },
    {
      id: "sample-2",
      kind: "deploy",
      title: "Deploy manov7723-sys/api:v2.4.1 to release",
      project: "agent-azure", projectName: "agent (Azure)",
      submittedBy: "dev1", at: "38m ago",
      status: "pending",
      plan: { adds: 1, changes: 1, destroys: 0 },
      detail: { repo: "manov7723-sys/api", tag: "v2.4.1", env: "prod", strategy: "canary" },
    },
  ]);
  const approvals = {
    items: approvalItems,
    add: (entry) => setApprovalItems((xs) => [{
      ...entry,
      id: "a" + Date.now().toString(36),
      status: "pending",
      at: "just now",
    }, ...xs]),
    resolve: (id, decision) => setApprovalItems((xs) => xs.map((x) => x.id === id ? { ...x, status: decision, decidedBy: "manoi", decidedAt: "just now" } : x)),
  };
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

  const select = (id) => {
    // If the target page belongs to a different area, entering it switches
    // the sidebar to that area automatically (matches real app URL routing).
    if (!(id in PAGES)) return;
    setActive(id);
    location.hash = id;
  };
  const switchArea = (nextArea) => {
    // Land on the first page in the new area's nav.
    select(nextArea === "user" ? "u-dashboard" : "dashboard");
  };
  const Page = PAGES[active].component;
  const isChat = active === "chat";
  const project = PROJECTS[projectSlug];
  const area = areaOfPage(active);
  return html`
    <${ToastContext.Provider} value=${toast}>
      <${ApprovalsContext.Provider} value=${approvals}>
        <${ProjectContext.Provider} value=${project}>
          <div class="dda-shell" style=${{display: "flex", height: "100vh", overflow: "hidden"}}>
            <${Sidebar} active=${active} onSelect=${select} activeProject=${projectSlug} onSwitchProject=${setProjectSlug} area=${area} />
            <div class="col grow" style=${{minWidth: 0, minHeight: 0}}>
              <${Topbar} theme=${theme} onToggleTheme=${() => setTheme(theme === "dark" ? "light" : "dark")} project=${project} session=${session} onLogout=${logout} area=${area} onSwitchArea=${switchArea} onNav=${select} />
              <main class="dda-main grow">
                <div class="dda-page-wrap col gap-5" style=${isChat ? {maxWidth: "none", padding: 0, height: "100%"} : null}>
                  <${Page} onNav=${select} />
                </div>
              </main>
            </div>
          </div>
        <//>
      <//>
      <${ToastHost} items=${toasts} onDismiss=${dismissToast} />
    <//>`;
};

render(h(App, null), document.getElementById("root"));
