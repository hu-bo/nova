import { DomainError } from "./domain-error.js";
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";

export class ModelConfigUnavailableError extends DomainError {
  constructor() {
    super("SERVICE_UNAVAILABLE", "Set MODEL_CONFIG_ENCRYPTION_KEY to create or rotate provider credentials", {
      reason: "MODEL_CONFIG_UNAVAILABLE",
    });
    this.name = "ModelConfigUnavailableError";
  }
}

/** AES-256-GCM ciphertext format: version, 96-bit nonce, auth tag, encrypted bytes. */
export function createCredentialCipher(keyHex: string | undefined) {
  const key = keyHex ? Buffer.from(keyHex, "hex") : undefined;
  return {
    encrypt(credential: string): string {
      if (!key || key.length !== 32) throw new ModelConfigUnavailableError();
      const iv = randomBytes(12);
      const cipher = createCipheriv("aes-256-gcm", key, iv);
      const ciphertext = Buffer.concat([cipher.update(credential, "utf8"), cipher.final()]);
      return [
        "v1",
        iv.toString("base64url"),
        cipher.getAuthTag().toString("base64url"),
        ciphertext.toString("base64url"),
      ].join(".");
    },
    decrypt(value: string): string {
      if (!key || key.length !== 32) throw new ModelConfigUnavailableError();
      const [version, iv, authTag, ciphertext] = value.split(".");
      if (version !== "v1" || !iv || !authTag || ciphertext === undefined) {
        throw new Error("Stored provider credential has an unsupported format");
      }
      try {
        const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(iv, "base64url"));
        decipher.setAuthTag(Buffer.from(authTag, "base64url"));
        return Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64url")), decipher.final()]).toString(
          "utf8",
        );
      } catch {
        throw new Error("Stored provider credential could not be decrypted");
      }
    },
  };
}

export function maskCredential(credential: string): string {
  const suffix = [...credential].slice(-4).join("");
  return credential.length > 4 ? `••••••••${suffix}` : "••••";
}
