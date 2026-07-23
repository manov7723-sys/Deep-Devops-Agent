import { tmpdir } from "node:os";
import { NextResponse } from "next/server";
import JSZip from "jszip";
import { prisma } from "@/lib/db/prisma";
import { requireProjectAccess } from "@/lib/projects/permissions";
import { decryptSecret } from "@/lib/auth/crypto";
import { resolveAwsExecEnv } from "@/lib/cloud/aws-onboard";
import { runStage } from "@/lib/runner/exec";

/**
 * GET /projects/[slug]/aws/client-vpn/[approvalId]/user-certs/[certId]
 *
 * Re-download a previously-issued per-user cert as a self-contained zip.
 * ovpn assembly resolution order:
 *   1. Stored ovpnBaseEnc from issue time (fast, no AWS call)
 *   2. If empty/missing → call `aws ec2 export-client-vpn-client-configuration`
 *      LIVE against the stored endpointId (using the project's AWS creds)
 *   3. If AWS is unreachable → hand-built .ovpn using stored endpointDns
 *   4. If DNS is also missing → last-resort header (functional connect
 *      requires manual endpoint config, we warn in README)
 *
 * The stored PEMs are decrypted with the same key that encrypted them.
 * Never exposes creds in error responses.
 */
export async function GET(
  _req: Request,
  ctx: { params: Promise<{ slug: string; approvalId: string; certId: string }> },
) {
  const { slug, approvalId, certId } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const projectId = gate.access.project.id;

  const row = await prisma.vpnUserCert.findFirst({
    where: { id: certId, projectId, approvalId },
  });
  if (!row) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });

  const certPem = decryptSecret(row.certPemEnc);
  const keyPem = decryptSecret(row.privateKeyEnc);
  const caPem = decryptSecret(row.caPemEnc);

  // Step 1: try the stored ovpnBase.
  let ovpnBase = row.ovpnBaseEnc ? decryptSecret(row.ovpnBaseEnc) : "";

  // Step 2: if empty/missing, call AWS to get a fresh config.
  if (!ovpnBase.trim() && row.endpointId && row.region) {
    const cp = await prisma.cloudProvider.findFirst({
      where: { projectId, kind: "aws" },
      select: { id: true },
      orderBy: { createdAt: "desc" },
    });
    if (cp) {
      const resolved = await resolveAwsExecEnv(cp.id);
      if (resolved.ok) {
        const res = await runStage({
          command: "aws",
          args: [
            "ec2",
            "export-client-vpn-client-configuration",
            "--client-vpn-endpoint-id",
            row.endpointId,
            "--region",
            row.region,
            "--output",
            "text",
            "--no-cli-pager",
          ],
          cwd: tmpdir(),
          env: { ...resolved.env, AWS_REGION: row.region, AWS_DEFAULT_REGION: row.region },
          timeoutMs: 30_000,
        });
        if (res.exitCode === 0) {
          ovpnBase = res.stdout;
        }
      }
    }
  }

  // Step 3: still empty? Use the fallback header WITH the stored DNS.
  if (!ovpnBase.trim()) {
    ovpnBase = fallbackOvpn(row.endpointDns ?? null, caPem);
  }

  // Splice cert/key into the base config. The base config already has
  // <ca>...</ca> if it came from AWS (step 1 or step 2); the fallback
  // (step 3) embeds ca_cert too. Either way we don't double-embed the CA.
  const ovpn = ovpnBase.trimEnd() +
    "\n\n<cert>\n" + certPem.trim() + "\n</cert>\n\n<key>\n" + keyPem.trim() + "\n</key>\n";

  const stamp = row.issuedAt.toISOString().replace(/:/g, "-").replace(/\..*/, "Z");
  const cnSafe = sanitiseName(row.userName);
  const folder = `${cnSafe}-${stamp}${row.revokedAt ? "-REVOKED" : ""}`;

  const zip = new JSZip();
  const root = zip.folder(folder)!;
  root.file(`${cnSafe}.ovpn`, ovpn);
  root.file(`${cnSafe}.crt`, certPem.trim() + "\n");
  root.file(`${cnSafe}.key`, keyPem.trim() + "\n");
  root.file("ca.crt", caPem.trim() + "\n");

  const remoteLine = ovpn.split("\n").find((l) => l.startsWith("remote "));
  root.file(
    "README.txt",
    [
      `User:      ${row.userName}`,
      `Cert:      serial ${row.serial}`,
      `Endpoint:  ${row.endpointDns ?? "(unknown)"}`,
      `Region:    ${row.region ?? "(unknown)"}`,
      `Issued:    ${row.issuedAt.toISOString()}`,
      row.revokedAt ? `Revoked:   ${row.revokedAt.toISOString()} — will not authenticate against the VPN.` : `Status:    active`,
      ``,
      remoteLine ? `Client will connect to: ${remoteLine}` : `WARNING: no 'remote' line in .ovpn — the endpoint hostname wasn't recoverable. Edit the .ovpn to add: remote <endpoint-dns> 443`,
      ``,
      `Import ${cnSafe}.ovpn into AWS VPN Client / Tunnelblick to connect.`,
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

/**
 * DELETE /projects/[slug]/aws/client-vpn/[approvalId]/user-certs/[certId]
 *
 * Soft-revoke: marks the cert as revoked in the DB. Does NOT push the
 * cert's serial into AWS's Client VPN revocation list — that has to be
 * done in the AWS Console → EC2 → Client VPN Endpoints → Actions →
 * Manage Client Certificate Revocation List. We surface the serial here
 * so operators can copy it over cleanly.
 */
export async function DELETE(
  _req: Request,
  ctx: { params: Promise<{ slug: string; approvalId: string; certId: string }> },
) {
  const { slug, approvalId, certId } = await ctx.params;
  const gate = await requireProjectAccess(slug, "developer");
  if (!gate.ok) return NextResponse.json({ ok: false }, { status: gate.status });
  const projectId = gate.access.project.id;

  const existing = await prisma.vpnUserCert.findFirst({
    where: { id: certId, projectId, approvalId },
    select: { id: true, serial: true, userName: true, revokedAt: true },
  });
  if (!existing) return NextResponse.json({ ok: false, code: "not_found" }, { status: 404 });
  if (existing.revokedAt) {
    return NextResponse.json({ ok: true, alreadyRevoked: true, serial: existing.serial });
  }

  await prisma.vpnUserCert.update({
    where: { id: certId },
    data: { revokedAt: new Date(), revokedById: gate.access.session.userId },
  });

  return NextResponse.json({
    ok: true,
    revoked: true,
    serial: existing.serial,
    note:
      "Marked revoked in the app. To ACTUALLY block VPN access, add this serial to the endpoint's " +
      "Client Certificate Revocation List in AWS Console (Client VPN → Endpoint → Actions → Manage CRL).",
  });
}

// ── helpers ─────────────────────────────────────────────────────────────

function sanitiseName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
}

function fallbackOvpn(dns: string | null, caPem: string): string {
  // If we know the endpoint DNS, emit a proper `remote` line so the .ovpn
  // is directly usable. If not, the user has to hand-edit — README warns.
  const remoteBlock = dns
    ? `remote ${dns} 443\nremote-random-hostname\n`
    : `# WARNING: endpoint DNS unknown — add a line here:\n# remote <endpoint-dns> 443\n`;
  return `client
dev tun
proto udp
${remoteBlock}resolv-retry infinite
nobind
remote-cert-tls server
cipher AES-256-GCM
verb 3

<ca>
${caPem.trim()}
</ca>

reneg-sec 0
`;
}
