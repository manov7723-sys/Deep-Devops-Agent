/**
 * GCP Compute Engine VM agent tool — one VM in an EXISTING network + subnet.
 * GCP's equivalent of AWS EC2 / Azure VM. Pair with generate_gcp_vpc_terraform
 * when the user doesn't have a network yet.
 */
import { prisma } from "@/lib/db/prisma";
import { buildGcpVmTerraform, GCP_VM_DEFAULTS, type GcpVmImage } from "@/lib/devops/gcp-vm";
import type { Tool } from "./types";

type Input = {
  name: string;
  zone: string;
  region: string;
  envKey?: string;
  networkName: string;
  subnetName: string;
  image?: GcpVmImage;
  machineType?: string;
  diskGb?: number;
  diskType?: "pd-standard" | "pd-balanced" | "pd-ssd";
  publicIp?: boolean;
  sshUsername?: string;
  sshPublicKey?: string;
  windowsAdminUsername?: string;
  windowsAdminPassword?: string;
  allowIapSsh?: boolean;
  allowHttp?: boolean;
  allowHttps?: boolean;
};

type Output = {
  files: Record<string, string>;
  stack: string;
  summary: string;
  nextSteps: string[];
};

export const generateGcpVmTerraformTool: Tool<Input, Output> = {
  name: "generate_gcp_vm_terraform",
  description:
    "Generate Terraform for a GCP Compute Engine VM in an EXISTING VPC + subnet. " +
    "Linux VMs need sshPublicKey; Windows VMs need windowsAdminPassword. " +
    "NEVER hand-write GCE VM HCL.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      zone: { type: "string", description: "Full zone like us-central1-a (VMs are zonal in GCP)." },
      region: { type: "string", description: "Parent region — must match the subnet's region." },
      envKey: { type: "string" },
      networkName: { type: "string" },
      subnetName: { type: "string" },
      image: { type: "string", enum: ["debian-12", "ubuntu-2204-lts", "ubuntu-2404-lts", "rocky-linux-9", "windows-2022"] },
      machineType: { type: "string", description: `Default ${GCP_VM_DEFAULTS.machineType}.` },
      diskGb: { type: "number" },
      diskType: { type: "string", enum: ["pd-standard", "pd-balanced", "pd-ssd"] },
      publicIp: { type: "boolean" },
      sshUsername: { type: "string" },
      sshPublicKey: { type: "string" },
      windowsAdminUsername: { type: "string" },
      windowsAdminPassword: { type: "string" },
      allowIapSsh: { type: "boolean" },
      allowHttp: { type: "boolean" },
      allowHttps: { type: "boolean" },
    },
    required: ["name", "zone", "region", "networkName", "subnetName"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const cp = await prisma.cloudProvider.findFirst({
      where: { projectId: ctx.projectId, kind: "gcp" },
      select: { id: true },
    });
    if (!cp) return { ok: false, error: "No GCP account connected to this project." };
    try {
      const files = buildGcpVmTerraform({ ...input, env: input.envKey, labels: { created_by: "deepagent-gcp-vm" } });
      const image = input.image ?? GCP_VM_DEFAULTS.image;
      return {
        ok: true,
        output: {
          files,
          stack: `gcp-vm-${input.name}`,
          summary: `GCP ${image === "windows-2022" ? "Windows" : "Linux"} VM (${input.machineType ?? GCP_VM_DEFAULTS.machineType}) in ${input.zone}, on ${input.networkName}/${input.subnetName}.`,
          nextSteps: [
            `1. write_repo_file for each returned file under terraform/gcp-vm/${input.name}/.`,
            `2. run_terraform(envKey, name:'gcp-vm-${input.name}-apply', action:'plan', files:<returned>, stack:'gcp-vm-${input.name}').`,
            `3. request_infra_approval with cloud:'gcp' — emit approval-card fence and STOP.`,
            `4. After apply, report vm_name / public_ip / ssh_command (or rdp_command for Windows).`,
          ],
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Failed to generate GCP VM Terraform." };
    }
  },
};
