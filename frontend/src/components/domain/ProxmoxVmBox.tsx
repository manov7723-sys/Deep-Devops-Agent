"use client";

/**
 * Proxmox VM creation box — a console-style paged form on the same shared
 * `ClusterChat` engine the EKS/GKE/AKS boxes use. This file is just the Proxmox
 * field script + how to turn the answers into the `/proxmox/vm` request body.
 * No LLM. Rendered on the Infra tab and inline in chat (```proxmox-vm``` fence).
 */
import {
  ClusterChat,
  type ClusterChatConfig,
  type Step,
} from "@/components/domain/cluster-chat-engine";

const NAME_RE = /^[a-z][a-z0-9-]{1,38}$/;

/** Live string list from the /proxmox/vm GET; undefined (loading) → []. */
const optsList = (opts: Record<string, unknown> | undefined, key: string): string[] | null => {
  const v = opts?.[key];
  return Array.isArray(v) ? (v as string[]) : null;
};

const STEPS: Step[] = [
  // ── Page 1 · VM basics ───────────────────────────────────────────────
  {
    page: 1,
    kind: "select",
    key: "envKey",
    label: "Environment",
    hint: "Provides the Proxmox API credentials for the terraform apply.",
    emptyNote: "Create an environment (and attach the Proxmox provider) first.",
    options: (c) => c.envs.map((e) => ({ value: e.key, label: e.name || e.key })),
  },
  {
    page: 1,
    kind: "text",
    key: "name",
    label: "VM name",
    hint: "Lowercase letters, digits, hyphens; start with a letter.",
    placeholder: "web-01",
    validate: (v) =>
      NAME_RE.test(v) ? null : "Lowercase letters, digits and hyphens; start with a letter.",
  },
  {
    page: 1,
    kind: "select",
    key: "node",
    label: "Proxmox node",
    hint: "Loaded live from your connected Proxmox server.",
    emptyNote: "No Proxmox nodes found — check the provider on the Cloud tab.",
    // While the live query is in flight `nodes` is undefined → return [] so the
    // engine holds off seeding a default and picks it up from live data instead
    // (avoids locking in a stale "pve" before the real node name arrives).
    options: (c) => {
      const nodes = c.opts?.nodes;
      if (!Array.isArray(nodes)) return [];
      return (nodes.length ? (nodes as string[]) : ["pve"]).map((n) => ({ value: n, label: n }));
    },
    default: (c) => {
      const dn = c.opts?.defaultNode;
      if (typeof dn === "string" && dn) return dn;
      const nodes = c.opts?.nodes;
      return Array.isArray(nodes) && nodes.length ? String((nodes as string[])[0]) : "pve";
    },
  },
  {
    page: 1,
    kind: "number",
    key: "cores",
    label: "vCPU cores",
    default: () => "2",
    validate: (v) => (Number(v) >= 1 ? null : "At least 1 core."),
  },
  {
    page: 1,
    kind: "number",
    key: "memoryMB",
    label: "Memory (MB)",
    default: () => "2048",
    validate: (v) => (Number(v) >= 128 ? null : "At least 128 MB."),
  },
  {
    page: 1,
    kind: "number",
    key: "diskGB",
    label: "Disk (GB)",
    default: () => "20",
    validate: (v) => (Number(v) >= 1 ? null : "At least 1 GB."),
  },
  {
    page: 1,
    kind: "select",
    key: "datastore",
    label: "Storage pool",
    hint: "Storage that holds the VM disk — read live from the node.",
    emptyNote: "No image-capable storage found on this node.",
    // [] while the live list is loading → the engine seeds the default from live
    // data (so it can't lock in a pool the node doesn't have, e.g. local-lvm).
    options: (c) => (optsList(c.opts, "datastores") ?? []).map((d) => ({ value: d, label: d })),
    default: (c) => {
      const d = optsList(c.opts, "datastores");
      return d && d.length ? (d.includes("local-lvm") ? "local-lvm" : d[0]) : "local-lvm";
    },
  },
  {
    page: 1,
    kind: "select",
    key: "bridge",
    label: "Network bridge",
    hint: "Read live from the node.",
    emptyNote: "No bridges found on this node.",
    options: (c) => (optsList(c.opts, "bridges") ?? []).map((b) => ({ value: b, label: b })),
    default: (c) => {
      const b = optsList(c.opts, "bridges");
      return b && b.length ? (b.includes("vmbr0") ? "vmbr0" : b[0]) : "vmbr0";
    },
  },
  // ── Page 2 · Source & network ────────────────────────────────────────
  {
    page: 2,
    kind: "choice",
    key: "source",
    label: "Boot source",
    hint: "Clone an existing template (fast, cloud-init ready) or boot from an ISO.",
    choices: [
      { value: "template", label: "Clone a template" },
      { value: "iso", label: "Boot from ISO" },
    ],
  },
  {
    page: 2,
    kind: "select",
    key: "templateVmId",
    label: "Template to clone",
    hint: "A VM template on the selected node (read live from Proxmox).",
    emptyNote: "No templates on this node — create one, or switch the boot source to ISO.",
    skip: (a) => a.source !== "template",
    options: (c) => {
      const t = c.opts?.templates;
      if (!Array.isArray(t)) return [];
      return (t as Array<{ vmid: number; name: string }>).map((x) => ({
        value: String(x.vmid),
        label: x.name ? `${x.name} · #${x.vmid}` : `template #${x.vmid}`,
      }));
    },
    default: (c) => {
      const t = c.opts?.templates;
      return Array.isArray(t) && t.length ? String((t as Array<{ vmid: number }>)[0].vmid) : "";
    },
  },
  {
    page: 2,
    kind: "text",
    key: "isoFile",
    label: "ISO file",
    mono: true,
    placeholder: "local:iso/ubuntu-24.04-live-server-amd64.iso",
    skip: (a) => a.source !== "iso",
    validate: (v, a) =>
      a.source !== "iso" || v.trim() ? null : "Enter an ISO file (e.g. local:iso/…).",
  },
  {
    page: 2,
    kind: "text",
    key: "ipv4",
    label: "IPv4 (cloud-init)",
    mono: true,
    hint: '"dhcp" or a CIDR like 10.0.0.50/24.',
    placeholder: "dhcp",
    default: () => "dhcp",
  },
  {
    page: 2,
    kind: "text",
    key: "gateway",
    label: "Gateway",
    mono: true,
    optional: true,
    placeholder: "10.0.0.1",
    skip: (a) => !a.ipv4 || String(a.ipv4).trim() === "dhcp",
  },
  // ── Page 3 · Repository ──────────────────────────────────────────────
  {
    page: 3,
    kind: "select",
    key: "repoFullName",
    label: "Repository",
    hint: "The generated Terraform is committed here.",
    emptyNote: "Attach a repo on the CI/CD & Repos tab first.",
    options: (c) => c.repos.map((r) => ({ value: r.fullName, label: r.fullName })),
  },
  {
    page: 3,
    kind: "text",
    key: "ghPath",
    label: "File path (folder)",
    mono: true,
    placeholder: "terraform/proxmox/web-01",
    default: (c) => `terraform/proxmox/${String(c.answers.name ?? "").trim() || "vm"}`,
  },
];

const PROXMOX_CONFIG: ClusterChatConfig = {
  cloud: "proxmox",
  cloudLabel: "Proxmox",
  title: "Create Proxmox VM",
  blueprintSub:
    "Proxmox VM via Terraform (bpg/proxmox). No LLM — generates provider.tf + vm.tf, then push → apply.",
  optionsPath: "proxmox/vm",
  stackPrefix: "proxmox-vm",
  ghPathPrefix: "terraform/proxmox",
  branchPrefix: "proxmox-vm",
  applyEta: "~2–5 min",
  pageTitles: ["VM basics", "Source & network", "Repository"],
  steps: STEPS,
  buildBody: (a) => ({
    envKey: a.envKey,
    name: String(a.name).trim(),
    node: String(a.node ?? "pve").trim() || "pve",
    cores: Number(a.cores ?? 2),
    memoryMB: Number(a.memoryMB ?? 2048),
    diskGB: Number(a.diskGB ?? 20),
    datastore: String(a.datastore ?? "local-lvm").trim() || "local-lvm",
    bridge: String(a.bridge ?? "vmbr0").trim() || "vmbr0",
    templateVmId:
      a.source === "template" && String(a.templateVmId ?? "").trim()
        ? Number(a.templateVmId)
        : undefined,
    isoFile:
      a.source === "iso" && String(a.isoFile ?? "").trim() ? String(a.isoFile).trim() : undefined,
    ipv4: String(a.ipv4 ?? "").trim() || undefined,
    gateway:
      a.ipv4 && String(a.ipv4).trim() !== "dhcp" && String(a.gateway ?? "").trim()
        ? String(a.gateway).trim()
        : undefined,
  }),
};

export function ProxmoxVmBox({ slug }: { slug: string }) {
  return <ClusterChat slug={slug} config={PROXMOX_CONFIG} />;
}
