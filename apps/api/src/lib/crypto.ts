import crypto from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12; // recommended for GCM

/**
 * Loads the credential encryption key from CREDENTIAL_ENCRYPTION_KEY
 * (base64 or hex, must decode to exactly 32 bytes). This key is deliberately
 * kept out of the database -- it lives only in the environment / a secrets
 * manager in production, per section 23 of the product brief.
 */
function getKey(): Buffer {
  const raw = process.env.CREDENTIAL_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error(
      "CREDENTIAL_ENCRYPTION_KEY is not set. Generate one with `openssl rand -base64 32` and set it in the API environment before storing integration credentials."
    );
  }
  let key: Buffer;
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    key = Buffer.from(raw, "hex");
  } else {
    key = Buffer.from(raw, "base64");
  }
  if (key.length !== 32) {
    throw new Error(
      `CREDENTIAL_ENCRYPTION_KEY must decode to 32 bytes, got ${key.length}. Generate one with \`openssl rand -base64 32\`.`
    );
  }
  return key;
}

/** Encrypts an arbitrary JSON-serializable value. Returns iv:authTag:ciphertext, base64-encoded. */
export function encryptJson(value: unknown): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return [iv.toString("base64"), authTag.toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptJson<T = unknown>(blob: string): T {
  const key = getKey();
  const [ivB64, tagB64, dataB64] = blob.split(":");
  if (!ivB64 || !tagB64 || !dataB64) {
    throw new Error("Malformed encrypted credential blob");
  }
  const iv = Buffer.from(ivB64, "base64");
  const authTag = Buffer.from(tagB64, "base64");
  const ciphertext = Buffer.from(dataB64, "base64");
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(authTag);
  const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return JSON.parse(plaintext.toString("utf8")) as T;
}

/**
 * Builds a masked display hint for a credential object, e.g. { apiKey: "sk-abcd1234" }
 * -> "apiKey: sk-...1234". Never includes the full secret value.
 */
export function maskCredentials(value: Record<string, string>): string {
  const parts = Object.entries(value).map(([k, v]) => {
    if (!v) return `${k}: (empty)`;
    if (v.length <= 8) return `${k}: ****`;
    return `${k}: ${v.slice(0, 3)}...${v.slice(-4)}`;
  });
  return parts.join(", ");
}
