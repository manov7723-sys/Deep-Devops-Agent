import { readFile } from "node:fs/promises";
import { join, normalize } from "node:path";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { prisma } from "@/lib/db/prisma";
import { findStoredAttachment, teamChatUploadDir } from "@/lib/chat/project-chat";

/**
 * GET /projects/[slug]/team-chat/messages/[id]/attachments/[attachmentId]
 *
 * Stream a message attachment. Files never live at a public URL — the disk
 * path is scoped under `uploads/team-chat/<projectId>/…` and served through
 * this endpoint after two checks:
 *   1. Viewer has project access (Membership + Sec-Fetch-Site same-origin).
 *   2. The attachment id is actually listed on the referenced message row
 *      AND that message belongs to the same project. Guards against a
 *      caller trying to fetch a foreign project's file by guessing the id.
 *
 * A hit outside the upload dir (path traversal via a poisoned record) is
 * rejected before the read — the record's `path` is `projectId/uuid/name`,
 * and we normalize + prefix-check to reject anything that resolves elsewhere.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string; id: string; attachmentId: string }> },
): Promise<Response> {
  const { slug, id, attachmentId } = await ctx.params;
  const gate = await requireProjectAccess(slug, "viewer");
  if (!gate.ok) return new Response("forbidden", { status: gate.status });

  const message = await prisma.projectMessage.findFirst({
    where: { id, projectId: gate.access.project.id },
    select: { attachments: true },
  });
  if (!message) return new Response("not found", { status: 404 });

  const found = findStoredAttachment(message.attachments, attachmentId);
  if (!found) return new Response("not found", { status: 404 });

  const baseDir = normalize(teamChatUploadDir());
  const abs = normalize(join(baseDir, found.path));
  // Path-traversal guard — an entry whose stored path escapes the upload dir
  // (e.g. via `..` segments injected somewhere) must not be readable. We
  // require the resolved absolute path to sit under the base dir.
  if (!abs.startsWith(baseDir)) return new Response("bad request", { status: 400 });

  let bytes: Buffer;
  try {
    bytes = await readFile(abs);
  } catch {
    return new Response("attachment file missing on disk", { status: 410 });
  }

  const isImage = found.kind === "image";
  const headers = new Headers({
    "content-type": found.mime,
    "content-length": String(bytes.byteLength),
    // Inline for images (browser renders them in the message bubble); attachment
    // for everything else so a click downloads with the original filename.
    "content-disposition": `${isImage ? "inline" : "attachment"}; filename="${found.name.replace(/"/g, "")}"`,
    // Files are immutable per attachment id (a new upload gets a new id), so
    // the browser can cache aggressively without staleness risk.
    "cache-control": "private, max-age=3600, immutable",
    // Never let this be embedded/executed cross-origin.
    "x-content-type-options": "nosniff",
  });

  return new Response(new Uint8Array(bytes), { status: 200, headers });
}
