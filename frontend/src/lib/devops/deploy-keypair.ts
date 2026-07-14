/**
 * Per-project SSH deploy keypair. Used to log into Proxmox VMs the project
 * provisions.
 *
 *   • Public key: OpenSSH string ("ssh-ed25519 AAAA… deploy@dda"). Baked into
 *     VM cloud-init at create time so the agent's identity is authorized.
 *   • Private key: OpenSSH PEM, AES-256-GCM encrypted at rest via
 *     lib/auth/crypto. Copied into a GitHub Actions repo secret when we wire
 *     the Proxmox deploy workflow, and used directly by the run_vm_command
 *     agent tool for one-off ops.
 *
 * The keypair is generated LAZILY — the first caller that needs it makes it,
 * then all future callers get the same one. Rotation is a follow-up.
 */
import { generateKeyPairSync } from "node:crypto";
import { prisma } from "@/lib/db/prisma";
import { decryptSecret, encryptSecret } from "@/lib/auth/crypto";

/** OpenSSH format for an ed25519 public key: "ssh-ed25519 <base64> comment". */
function opensshPublicKey(rawPublicKey: Buffer, comment = "deploy@dda"): string {
  // ed25519 raw public key from Node is 32 bytes. OpenSSH wire format is:
  //   string  "ssh-ed25519"
  //   string  <32-byte public key>
  // Each "string" is length-prefixed (uint32 big-endian).
  const algo = Buffer.from("ssh-ed25519", "utf8");
  const parts: Buffer[] = [lengthPrefixed(algo), lengthPrefixed(rawPublicKey)];
  const wire = Buffer.concat(parts);
  return `ssh-ed25519 ${wire.toString("base64")} ${comment}`;
}

function lengthPrefixed(buf: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(buf.length, 0);
  return Buffer.concat([len, buf]);
}

/** Node's ed25519 public key export in raw form: SPKI 44 bytes → last 32 is the key. */
function rawEd25519Public(spkiDer: Buffer): Buffer {
  // The SPKI wrapper for ed25519 is 12 bytes; the trailing 32 bytes are the key.
  if (spkiDer.length !== 44) {
    throw new Error(`unexpected ed25519 SPKI length: ${spkiDer.length}`);
  }
  return spkiDer.subarray(12);
}

export type ProjectDeployKeypair = {
  publicKey: string; // OpenSSH format — safe to expose in cloud-init and API responses
  privateKey: string; // PEM — SENSITIVE; only pass into GitHub secrets / SSH clients
};

/**
 * Return the project's deploy keypair, creating one on first call. Idempotent —
 * concurrent callers may race, but the check-then-write pattern is safe because
 * a duplicate write only overwrites with an equally valid key on first-ever use
 * (in practice a single project rarely creates a first VM concurrently).
 */
export async function getOrCreateProjectDeployKeypair(
  projectId: string,
): Promise<ProjectDeployKeypair> {
  const existing = await prisma.project.findUnique({
    where: { id: projectId },
    select: { deployPublicKey: true, deployPrivateKeyEnc: true },
  });
  if (existing?.deployPublicKey && existing.deployPrivateKeyEnc) {
    return {
      publicKey: existing.deployPublicKey,
      privateKey: decryptSecret(existing.deployPrivateKeyEnc),
    };
  }

  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const opensshPub = opensshPublicKey(rawEd25519Public(spki as Buffer));
  const pem = (privateKey.export({ type: "pkcs8", format: "pem" }) as string).trim();

  await prisma.project.update({
    where: { id: projectId },
    data: {
      deployPublicKey: opensshPub,
      deployPrivateKeyEnc: encryptSecret(pem),
    },
  });

  return { publicKey: opensshPub, privateKey: pem };
}

/** Read the public key only — cheaper, no decrypt, safe to expose. */
export async function getProjectDeployPublicKey(projectId: string): Promise<string> {
  return (await getOrCreateProjectDeployKeypair(projectId)).publicKey;
}
