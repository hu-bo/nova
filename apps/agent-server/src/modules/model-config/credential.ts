import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export interface CredentialCipher {
  encrypt(credential: string): string;
  decrypt(encrypted: string): string;
  masked(encrypted: string): string;
}

export function createCredentialCipher(encodedKey: string): CredentialCipher {
  const key = Buffer.from(encodedKey, "base64url");
  if (key.length !== 32) throw new Error("MODEL_CONFIG_ENCRYPTION_KEY must be a base64url-encoded 32-byte key");

  return {
    encrypt(credential) {
      const nonce = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      const ciphertext = Buffer.concat([cipher.update(credential, "utf8"), cipher.final()]);
      const tag = cipher.getAuthTag();
      return [maskCredential(credential), nonce.toString("base64url"), tag.toString("base64url"), ciphertext.toString("base64url")].join(".");
    },
    decrypt(encrypted) {
      const [, nonce, tag, ciphertext] = encrypted.split(".");
      if (!nonce || !tag || !ciphertext) throw new Error("Stored provider credential is invalid");
      const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(nonce, "base64url"));
      decipher.setAuthTag(Buffer.from(tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString("utf8");
    },
    masked(encrypted) {
      return encrypted.split(".", 1)[0] ?? "••••";
    },
  };
}

function maskCredential(credential: string): string {
  const suffix = credential.slice(-4);
  return suffix ? `••••${suffix}` : "••••";
}
