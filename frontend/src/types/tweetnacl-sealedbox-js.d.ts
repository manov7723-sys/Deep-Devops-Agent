declare module "tweetnacl-sealedbox-js" {
  /** libsodium crypto_box_seal / _open (X25519 sealed box). */
  const sealedbox: {
    seal(message: Uint8Array, publicKey: Uint8Array): Uint8Array;
    open(ciphertext: Uint8Array, publicKey: Uint8Array, secretKey: Uint8Array): Uint8Array | null;
    readonly overheadLength: number;
  };
  export default sealedbox;
}
