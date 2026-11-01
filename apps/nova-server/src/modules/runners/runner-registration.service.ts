import { createHash } from "node:crypto";
import { DomainError } from "../../shared/domain-error.js";
import type { ServiceTransaction } from "../../shared/scope.js";
import type { RunnerRepository } from "./runner.repository.js";
import type { RunnerTokenRepository } from "./runner-token.repository.js";

export class RunnerRegistrationService {
  constructor(
    private readonly tokens: RunnerTokenRepository,
    private readonly transaction: ServiceTransaction<{ runners: RunnerRepository; tokens: RunnerTokenRepository }>,
  ) {}

  async register(
    secret: string,
    identity: {
      runnerId: string;
      bootId: string;
      capabilities: readonly string[];
      workspaces: readonly { workspaceId: string }[];
    },
  ) {
    const owner = secret.split(".")[0];
    const candidates = await this.tokens.active(owner && /^[a-f0-9-]{36}$/i.test(owner) ? owner : undefined);
    const token = candidates.find(
      (item) =>
        createHash("sha256")
          .update(item.ownerUserId + "::" + secret)
          .digest("hex") === item.tokenHash &&
        (!item.expiresAt || item.expiresAt.getTime() > Date.now()),
    );
    if (!token) return null;
    const runner = await this.transaction(async ({ runners, tokens }) => {
      await runners.lockOwner(token.ownerUserId);
      // Recheck under a row lock: revocation/rotation must not race registration.
      const current = await tokens.lock(token.id, token.ownerUserId);
      if (!current || current.status !== "active" || (current.expiresAt && current.expiresAt.getTime() <= Date.now()))
        return null;
      const existing = await runners.findIdentity(token.ownerUserId, identity.runnerId);
      if (existing?.revokedAt) throw new DomainError("FORBIDDEN", "Runner was revoked");
      const saved = await runners.save(
        {
          ownerUserId: token.ownerUserId,
          runnerId: identity.runnerId,
          bootId: identity.bootId,
          workspaceId: identity.workspaces[0]?.workspaceId ?? null,
          capabilities: identity.capabilities,
          lastSeenAt: new Date(),
          updatedAt: new Date(),
        },
        existing?.id,
      );
      await tokens.markUsed(token.id);
      return saved;
    });
    return runner ? { runner, tokenId: token.id, ownerUserId: token.ownerUserId } : null;
  }
}
