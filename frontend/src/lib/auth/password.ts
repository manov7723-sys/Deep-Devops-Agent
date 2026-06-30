import argon2 from "argon2";

// argon2id with the library defaults (m=64MiB, t=3, p=4). Suitable for an
// interactive login on a server-class box. Tune via env if profiling shows
// per-request hashing exceeds budget.
const OPTS: argon2.Options = { type: argon2.argon2id };

export function hashPassword(plain: string): Promise<string> {
  return argon2.hash(plain, OPTS);
}

export async function verifyPassword(hash: string, plain: string): Promise<boolean> {
  try {
    return await argon2.verify(hash, plain);
  } catch {
    return false;
  }
}
