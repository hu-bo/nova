import { posix } from "node:path";
import { DomainError } from "../../shared/domain-error.js";
import { createCredentialCipher } from "../../shared/credential-cipher.js";
import type { RemoteRepository, RemoteConnectionRow } from "./remote.repository.js";
import type { RemoteConnectionInput, RemoteConnectionPatch } from "./remote.schema.js";
import {
  canonicalRemotePath,
  inspectRemoteRoot,
  readRemoteDirectory,
  summarizeRemoteFile,
  withSftp,
  withSsh,
  readRemoteText,
  writeRemoteText,
  type SshCredentials,
} from "./ssh-client.js";

export class RemoteConnectionService {
  private readonly cipher: ReturnType<typeof createCredentialCipher>;
  constructor(
    private readonly repository: RemoteRepository,
    encryptionKey?: string,
  ) {
    this.cipher = createCredentialCipher(encryptionKey);
  }
  async list(owner: string) {
    return (await this.repository.list(owner)).map(toDto);
  }
  async require(id: string, owner: string) {
    const row = await this.repository.get(id, owner);
    if (!row) throw new DomainError("NOT_FOUND", "SSH connection not found");
    return row;
  }
  async create(input: RemoteConnectionInput, owner: string) {
    const { credential, passphrase, ...fields } = input;
    return toDto(
      await this.repository.create({
        ...fields,
        ownerUserId: owner,
        credentialCiphertext: this.cipher.encrypt(credential),
        passphraseCiphertext: passphrase ? this.cipher.encrypt(passphrase) : null,
      }),
    );
  }
  async update(id: string, owner: string, input: RemoteConnectionPatch) {
    const current = await this.require(id, owner);
    const { credential, passphrase, ...fields } = input;
    if (!credential && input.authMethod !== current.authMethod)
      throw new DomainError("VALIDATION_ERROR", "New credentials required when changing authentication");
    const hostChanged = current.hostname !== input.hostname || current.port !== input.port;
    const row = await this.repository.update(id, owner, {
      ...fields,
      ...(credential ? { credentialCiphertext: this.cipher.encrypt(credential) } : {}),
      ...(passphrase !== undefined
        ? { passphraseCiphertext: passphrase ? this.cipher.encrypt(passphrase) : null }
        : {}),
      ...(hostChanged ? { hostFingerprint: null } : {}),
      lastCheckedAt: null,
      lastError: null,
    });
    if (!row) throw new DomainError("NOT_FOUND", "SSH connection not found");
    return toDto(row);
  }
  async remove(id: string, owner: string) {
    if (!(await this.repository.remove(id, owner))) throw new DomainError("NOT_FOUND", "SSH connection not found");
  }
  async test(id: string, owner: string, fingerprint?: string) {
    const row = await this.require(id, owner);
    try {
      const credentials = this.credentials(row, fingerprint);
      const rootPath = await withSftp(credentials, (sftp) => inspectRemoteRoot(sftp, row.rootPath));
      const trusted = credentials.fingerprint!;
      await this.repository.update(id, owner, {
        rootPath,
        hostFingerprint: trusted,
        lastCheckedAt: new Date(),
        lastError: null,
      });
      return { status: "verified" as const, fingerprint: trusted, rootPath };
    } catch (error) {
      if (error instanceof DomainError && error.details?.reason === "SSH_HOST_KEY_UNTRUSTED")
        return { status: "trust_required" as const, fingerprint: String(error.details.fingerprint) };
      await this.repository.update(id, owner, {
        lastError: error instanceof DomainError ? String(error.details?.reason ?? error.code) : "SSH_CONNECTION_FAILED",
      });
      throw error;
    }
  }
  async getEnvironment(id: string, owner: string) {
    const row = await this.require(id, owner);
    if (!row.hostFingerprint || !row.lastCheckedAt)
      throw new DomainError("CONFLICT", "Verify the SSH connection first", { reason: "SSH_VERIFICATION_REQUIRED" });
    return { id: row.id, name: row.name, rootPath: row.rootPath, workspaceId: `ssh:${row.id}` };
  }
  async files(id: string, owner: string, path = "/") {
    const row = await this.require(id, owner);
    if (!row.hostFingerprint)
      throw new DomainError("CONFLICT", "Verify the SSH host first", { reason: "SSH_VERIFICATION_REQUIRED" });
    return withSftp(this.credentials(row), async (sftp) => {
      const canonical = await canonicalRemotePath(sftp, row.rootPath, path);
      const entries = await readRemoteDirectory(sftp, canonical);
      return {
        root: "/",
        path: canonical,
        parent: canonical === "/" ? null : posix.dirname(canonical),
        entries: entries
          .filter(
            (entry) =>
              entry.filename !== "." &&
              entry.filename !== ".." &&
              [0o040000, 0o100000].includes((entry.attrs.mode ?? 0) & 0o170000),
          )
          .slice(0, 500)
          .map((entry) => ({
            name: entry.filename,
            path: posix.join(canonical, entry.filename),
            kind: ((entry.attrs.mode ?? 0) & 0o170000) === 0o040000 ? ("directory" as const) : ("file" as const),
          })),
      };
    });
  }
  async readText(id: string, owner: string, path: string, signal?: AbortSignal) {
    const row = await this.require(id, owner);
    if (!row.hostFingerprint) throw new DomainError("CONFLICT", "Verify the SSH host first");
    return withSftp(
      this.credentials(row),
      async (sftp) => {
        return readRemoteText(sftp, await canonicalRemotePath(sftp, row.rootPath, path));
      },
      signal,
    );
  }
  async writeText(
    id: string,
    owner: string,
    path: string,
    content: string,
    expectedSha256?: string,
    signal?: AbortSignal,
  ) {
    const row = await this.require(id, owner);
    if (!row.hostFingerprint) throw new DomainError("CONFLICT", "Verify the SSH host first");
    return withSftp(
      this.credentials(row),
      async (sftp) => writeRemoteText(sftp, row.rootPath, path, content, expectedSha256),
      signal,
    );
  }
  async execute(id: string, owner: string, cwd: string, executable: string, args: string[], signal?: AbortSignal) {
    const row = await this.require(id, owner);
    if (!row.hostFingerprint) throw new DomainError("CONFLICT", "Verify the SSH host first");
    const listing = await this.files(id, owner, cwd);
    const quote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
    const command = "cd -- " + quote(listing.path) + " && " + [executable, ...args].map(quote).join(" ");
    let dispatched = false;
    return withSsh(
      this.credentials(row),
      (client) =>
        new Promise<{ exitCode: number; stdout: string; stderr: string; truncated: boolean }>((resolve, reject) => {
          client.exec(command, (error, channel) => {
            if (error) {
              reject(new DomainError("CONFLICT", "Could not start the remote command"));
              return;
            }
            dispatched = true;
            let stdout = "",
              stderr = "",
              truncated = false;
            const append = (previous: string, data: Buffer) => {
              const full = previous + data.toString("utf8");
              if (Buffer.byteLength(full) > 65536) {
                truncated = true;
                return Buffer.from(full).subarray(0, 65536).toString("utf8");
              }
              return full;
            };
            channel.on("data", (chunk: Buffer) => {
              stdout = append(stdout, chunk);
            });
            channel.stderr.on("data", (chunk: Buffer) => {
              stderr = append(stderr, chunk);
            });
            channel.once("error", () =>
              reject(new DomainError("EXECUTION_OUTCOME_UNKNOWN", "Remote command outcome is unknown")),
            );
            channel.once("close", (code: number | undefined) =>
              code === undefined
                ? reject(new DomainError("EXECUTION_OUTCOME_UNKNOWN", "Remote command outcome is unknown"))
                : resolve({ exitCode: code, stdout, stderr, truncated }),
            );
          });
        }),
      signal,
      120_000,
    ).catch((error: unknown) => {
      if (dispatched)
        throw new DomainError(
          "EXECUTION_OUTCOME_UNKNOWN",
          "Remote command outcome must be checked before retrying",
          undefined,
          { cause: error },
        );
      throw error;
    });
  }
  private credentials(row: RemoteConnectionRow, fingerprint?: string): SshCredentials {
    return {
      hostname: row.hostname,
      port: row.port,
      username: row.username,
      rootPath: row.rootPath,
      authMethod: row.authMethod,
      credential: this.cipher.decrypt(row.credentialCiphertext),
      ...(row.passphraseCiphertext ? { passphrase: this.cipher.decrypt(row.passphraseCiphertext) } : {}),
      ...((fingerprint ?? row.hostFingerprint) ? { fingerprint: (fingerprint ?? row.hostFingerprint)! } : {}),
    };
  }
  async summaries(id: string, owner: string, paths: string[]) {
    const row = await this.require(id, owner);
    if (!row.hostFingerprint) throw new DomainError("CONFLICT", "Verify the SSH host first");
    return withSftp(this.credentials(row), async (sftp) => {
      const items: Awaited<ReturnType<typeof summarizeRemoteFile>>[] = [];
      let total = 0;
      for (const path of paths) {
        const canonical = await canonicalRemotePath(sftp, row.rootPath, path);
        const item = await summarizeRemoteFile(sftp, canonical);
        total += item.size;
        if (total > 20 * 1024 * 1024)
          throw new DomainError("VALIDATION_ERROR", "Remote attachments cannot exceed 20 MiB in total");
        items.push(item);
      }
      return { items };
    });
  }
}
function toDto(row: RemoteConnectionRow) {
  return {
    id: row.id,
    name: row.name,
    hostname: row.hostname,
    port: row.port,
    username: row.username,
    rootPath: row.rootPath,
    authMethod: row.authMethod,
    hostFingerprint: row.hostFingerprint,
    status: row.lastError ? ("offline" as const) : row.lastCheckedAt ? ("verified" as const) : ("unverified" as const),
    lastCheckedAt: row.lastCheckedAt?.toISOString() ?? null,
    lastError: row.lastError,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
