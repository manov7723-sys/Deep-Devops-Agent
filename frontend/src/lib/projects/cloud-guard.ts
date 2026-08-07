/**
 * Reject cloud-specific actions on a project that targets a different cloud.
 *
 * The Connections page used to render the AWS, Azure and GCP database panels
 * unconditionally, so an AWS project was offered "Connect Azure Database".
 * Hiding those panels fixes the UI, but the ROUTES stayed open — a stale tab,
 * a bookmarked URL, or the agent calling the wrong tool would still POST and
 * write a Kubernetes Secret pointing at a database the project can't reach.
 * A half-configured `app-db` is worse than a clear rejection, because the app
 * starts and then fails at query time with a connection error that names
 * nothing useful.
 *
 * Legacy projects with a NULL `cloud` are allowed through — narrowing them
 * would break the only path they have to connect anything. Same rule the UI
 * uses, so the two can't disagree.
 */
import { prisma } from "@/lib/db/prisma";

export type CloudKind = "aws" | "azure" | "gcp" | "proxmox";

export type CloudGuardResult =
  | { ok: true }
  | { ok: false; status: 409; message: string };

export async function requireProjectCloud(
  projectId: string,
  required: CloudKind,
): Promise<CloudGuardResult> {
  const project = await prisma.project.findUnique({
    where: { id: projectId },
    select: { cloud: true, name: true },
  });
  if (!project) {
    // The caller's own access gate already 404s for unknown projects; if we
    // get here the row vanished mid-request. Let it through rather than
    // inventing a second not-found path — the action will fail downstream
    // with a more specific error.
    return { ok: true };
  }
  if (!project.cloud) return { ok: true }; // legacy row, no cloud chosen yet
  if (project.cloud === required) return { ok: true };

  return {
    ok: false,
    status: 409,
    message:
      `This project targets ${project.cloud.toUpperCase()}, so a ${required.toUpperCase()} database can't be connected to it. ` +
      `Use the ${project.cloud.toUpperCase()} option on the Connections page, or create a separate ${required.toUpperCase()} project.`,
  };
}
