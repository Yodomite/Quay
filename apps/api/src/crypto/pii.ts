import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

// AES-256-GCM at-rest encryption for PII (SEP-12 KYC field values). Each blob
// carries its own random IV and auth tag, so a compromised DB row alone is
// useless without KYC_ENCRYPTION_KEY — and any tampering fails to decrypt
// rather than silently returning corrupted plaintext.

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // 96-bit IV is the GCM-recommended size

/** Parses KYC_ENCRYPTION_KEY (64 hex chars = 32 bytes) into a usable key. */
export function parsePiiKey(hex: string): Buffer {
  const key = Buffer.from(hex, "hex");
  if (key.length !== 32) {
    throw new Error(
      `KYC_ENCRYPTION_KEY must be 32 bytes as hex (64 hex chars), got ${key.length} bytes. ` +
        `Generate one with: node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"`,
    );
  }
  return key;
}

/** Encrypts `plaintext`, returning a single base64 blob: iv || authTag || ciphertext. */
export function encryptPii(plaintext: string, key: Buffer): string {
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, ciphertext]).toString("base64");
}

/** Inverse of {@link encryptPii}. Throws if the blob was tampered with or the key is wrong. */
export function decryptPii(blob: string, key: Buffer): string {
  const raw = Buffer.from(blob, "base64");
  const iv = raw.subarray(0, IV_LENGTH);
  const authTag = raw.subarray(IV_LENGTH, IV_LENGTH + 16);
  const ciphertext = raw.subarray(IV_LENGTH + 16);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf8");
}
