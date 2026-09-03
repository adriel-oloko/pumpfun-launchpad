// Shared display helpers.

/** Shorten a Solana pubkey or signature for display: AAAA...bbbb. */
export function shortAddress(address: string, chars = 4): string {
  if (!address) return "";
  return `${address.slice(0, chars)}...${address.slice(-chars)}`;
}
