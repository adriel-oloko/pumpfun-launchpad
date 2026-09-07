// Minimal ambient typings for `libsodium-wrappers` (0.7.15). The package
// ships no @types and there is no @types/libsodium-wrappers on the registry,
// so only the surface the launchpad uses is declared here (ed25519 seed
// keygen + random seeds, the vanity-mint grind API). Everything else stays
// untyped/any, which is fine: this file exists so `import sodium from
// "libsodium-wrappers"` typechecks under both tsconfig.json (Next/bundler)
// and tsconfig.build.json (CommonJS) without adding a runtime dependency.
//
// NOTE: lib/vanity.ts pulls this file into the program with a
// `/// <reference path="./libsodium-wrappers.d.ts" />` directive so the
// ambient module also applies to the tsconfig.build.json program (whose
// explicit include list does not glob lib/*.d.ts).
declare module "libsodium-wrappers" {
  /** Result of crypto_sign_seed_keypair: the 64-byte private key is
   *  (seed || publicKey), the exact layout @solana/web3.js Keypair
   *  round-trips via Keypair.fromSecretKey. */
  export interface KeyPair {
    publicKey: Uint8Array;
    privateKey: Uint8Array;
    keyType: "ed25519";
  }

  /** The subset of the libsodium-wrappers API the launchpad uses. */
  export interface Sodium {
    /** Resolves once the (asm.js/wasm) backend is initialized. */
    ready: Promise<void>;
    /** Returns `length` cryptographically random bytes. */
    randombytes_buf(length: number): Uint8Array;
    /** Derives an ed25519 keypair from a 32-byte seed. */
    crypto_sign_seed_keypair(seed: Uint8Array): KeyPair;
  }

  const sodium: Sodium;
  export default sodium;
}
