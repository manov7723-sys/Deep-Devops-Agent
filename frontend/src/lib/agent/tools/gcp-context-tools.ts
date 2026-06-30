import { prisma } from "@/lib/db/prisma";
import { getGcpAccessToken } from "@/lib/cloud/gcp";
import { listGcpProjects } from "@/lib/cloud/gcp-oauth";
import type { Tool } from "./types";

async function resolveGcp(projectId: string): Promise<{ id: string; gcpProject: string } | null> {
  const cp = await prisma.cloudProvider.findFirst({
    where: { projectId, kind: "gcp" },
    select: { id: true, accountRef: true },
    orderBy: { createdAt: "desc" },
  });
  return cp ? { id: cp.id, gcpProject: cp.accountRef } : null;
}

/** List the GCP projects the connected account can access (so the agent can ask which to use). */
export const listGcpProjectsTool: Tool = {
  name: "list_gcp_projects",
  description:
    "List the Google Cloud projects the connected GCP account can access, so you can ask the user which to " +
    "work in. Returns projectId + name + state. Call before GCP work if the active project isn't set or the " +
    "user wants to switch.",
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
  async execute(_input, ctx) {
    const prov = await resolveGcp(ctx.projectId);
    if (!prov) return { ok: false, error: "No GCP account is connected to this project. Connect one with 'Sign in with Google' on the Cloud providers tab." };
    const tok = await getGcpAccessToken(prov.id);
    if (!tok.ok) return { ok: false, error: `Could not authenticate to GCP: ${tok.error}` };
    const r = await listGcpProjects(tok.accessToken);
    if (!r.ok) return { ok: false, error: r.error };
    return { ok: true, output: { activeProjectId: prov.gcpProject, count: r.projects.length, projects: r.projects } };
  },
};

type SetInput = { gcpProjectId?: string; region?: string };

/** Save the user's chosen GCP project + region for THIS workspace project (the agent remembers it). */
export const setGcpContextTool: Tool<SetInput> = {
  name: "set_gcp_context",
  description:
    "Save the user's chosen GCP project and/or region for THIS workspace project so you (and future chats) " +
    "remember which Google Cloud project to target. Call right after the user picks. The saved context is " +
    "shown to you at the top of each conversation.",
  inputSchema: {
    type: "object",
    properties: {
      gcpProjectId: { type: "string", description: "Chosen GCP project id." },
      region: { type: "string", description: "Chosen region, e.g. us-central1." },
    },
    required: [],
    additionalProperties: false,
  },
  async execute(input, ctx) {
    const cp = await prisma.cloudProvider.findFirst({ where: { projectId: ctx.projectId, kind: "gcp" }, select: { id: true } });
    if (!cp) return { ok: false, error: "No GCP account is connected to this project." };
    const data: Record<string, string> = {};
    if (input.gcpProjectId?.trim()) data.accountRef = input.gcpProjectId.trim();
    if (input.region?.trim()) data.region = input.region.trim();
    if (Object.keys(data).length === 0) return { ok: false, error: "Nothing to save — pass gcpProjectId and/or region." };
    const u = await prisma.cloudProvider.update({ where: { id: cp.id }, data, select: { accountRef: true, region: true } });
    return { ok: true, output: { saved: true, gcpProjectId: u.accountRef, region: u.region } };
  },
};
