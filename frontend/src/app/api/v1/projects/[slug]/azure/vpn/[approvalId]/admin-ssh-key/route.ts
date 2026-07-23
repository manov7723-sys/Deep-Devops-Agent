import { NextResponse } from "next/server";
import JSZip from "jszip";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { decryptSecret } from "@/lib/auth/crypto";

/**
 * GET /projects/[slug]/azure/vpn/[approvalId]/admin-ssh-key
 *
 * Returns a zip with the auto-generated admin SSH keypair used to build this
 * VPN VM. The submit endpoint stashed the encrypted private key on the
 * approval's payloadJson; here we decrypt + hand it back as downloadable
 * files. Zip layout:
 *
 *   azure-vpn-<name>-admin-ssh/
 *     <name>-admin.pem           (private key, mode 0600)
 *     <name>-admin.pem.pub       (public key, matches the VM's authorized_keys)
 *     README.txt                 (how to use)
 *
 * The private key never leaves the server plaintext — encrypted at rest,
 * decrypted only on this request path with viewer-level permission gate.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string; approvalId: string }> },
) {
  const { slug, approvalId } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const projectId = gate.access.project.id;

  const approval = await prisma.approval.findFirst({
    where: { id: approvalId, projectId, kind: "terraform" },
    select: { id: true, payloadJson: true, title: true },
  });
  if (!approval) {
    return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
  }

  const payload = (approval.payloadJson ?? {}) as {
    stack?: string;
    _adminSshKey?: {
      privateKeyEnc?: string;
      publicKey?: string;
      adminUsername?: string;
    };
  };
  if (!payload.stack?.startsWith("azure-vpn-")) {
    return NextResponse.json(
      { ok: false, code: "not_azure_vpn", message: "Not an Azure VPN approval." },
      { status: 400 },
    );
  }
  const meta = payload._adminSshKey;
  if (!meta?.privateKeyEnc) {
    return NextResponse.json(
      {
        ok: false,
        code: "no_admin_key",
        message:
          "No auto-generated admin SSH key on this approval. Either the VPN was created with a user-pasted key (paste it yourself) or the approval was made before this feature landed.",
      },
      { status: 404 },
    );
  }

  let privateKey: string;
  try {
    privateKey = decryptSecret(meta.privateKeyEnc);
  } catch (e) {
    return NextResponse.json(
      {
        ok: false,
        code: "decrypt_failed",
        message: `Could not decrypt the stored admin SSH key: ${e instanceof Error ? e.message : String(e)}`,
      },
      { status: 500 },
    );
  }

  const stack = payload.stack;
  const name = stack.slice("azure-vpn-".length);
  const adminUsername = meta.adminUsername ?? "azureuser";
  const publicKey = (meta.publicKey ?? "").trim();

  const zip = new JSZip();
  const folder = `azure-vpn-${name}-admin-ssh`;
  const root = zip.folder(folder)!;
  root.file(`${name}-admin.pem`, privateKey);
  root.file(`${name}-admin.pem.pub`, publicKey + "\n");
  root.file(
    "README.txt",
    [
      `Azure VPN admin SSH key — ${name}`,
      ``,
      `This is the private key that was auto-generated when you created the`,
      `Azure VPN endpoint. It's authorized on the VM's ${adminUsername} account`,
      `for admin SSH access.`,
      ``,
      `HOW TO USE`,
      `----------`,
      `1. chmod 600 ${name}-admin.pem`,
      `2. ssh -i ${name}-admin.pem ${adminUsername}@<public-ip>`,
      ``,
      `The <public-ip> comes from the terraform output client_vpn_dns_name`,
      `(or from the Azure Portal → VM → Overview → Public IP).`,
      ``,
      `WHEN TO USE`,
      `-----------`,
      `You almost never need this — cloud-init sets up OpenVPN automatically`,
      `on first boot. Keep this file around in case you ever need to debug`,
      `the openvpn systemd unit or check /var/log/deepagent-openvpn-startup.log.`,
      ``,
      `SECURITY`,
      `--------`,
      `${name}-admin.pem is a private key. Anyone with this file can SSH into`,
      `the VPN VM as ${adminUsername}. Store it somewhere safe.`,
      ``,
    ].join("\n"),
  );

  const buf = await zip.generateAsync({ type: "nodebuffer" });
  return new Response(new Uint8Array(buf), {
    status: 200,
    headers: {
      "Content-Type": "application/zip",
      "Content-Disposition": `attachment; filename="${folder}.zip"`,
      "Cache-Control": "no-store",
    },
  });
}
