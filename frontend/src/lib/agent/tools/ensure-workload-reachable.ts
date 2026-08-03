import { prisma } from "@/lib/db/prisma";
import { decryptSecret } from "@/lib/auth/crypto";
import { parseEksClusterRef } from "@/lib/cloud/eks-access";
import { ensureNodeSgAllowsWorkloadPort } from "@/lib/cloud/eks-node-sg";
import type { Tool } from "./types";

/**
 * Review & heal the EKS node security group so an already-deployed workload's
 * pod port is reachable from the internet-facing NLB/ALB the AWS Load Balancer
 * Controller created. Standalone counterpart to the auto-open block inside
 * `deploy_my_app` — the tool that runs when the deploy has already happened
 * and the app is still timing out.
 *
 * Historically the operator had to hand-authorize this rule: neither the AWS
 * LB Controller nor the in-tree cloud controller manages it for
 * `target-type: ip`, which every generated manifest uses. Symptom is the
 * silent ERR_CONNECTION_TIMED_OUT — pod Ready, target group healthy (LB
 * health checks originate INSIDE the VPC and succeed regardless), URL dead.
 *
 * Idempotent: duplicate rules are treated as success. Safe to re-run.
 */
export const ensureWorkloadReachableTool: Tool<
  {
    envKey: string;
    /** Pod's containerPort (usually 3000 for Node/Next.js, 8000/8080 for Python/Java). */
    port: number;
    /**
     * CIDR to admit. Defaults to 0.0.0.0/0 — required for internet-facing NLB
     * with `preserveClientIP=true` (the LBC default), which forwards the
     * CLIENT's public IP to the pod rather than the LB's ENI. Narrow to the
     * VPC CIDR only if the workload is intentionally VPC-internal.
     */
    sourceCidr?: string;
  },
  {
    clusterName: string;
    port: number;
    changed: boolean;
    nodeSecurityGroups: string[];
    message: string;
  }
> = {
  name: "ensure_workload_reachable",
  description:
    "Review the EKS node security group and open the pod's containerPort inbound so an internet-facing NLB/ALB (target-type: ip) can actually reach the pod. Use as soon as a deployed app's public URL returns ERR_CONNECTION_TIMED_OUT even though `kubectl get pods` shows the pod Ready and `kubectl get endpoints` shows a bound endpoint. The app CAN do this via ec2:AuthorizeSecurityGroupIngress — do NOT tell the user to run `aws ec2 authorize-security-group-ingress` or open the AWS console. Idempotent: reports 'already admits' when the rule is already there, 'Opened port N' when a new rule was created. Non-fatal on IAM failure — the returned error is the exact rule the user needs to add manually.",
  inputSchema: {
    type: "object",
    properties: {
      envKey: {
        type: "string",
        description: "Env whose EKS cluster's node SG to review + heal.",
      },
      port: {
        type: "integer",
        minimum: 1,
        maximum: 65535,
        description:
          "The pod's containerPort — the port the app actually listens on, NOT the Service port. For a Next.js deploy the pod usually listens on 3000; look at `kubectl get endpoints <svc>` — the port after the ':' is what to pass here.",
      },
      sourceCidr: {
        type: "string",
        description:
          "Source CIDR to admit. Default 0.0.0.0/0 (required for internet-facing NLB + preserveClientIP=true). Only override for intentionally VPC-internal workloads.",
      },
    },
    required: ["envKey", "port"],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const env = await prisma.env.findFirst({
      where: { projectId: ctx.projectId, key: input.envKey },
      select: { id: true, cloudProviderId: true, kubeconfigRef: true },
    });
    if (!env) return { ok: false, error: `Env "${input.envKey}" not found on this project.` };
    if (!env.cloudProviderId) {
      return { ok: false, error: `Env "${input.envKey}" has no cloud provider connected.` };
    }

    const cp = await prisma.cloudProvider.findFirst({
      where: { id: env.cloudProviderId, kind: "aws" },
      select: { id: true },
    });
    if (!cp) {
      return {
        ok: false,
        error:
          `Env "${input.envKey}"'s connected cloud is not AWS. This tool only heals EKS node SGs — ` +
          `Azure/GCP LoadBalancer services get their firewall rules from the cloud controller directly.`,
      };
    }

    if (!env.kubeconfigRef) {
      return {
        ok: false,
        error:
          `Env "${input.envKey}" has no kubeconfig wired. ` +
          `Connect the cluster first (Environments → Connect cluster).`,
      };
    }
    let kubeconfig: string;
    try {
      kubeconfig = decryptSecret(env.kubeconfigRef);
    } catch {
      return {
        ok: false,
        error: `Could not decrypt env "${input.envKey}"'s stored kubeconfig — reconnect the cluster.`,
      };
    }
    const eksRef = parseEksClusterRef(kubeconfig);
    if (!eksRef) {
      return {
        ok: false,
        error:
          `Env "${input.envKey}"'s kubeconfig doesn't reference an EKS cluster. ` +
          `This tool only handles EKS — reconnect the env to an EKS cluster.`,
      };
    }

    const sg = await ensureNodeSgAllowsWorkloadPort({
      cloudProviderId: cp.id,
      region: eksRef.region,
      clusterName: eksRef.clusterName,
      port: input.port,
      sourceCidr: input.sourceCidr,
    });
    if (!sg.ok) return { ok: false, error: sg.error };

    return {
      ok: true,
      output: {
        clusterName: eksRef.clusterName,
        port: sg.port,
        changed: sg.changed,
        nodeSecurityGroups: sg.nodeSecurityGroups,
        message: sg.message,
      },
    };
  },
};
