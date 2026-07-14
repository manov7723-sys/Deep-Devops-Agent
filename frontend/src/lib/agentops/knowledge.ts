/**
 * Knowledge base — Phase 9 covers WRITTEN docs only. Uploaded files +
 * chunking + pgvector embeddings ship in a later phase using KnowledgeChunk.
 *
 * Excerpt is auto-derived from the body (first ~200 chars) if not supplied.
 */
import type { KnowledgeDoc, KnowledgeType } from "@prisma/client";
import { prisma } from "@/lib/db/prisma";

const EXCERPT_LEN = 200;

function deriveExcerpt(body: string, override?: string): string {
  if (override && override.trim().length > 0) return override.trim();
  const flat = body.replace(/\s+/g, " ").trim();
  return flat.length > EXCERPT_LEN ? `${flat.slice(0, EXCERPT_LEN).trimEnd()}…` : flat;
}

export type KnowledgeRow = {
  id: string;
  title: string;
  excerpt: string;
  type: KnowledgeType;
  tags: string[];
  envKey: string | null;
  authorName: string | null;
  createdAt: string;
  updatedAt: string;
};

export type KnowledgeDetailRow = KnowledgeRow & { body: string | null };

function summary(
  d: KnowledgeDoc & {
    env: { key: string } | null;
    author: { name: string } | null;
  },
): KnowledgeRow {
  return {
    id: d.id,
    title: d.title,
    excerpt: d.excerpt,
    type: d.type,
    tags: d.tags,
    envKey: d.env?.key ?? null,
    authorName: d.author?.name ?? null,
    createdAt: d.createdAt.toISOString(),
    updatedAt: d.updatedAt.toISOString(),
  };
}

export async function listKnowledge(projectId: string): Promise<KnowledgeRow[]> {
  const rows = await prisma.knowledgeDoc.findMany({
    where: { projectId, source: "written" },
    orderBy: { updatedAt: "desc" },
    include: { env: { select: { key: true } }, author: { select: { name: true } } },
  });
  return rows.map(summary);
}

export async function getKnowledge(
  projectId: string,
  id: string,
): Promise<KnowledgeDetailRow | null> {
  const d = await prisma.knowledgeDoc.findFirst({
    where: { id, projectId },
    include: { env: { select: { key: true } }, author: { select: { name: true } } },
  });
  if (!d) return null;
  return { ...summary(d), body: d.body };
}

export type CreateKnowledgeArgs = {
  projectId: string;
  authorUserId: string;
  envId?: string;
  title: string;
  body: string;
  type: KnowledgeType;
  tags: string[];
  excerpt?: string;
};

export async function createKnowledge(args: CreateKnowledgeArgs): Promise<KnowledgeRow> {
  const created = await prisma.knowledgeDoc.create({
    data: {
      projectId: args.projectId,
      authorUserId: args.authorUserId,
      envId: args.envId ?? null,
      title: args.title,
      body: args.body,
      excerpt: deriveExcerpt(args.body, args.excerpt),
      type: args.type,
      tags: args.tags,
      source: "written",
      ingestStatus: "ready",
    },
    include: { env: { select: { key: true } }, author: { select: { name: true } } },
  });
  return summary(created);
}

export type PatchKnowledgeArgs = Partial<{
  title: string;
  body: string;
  type: KnowledgeType;
  tags: string[];
  excerpt: string;
}>;

export type PatchKnowledgeResult =
  { ok: true; doc: KnowledgeRow } | { ok: false; code: "not_found" };

export async function patchKnowledge(
  projectId: string,
  id: string,
  patch: PatchKnowledgeArgs,
): Promise<PatchKnowledgeResult> {
  const existing = await prisma.knowledgeDoc.findFirst({
    where: { id, projectId, source: "written" },
    select: { id: true, body: true },
  });
  if (!existing) return { ok: false, code: "not_found" };

  const nextBody = patch.body ?? existing.body ?? "";
  const nextExcerpt =
    patch.excerpt !== undefined
      ? deriveExcerpt(nextBody, patch.excerpt)
      : patch.body !== undefined
        ? deriveExcerpt(nextBody)
        : undefined;

  const updated = await prisma.knowledgeDoc.update({
    where: { id },
    data: {
      ...(patch.title !== undefined && { title: patch.title }),
      ...(patch.body !== undefined && { body: patch.body }),
      ...(patch.type !== undefined && { type: patch.type }),
      ...(patch.tags !== undefined && { tags: patch.tags }),
      ...(nextExcerpt !== undefined && { excerpt: nextExcerpt }),
    },
    include: { env: { select: { key: true } }, author: { select: { name: true } } },
  });
  return { ok: true, doc: summary(updated) };
}

export async function deleteKnowledge(projectId: string, id: string): Promise<boolean> {
  const { count } = await prisma.knowledgeDoc.deleteMany({ where: { id, projectId } });
  return count > 0;
}
