import { NextResponse } from "next/server";
import { z } from "zod";
import { createHmac } from "node:crypto";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { envBySlugAndKey } from "@/lib/devops/envs";
import { getAzureStorageAccountKey } from "@/lib/cloud/azure";
import { audit } from "@/lib/audit/log";
import { extractRequestMeta } from "@/lib/auth/request-meta";

/**
 * Delete a Terraform state file from the env's configured remote backend.
 *
 * WHY THIS EXISTS (2026-07):
 * When a `terraform apply` succeeds partway (resources created) but fails to
 * upload the state — the "network hiccup at the 11-minute mark" incident —
 * the state file ends up orphaned. A retry either tries to CREATE things that
 * already exist (409 halfway through) or refuses to touch the corrupted
 * state. Recovery normally means `terraform import` per resource; this
 * endpoint gives the shortcut: delete the state, next apply behaves like the
 * first one.
 *
 * DESTRUCTIVE: after this call, Terraform has no memory of resources it
 * previously provisioned for this stack. Meant to be paired with
 * `terraform destroy` in the UI — destroy first (which needs the state to
 * work), then delete-state — not run against a live stack where you want to
 * keep the resources.
 *
 * Azure backend only for now. S3 / GCS would follow the same shape (blob
 * delete via cloud-appropriate signed request), slotting in below.
 *
 * Auth: uses the storage account's shared key (fetched via
 * `getAzureStorageAccountKey`, which is an ARM listKeys call the app's
 * connected principal is authorised for by virtue of having created the
 * account in the first place). Shared key is simpler than a data-plane
 * OAuth token here: the token audience for Storage differs from ARM, and
 * granting Blob Data Contributor is an extra role the app doesn't
 * necessarily hold.
 */
const Body = z.object({
  /** Terraform stack name — the exact `stack` value used by the apply that
   *  wrote the state. Determines the blob key. Defaults to "infra" to match
   *  the default `name` field in the POST /terraform route. */
  stack: z.string().trim().min(1).max(120).default("infra"),
});

export async function DELETE(req: Request, ctx: { params: Promise<{ slug: string; key: string }> }) {
  const { slug, key } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });

  const env = await envBySlugAndKey(gate.access.project.id, key);
  if (!env) return NextResponse.json({ ok: false, code: "env_not_found" }, { status: 404 });

  const body = Body.safeParse(await req.json().catch(() => ({})));
  if (!body.success) {
    return NextResponse.json(
      { ok: false, code: "invalid_request", message: body.error.errors[0]?.message },
      { status: 400 },
    );
  }
  const stack = body.data.stack;

  const envRow = await prisma.env.findUnique({
    where: { id: env.id },
    select: {
      id: true,
      cloudProviderId: true,
      tfBackendAzureResourceGroup: true,
      tfBackendAzureStorageAccount: true,
      tfBackendAzureContainer: true,
      project: { select: { id: true } },
    },
  });
  if (!envRow) return NextResponse.json({ ok: false, code: "env_not_found" }, { status: 404 });

  const rg = envRow.tfBackendAzureResourceGroup?.trim();
  const account = envRow.tfBackendAzureStorageAccount?.trim();
  const container = envRow.tfBackendAzureContainer?.trim();
  if (!rg || !account || !container) {
    return NextResponse.json(
      {
        ok: false,
        code: "no_backend",
        message:
          "This env has no Azure state backend configured — nothing to delete. (S3 / GCS delete not implemented yet.)",
      },
      { status: 409 },
    );
  }
  if (!envRow.cloudProviderId) {
    return NextResponse.json(
      { ok: false, code: "no_cloud", message: "Env has no cloud provider connected." },
      { status: 409 },
    );
  }

  // Same blob path convention terraform-run stamps into the backend block.
  // If that convention changes, this must change too — no metadata links them.
  const blobPath = `${envRow.project.id}/${key}/${stack}/terraform.tfstate`;

  const keyRes = await getAzureStorageAccountKey(envRow.cloudProviderId, rg, account);
  if (!keyRes.ok) {
    return NextResponse.json(
      { ok: false, code: "storage_key_failed", message: keyRes.error },
      { status: 502 },
    );
  }

  const dateHeader = new Date().toUTCString();
  const canonicalizedResource = `/${account}/${container}/${blobPath}`;
  // Azure Storage SharedKey signing — DELETE-blob form. Empty values for the
  // headers we don't set; x-ms-* headers are lex-sorted in the canonicalized
  // headers block.
  const stringToSign = [
    "DELETE", // HTTP verb
    "", // Content-Encoding
    "", // Content-Language
    "", // Content-Length
    "", // Content-MD5
    "", // Content-Type
    "", // Date (goes in x-ms-date instead)
    "", // If-Modified-Since
    "", // If-Match
    "", // If-None-Match
    "", // If-Unmodified-Since
    "", // Range
    // Canonicalized headers, lex-sorted, joined by \n, trailing \n
    `x-ms-date:${dateHeader}\nx-ms-version:2023-11-03`,
    canonicalizedResource,
  ].join("\n");
  const signature = createHmac("sha256", Buffer.from(keyRes.key, "base64"))
    .update(stringToSign, "utf8")
    .digest("base64");
  const authHeader = `SharedKey ${account}:${signature}`;

  const url = `https://${account}.blob.core.windows.net/${container}/${encodeURI(blobPath)}`;
  const res = await fetch(url, {
    method: "DELETE",
    headers: {
      Authorization: authHeader,
      "x-ms-date": dateHeader,
      "x-ms-version": "2023-11-03",
    },
  }).catch((e) => ({ ok: false, status: 0, text: async () => String(e) }) as unknown as Response);

  if (res.status === 404) {
    return NextResponse.json({
      ok: true,
      status: "already_gone",
      message: `No state file at ${blobPath} — nothing to delete.`,
    });
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    return NextResponse.json(
      {
        ok: false,
        code: "blob_delete_failed",
        message: `Blob delete returned ${res.status}: ${text.slice(0, 300)}`,
      },
      { status: 502 },
    );
  }

  const meta = extractRequestMeta(req);
  await audit({
    userId: gate.access.session.userId,
    projectId: gate.access.project.id,
    action: "terraform.state_deleted",
    targetType: "env",
    targetId: env.id,
    ipAddress: meta.ipAddress,
    userAgent: meta.userAgent,
    metadata: { stack, blob: blobPath, account, container },
  });

  return NextResponse.json({
    ok: true,
    status: "deleted",
    message: `Deleted Terraform state at ${account}/${container}/${blobPath}. The next apply for stack "${stack}" starts from scratch.`,
  });
}
