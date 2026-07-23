/**
 * Provision Jenkins on AWS — agent tool. Generates Terraform for an EC2
 * instance with Jenkins pre-installed + admin user auto-created, so the
 * user gets a working Jenkins UI URL + credentials at the end of one apply.
 *
 * Pair with the connect_jenkins tool AFTER apply completes — this tool
 * only provisions the server, it doesn't wire it back into the app.
 */
import { prisma } from "@/lib/db/prisma";
import { buildJenkinsVmTerraform, JENKINS_VM_DEFAULTS } from "@/lib/devops/jenkins-vm";
import type { Tool } from "./types";

type Input = {
  name: string;
  region: string;
  envKey?: string;
  vpcId: string;
  subnetId: string;
  instanceType?: string;
  diskGb?: number;
  adminUsername?: string;
  adminPassword: string;
  keyName?: string;
  sshCidr?: string;
  jenkinsCidr?: string;
  existingSecurityGroupIds?: string[];
};

type Output = {
  files: Record<string, string>;
  stack: string;
  summary: string;
  nextSteps: string[];
};

export const provisionJenkinsTool: Tool<Input, Output> = {
  name: "provision_jenkins_vm",
  description:
    "One-click Jenkins on AWS: generate Terraform for an EC2 instance with " +
    "Jenkins pre-installed + admin user auto-created via a Groovy init script. " +
    "Skips the setup wizard. Takes ~5 min end-to-end. Requires an EXISTING VPC " +
    "+ public subnet. NEVER hand-write this HCL. Returns URL, username, password " +
    "as outputs after apply.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "DNS-safe name prefix." },
      region: { type: "string" },
      envKey: { type: "string" },
      vpcId: { type: "string" },
      subnetId: { type: "string", description: "PUBLIC subnet (needs internet + a public IP)." },
      instanceType: { type: "string", description: `Default ${JENKINS_VM_DEFAULTS.instanceType}.` },
      diskGb: { type: "number" },
      adminUsername: { type: "string" },
      adminPassword: { type: "string", description: "Required. Rotate from Manage Jenkins → Users at first login." },
      keyName: { type: "string", description: "Name of an EXISTING AWS EC2 key pair to attach (list with 'aws ec2 describe-key-pairs'). Optional — omit and shell in via SSM." },
      sshCidr: { type: "string", description: "CIDR SSH is restricted to. Default: no SSH rule (SSM only). 0.0.0.0/0 is policy-blocked." },
      jenkinsCidr: { type: "string" },
      existingSecurityGroupIds: {
        type: "array",
        items: { type: "string" },
        description: "Attach these EXISTING SGs instead of creating a new one. When set, sshCidr/jenkinsCidr are ignored (caller owns SG rules). Max 5.",
      },
    },
    required: ["name", "region", "vpcId", "subnetId", "adminPassword"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const cp = await prisma.cloudProvider.findFirst({
      where: { projectId: ctx.projectId, kind: "aws" },
      select: { id: true },
    });
    if (!cp) {
      return { ok: false, error: "No AWS account connected to this project." };
    }
    try {
      const files = buildJenkinsVmTerraform({
        ...input,
        env: input.envKey,
        tags: { CreatedBy: "deepagent-jenkins" },
      });
      return {
        ok: true,
        output: {
          files,
          stack: `jenkins-${input.name}`,
          summary: `Jenkins on ${input.instanceType ?? JENKINS_VM_DEFAULTS.instanceType} in ${input.region}, VPC ${input.vpcId}.`,
          nextSteps: [
            `1. write_repo_file for each returned file under terraform/jenkins/${input.name}/.`,
            `2. run_terraform(envKey, name:'jenkins-${input.name}-apply', action:'plan', files:<returned>, stack:'jenkins-${input.name}').`,
            `3. request_infra_approval with cloud:'aws' — emit the approval-card fence and STOP.`,
            `4. After apply, report jenkins_url + jenkins_admin_username from real outputs. NEVER print jenkins_admin_password in chat — tell the user to check the Jenkins sidebar page (which decrypts + shows it once).`,
            `5. Optional follow-up: call connect_jenkins with the URL + credentials so agent tools can trigger pipelines via API.`,
          ],
        },
      };
    } catch (err) {
      return { ok: false, error: err instanceof Error ? err.message : "Failed to generate Jenkins VM Terraform." };
    }
  },
};
