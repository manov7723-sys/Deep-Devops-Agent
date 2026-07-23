/**
 * Azure VM agent tool — generate Terraform for a single Azure Linux or
 * Windows VM inside an EXISTING VNet + subnet. Azure's equivalent of AWS
 * EC2. Assumes the user has already created the VNet (via azure-vnet-create
 * or manually) — pair with azure-vnet-create when they haven't.
 */
import { prisma } from "@/lib/db/prisma";
import { buildAzureVmTerraform, AZURE_VM_DEFAULTS, type AzureVmImage } from "@/lib/devops/azure-vm";
import type { Tool } from "./types";

type Input = {
  name: string;
  location: string;
  envKey?: string;
  resourceGroupName: string;
  vnetName: string;
  subnetName: string;
  image?: AzureVmImage;
  vmSize?: string;
  diskGb?: number;
  publicIp?: boolean;
  adminUsername?: string;
  sshPublicKey?: string;
  adminPassword?: string;
  allowSsh?: boolean;
  allowRdp?: boolean;
  allowHttp?: boolean;
  allowHttps?: boolean;
  sshCidr?: string;
};

type Output = {
  files: Record<string, string>;
  stack: string;
  summary: string;
  nextSteps: string[];
};

export const generateAzureVmTerraformTool: Tool<Input, Output> = {
  name: "generate_azure_vm_terraform",
  description:
    "Generate Terraform for a single Azure VM in an EXISTING VNet/subnet. " +
    "Linux VMs need sshPublicKey; Windows VMs need adminPassword. NEVER " +
    "hand-write Azure VM HCL. Commit under terraform/azure-vm/<name>/ then " +
    "plan + request_infra_approval.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string" },
      location: { type: "string", description: "Azure region — must match the VNet's region." },
      envKey: { type: "string" },
      resourceGroupName: { type: "string", description: "Resource group that owns the VNet." },
      vnetName: { type: "string" },
      subnetName: { type: "string" },
      image: { type: "string", enum: ["ubuntu-22.04", "ubuntu-24.04", "debian-12", "rhel-9", "windows-2022"] },
      vmSize: { type: "string", description: `Default ${AZURE_VM_DEFAULTS.vmSize}.` },
      diskGb: { type: "number" },
      publicIp: { type: "boolean" },
      adminUsername: { type: "string" },
      sshPublicKey: { type: "string", description: "Required for Linux images. Full ssh-rsa/ssh-ed25519 line." },
      adminPassword: { type: "string", description: "Required for Windows images. Never printed in the agent's reply." },
      allowSsh: { type: "boolean" },
      allowRdp: { type: "boolean" },
      allowHttp: { type: "boolean" },
      allowHttps: { type: "boolean" },
      sshCidr: { type: "string", description: "CIDR SSH is restricted to. Blank = 0.0.0.0/0." },
    },
    required: ["name", "location", "resourceGroupName", "vnetName", "subnetName"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const cp = await prisma.cloudProvider.findFirst({
      where: { projectId: ctx.projectId, kind: "azure" },
      select: { id: true },
    });
    if (!cp) {
      return { ok: false, error: "No Azure account connected to this project." };
    }
    try {
      const files = buildAzureVmTerraform({
        ...input,
        env: input.envKey,
        tags: { CreatedBy: "deepagent-azure-vm" },
      });
      const image = input.image ?? AZURE_VM_DEFAULTS.image;
      return {
        ok: true,
        output: {
          files,
          stack: `azure-vm-${input.name}`,
          summary: `Azure ${image === "windows-2022" ? "Windows" : "Linux"} VM (${input.vmSize ?? AZURE_VM_DEFAULTS.vmSize}) in ${input.location}, attached to ${input.vnetName}/${input.subnetName}.`,
          nextSteps: [
            `1. write_repo_file for each returned file under terraform/azure-vm/${input.name}/.`,
            `2. run_terraform(envKey, name:'azure-vm-${input.name}-apply', action:'plan', files:<returned>, stack:'azure-vm-${input.name}').`,
            `3. request_infra_approval with cloud:'azure' — emit the approval-card fence and STOP.`,
            `4. After apply, report vm_name / public_ip / ssh_command from the real outputs.`,
          ],
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Failed to generate Azure VM Terraform." };
    }
  },
};
