// Pure base58 tail matcher for the vanity "pump" mint grind — no runtime
// dependencies, no @solana/web3.js, no browser globals, CJS-safe.
//
// Why not bs58/PublicKey per attempt? The last k chars of a base58 string are
// the k least-significant base58 digits of the big-endian integer the bytes
// represent, i.e. `value mod 58^k` rendered in exactly k digits (digit value
// 0 -> char '1'). Computing that remainder needs no full 44-char encode:
// Horner's rule over the 32 bytes, folding into a float64 with an exact
// modulo. For k <= 7, 58^k * 256 < 2^53, so every intermediate is an exact
// integer — measured ~285k matches/s vs ~1.5µs+ per full PublicKey encode
// (~8% of the whole keygen budget at 19k keypairs/s).
//
// Shared by the single-threaded core (lib/vanity.ts, compiled to CommonJS by
// tsconfig.build.json) and the browser Web Worker (lib/vanity.worker.ts),
// which would otherwise each need bs58 and would drag @solana/web3.js into
// the worker bundle.

/** Base58 alphabet (the 58 chars Solana addresses are encoded in). */
export const BASE58_ALPHABET =
  "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Longest grind-able suffix. 58^7 ≈ 2.2e12 attempts is already ~3 years
 *  single-threaded; beyond 7 chars the float64 remainder math would leave
 *  the exact-integer range (58^8 * 256 > 2^53). */
export const MAX_VANITY_SUFFIX_LENGTH = 7;

/** True when every char of `suffix` is a valid base58 char (case matters and
 *  is fully supported; the chars OUTSIDE the alphabet are 0, O, I, l). */
export function isValidVanitySuffix(suffix: string): boolean {
  if (suffix.length === 0 || suffix.length > MAX_VANITY_SUFFIX_LENGTH) {
    return false;
  }
  for (let i = 0; i < suffix.length; i += 1) {
    if (BASE58_ALPHABET.indexOf(suffix[i]) === -1) return false;
  }
  return true;
}

/** True when the base58 encoding of the 32-byte `pubkey` (big-endian, the
 *  exact layout ed25519 public keys and Solana addresses use) ends with the
 *  case-sensitive `suffix`. Callers must pre-validate with
 *  isValidVanitySuffix (the k <= 7 exact-integer bound). */
export function pubkeyTailMatches(pubkey: Uint8Array, suffix: string): boolean {
  const k = suffix.length;
  let modulus = 1;
  for (let i = 0; i < k; i += 1) modulus *= 58;
  // r = integer(pubkey) mod 58^k via Horner (exact float64 for k <= 7).
  let remainder = 0;
  for (let i = 0; i < pubkey.length; i += 1) {
    remainder = (remainder * 256 + pubkey[i]) % modulus;
  }
  // Render the k least-significant base58 digits (least significant LAST),
  // comparing straight against the suffix. Digit value 0 -> '1'.
  for (let i = k - 1; i >= 0; i -= 1) {
    const digit = remainder % 58;
    if (BASE58_ALPHABET.charCodeAt(digit) !== suffix.charCodeAt(i)) {
      return false;
    }
    remainder = Math.floor(remainder / 58);
  }
  return true;
}
