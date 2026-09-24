import { createCipheriv, createDecipheriv, randomBytes, createHash } from "crypto";

const DEFAULT_DEV_KEY = "cloud-worker-local-dev-secret-key-32bytes";

function getMasterKey(masterKey?: string): Buffer {
  const keySource = masterKey || process.env.ENCRYPTION_KEY || process.env.SESSION_SECRET || DEFAULT_DEV_KEY;
  return createHash("sha256").update(keySource).digest();
}

export interface EncryptedPayload {
  cipherText: string;
  iv: string;
  tag: string;
}

/**
 * Encrypts sensitive credentials (such as API keys or subscription JSON) using AES-256-GCM.
 */
export function encryptCredential(plainText: string, masterKey?: string): EncryptedPayload {
  const key = getMasterKey(masterKey);
  const iv = randomBytes(12); // Recommended 96-bit IV for GCM
  const cipher = createCipheriv("aes-256-gcm", key, iv);

  let encrypted = cipher.update(plainText, "utf8", "hex");
  encrypted += cipher.final("hex");
  const tag = cipher.getAuthTag().toString("hex");

  return {
    cipherText: encrypted,
    iv: iv.toString("hex"),
    tag,
  };
}

/**
 * Decrypts AES-256-GCM encrypted credentials and verifies integrity tag.
 */
export function decryptCredential(payload: EncryptedPayload, masterKey?: string): string {
  const key = getMasterKey(masterKey);
  const iv = Buffer.from(payload.iv, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(Buffer.from(payload.tag, "hex"));

  let decrypted = decipher.update(payload.cipherText, "hex", "utf8");
  decrypted += decipher.final("utf8");

  return decrypted;
}
