import { randomBytes } from "node:crypto";

const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

function base36(bytes: Buffer): string {
  let out = "";
  for (const b of bytes) out += ALPHABET[b % 36];
  return out;
}

/** Prefixed internal id, e.g. "lnk_3f9k2a7q1z". */
export function newId(prefix: string): string {
  return `${prefix}_${base36(randomBytes(10))}`;
}

/**
 * On-chain correlation reference, embedded as the Stellar MEMO_TEXT.
 * Must stay <= 28 bytes. Format "pl_" + 12 chars = 15 bytes. Safe.
 */
export function newReference(): string {
  return `pl_${base36(randomBytes(12))}`;
}

/**
 * SEP-23 correlation id, embedded inside the destination M-address itself
 * (CORRELATION=muxed). A uint64 as a decimal string; top bit cleared so it
 * also fits a signed int64, avoiding sign edge cases in any downstream tooling.
 */
export function newMuxedId(): string {
  const buf = randomBytes(8);
  buf.writeUInt8(buf.readUInt8(0) & 0x7f, 0);
  return BigInt(`0x${buf.toString("hex")}`).toString();
}
