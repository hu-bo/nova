import { createHash, randomBytes } from "node:crypto";
import type { RunnerTokenRepository, RunnerTokenRow } from "./runner-token.repository.js";
import type { ServiceTransaction } from "../../shared/scope.js";
import { createCredentialCipher } from "../../shared/credential-cipher.js";
import { DomainError } from "../../shared/domain-error.js";

const TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;

function generateToken(ownerUserId: string): string {
  return ownerUserId + "." + randomBytes(32).toString("base64url");
}

function hashToken(token: string, ownerUserId: string): string {
  return createHash("sha256")
    .update(ownerUserId + "::" + token)
    .digest("hex");
}

/** Store recoverable credentials encrypted; connection authentication continues to use the hash. */
export class RunnerTokenService {
  private readonly cipher: ReturnType<typeof createCredentialCipher>;

  constructor(
    private readonly repository: RunnerTokenRepository,
    private readonly transaction: ServiceTransaction<{ repository: RunnerTokenRepository }>,
    encryptionKey?: string,
  ) {
    this.cipher = createCredentialCipher(encryptionKey);
  }

  async list(ownerUserId: string): Promise<(RunnerTokenRow & { token: string | null })[]> {
    const rows = await this.repository.list(ownerUserId);
    return rows.map((row) => ({
      ...row,
      token:
        row.status === "active" && (!row.expiresAt || row.expiresAt.getTime() > Date.now()) && row.tokenCiphertext
          ? this.decrypt(row.tokenCiphertext)
          : null,
    }));
  }

  async create(input: {
    ownerUserId: string;
    label?: string;
    capabilities: readonly string[];
    expiresAt?: string;
  }): Promise<{ row: RunnerTokenRow; secret: string }> {
    const token = generateToken(input.ownerUserId);
    const tokenCiphertext = this.encrypt(token);
    const created = await this.repository.insert({
      ownerUserId: input.ownerUserId,
      tokenHash: hashToken(token, input.ownerUserId),
      tokenCiphertext,
      label: input.label ?? null,
      capabilities: input.capabilities,
      expiresAt: input.expiresAt ? new Date(input.expiresAt) : this.defaultExpiry(),
      status: "active",
      statusChangedAt: new Date(),
    });
    return { row: created, secret: token };
  }

  async revoke(input: { ownerUserId: string; id: string }): Promise<void> {
    const updated = await this.repository.revoke(input.id, input.ownerUserId);
    if (!updated) throw new DomainError("NOT_FOUND", "Runner token not found");
  }

  async rotate(input: {
    ownerUserId: string;
    id: string;
    revokePrevious: boolean;
  }): Promise<{ row: RunnerTokenRow; secret: string }> {
    return this.transaction(async ({ repository }) => {
      const existing = await repository.lock(input.id, input.ownerUserId);
      if (!existing) throw new DomainError("NOT_FOUND", "Runner token not found");
      if (existing.status !== "active") throw new DomainError("CONFLICT", "Token is not active");

      const newToken = generateToken(input.ownerUserId);
      const created = await repository.insert({
        ownerUserId: input.ownerUserId,
        tokenHash: hashToken(newToken, input.ownerUserId),
        tokenCiphertext: this.encrypt(newToken),
        prevTokenHash: existing.tokenHash,
        label: existing.label,
        capabilities: existing.capabilities,
        expiresAt:
          existing.expiresAt && existing.expiresAt.getTime() <= Date.now() ? this.defaultExpiry() : existing.expiresAt,
        status: "active",
        statusChangedAt: new Date(),
      });
      await repository.markRotated(existing.id, input.ownerUserId, input.revokePrevious);
      return { row: created, secret: newToken };
    });
  }

  private defaultExpiry() {
    return new Date(Date.now() + TOKEN_TTL_SECONDS * 1000);
  }

  private encrypt(token: string): string {
    try {
      return this.cipher.encrypt(token);
    } catch {
      throw new DomainError("CONFLICT", "Runner 凭据加密服务不可用，请检查服务端密钥配置。");
    }
  }

  private decrypt(ciphertext: string): string {
    try {
      return this.cipher.decrypt(ciphertext);
    } catch {
      throw new DomainError("CONFLICT", "Runner 凭据无法读取，请检查服务端密钥配置。");
    }
  }
}
