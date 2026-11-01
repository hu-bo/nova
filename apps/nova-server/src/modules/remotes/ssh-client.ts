import { createHash, randomUUID } from "node:crypto";
import { posix } from "node:path";
import { Client, type SFTPWrapper, type Stats, type FileEntry } from "ssh2";
import { DomainError } from "../../shared/domain-error.js";

export type SshCredentials = {
  hostname: string;
  port: number;
  username: string;
  rootPath: string;
  authMethod: "private_key" | "password";
  credential: string;
  passphrase?: string;
  fingerprint?: string;
};
export function sshFingerprint(key: Buffer): string {
  return `SHA256:${createHash("sha256").update(key).digest("base64").replace(/=+$/, "")}`;
}

export function withSsh<T>(
  credentials: SshCredentials,
  operation: (client: Client) => Promise<T>,
  signal?: AbortSignal,
  timeoutMs = 15_000,
): Promise<T> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let settled = false;
    let observedFingerprint = "";
    const finish = (error: unknown, value?: T) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      client.destroy();
      if (error) reject(error);
      else resolve(value as T);
    };
    const abort = () => finish(new DomainError("CONFLICT", "SSH connection cancelled", { reason: "SSH_CANCELLED" }));
    const timer = setTimeout(
      () => finish(new DomainError("CONFLICT", "SSH connection timed out", { reason: "SSH_TIMEOUT" })),
      timeoutMs,
    );
    if (signal?.aborted) {
      abort();
      return;
    }
    signal?.addEventListener("abort", abort, { once: true });
    client.once("ready", () => {
      void operation(client).then(
        (value) => finish(null, value),
        (cause) => finish(cause),
      );
    });
    client.on("error", (cause: Error) => {
      if (observedFingerprint && observedFingerprint !== credentials.fingerprint)
        finish(
          new DomainError(
            "CONFLICT",
            "Confirm the SSH host fingerprint",
            {
              reason: credentials.fingerprint ? "SSH_HOST_KEY_CHANGED" : "SSH_HOST_KEY_UNTRUSTED",
              fingerprint: observedFingerprint,
            },
            { cause },
          ),
        );
      else
        finish(
          new DomainError(
            "CONFLICT",
            "Could not authenticate or connect to SSH",
            { reason: "SSH_CONNECTION_FAILED" },
            { cause },
          ),
        );
    });
    client.once("close", () =>
      finish(new DomainError("CONFLICT", "SSH connection closed", { reason: "SSH_CONNECTION_CLOSED" })),
    );
    try {
      client.connect({
        host: credentials.hostname,
        port: credentials.port,
        username: credentials.username,
        readyTimeout: 12_000,
        keepaliveInterval: 5_000,
        ...(credentials.authMethod === "password"
          ? { password: credentials.credential }
          : { privateKey: credentials.credential }),
        ...(credentials.passphrase ? { passphrase: credentials.passphrase } : {}),
        hostVerifier: (key: Buffer) => {
          observedFingerprint = sshFingerprint(key);
          return observedFingerprint === credentials.fingerprint;
        },
      });
    } catch (cause) {
      finish(
        new DomainError("VALIDATION_ERROR", "Invalid SSH credentials", { reason: "SSH_CREDENTIAL_INVALID" }, { cause }),
      );
    }
  });
}

export async function canonicalRemotePath(sftp: SFTPWrapper, root: string, requested = "."): Promise<string> {
  if (/[\x00-\x1f]/.test(requested)) throw new DomainError("VALIDATION_ERROR", "Invalid remote path");
  // The configured work directory is a base for relative paths, not a filesystem boundary.
  const candidate = posix.resolve(root, requested);
  const canonical = await new Promise<string>((resolve, reject) =>
    sftp.realpath(candidate, (error, path) =>
      error ? reject(new DomainError("NOT_FOUND", "Remote path not found")) : resolve(path),
    ),
  );
  return canonical;
}
export async function inspectRemoteRoot(sftp: SFTPWrapper, path: string): Promise<string> {
  const root = await new Promise<string>((resolve, reject) =>
    sftp.realpath(path, (error, canonical) =>
      error
        ? reject(new DomainError("NOT_FOUND", "Remote root not found", undefined, { cause: error }))
        : resolve(canonical),
    ),
  );
  const stat = await new Promise<Stats>((resolve, reject) =>
    sftp.stat(root, (error, attrs) =>
      error
        ? reject(new DomainError("NOT_FOUND", "Remote root not found", undefined, { cause: error }))
        : resolve(attrs),
    ),
  );
  if (!stat.isDirectory()) throw new DomainError("VALIDATION_ERROR", "Remote root must be a directory");
  return root;
}
export async function readRemoteDirectory(sftp: SFTPWrapper, path: string): Promise<FileEntry[]> {
  return new Promise((resolve, reject) =>
    sftp.readdir(path, (error, items) =>
      error ? reject(new DomainError("NOT_FOUND", "Remote directory not found")) : resolve(items),
    ),
  );
}
export async function summarizeRemoteFile(sftp: SFTPWrapper, path: string) {
  const stat = await new Promise<Stats>((resolve, reject) =>
    sftp.stat(path, (error, attrs) =>
      error ? reject(new DomainError("NOT_FOUND", "Remote file not found")) : resolve(attrs),
    ),
  );
  if (!stat.isFile() || stat.size > 5 * 1024 * 1024)
    throw new DomainError("VALIDATION_ERROR", "Select regular files smaller than 5 MiB");
  const digest = createHash("sha256");
  const size = await new Promise<number>((resolve, reject) => {
    let bytes = 0;
    const stream = sftp.createReadStream(path);
    stream.on("data", (data: Buffer) => {
      bytes += data.length;
      if (bytes > 5 * 1024 * 1024) stream.destroy(new Error("FILE_TOO_LARGE"));
      else digest.update(data);
    });
    stream.once("error", () => reject(new DomainError("CONFLICT", "Remote file changed or could not be read")));
    stream.once("end", () => resolve(bytes));
  });
  return { path, size, sha256: digest.digest("hex"), mtime: new Date(stat.mtime * 1000).toISOString() };
}
export function withSftp<T>(
  credentials: SshCredentials,
  operation: (sftp: SFTPWrapper) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  return withSsh(
    credentials,
    (client) =>
      new Promise<T>((resolve, reject) =>
        client.sftp((error, sftp) => {
          if (error) {
            reject(
              new DomainError("CONFLICT", "SFTP unavailable", { reason: "SSH_SFTP_UNAVAILABLE" }, { cause: error }),
            );
            return;
          }
          void operation(sftp).then(resolve, reject);
        }),
      ),
    signal,
  );
}

export async function readRemoteText(sftp: SFTPWrapper, path: string) {
  const chunks: Buffer[] = [];
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = sftp.createReadStream(path);
    stream.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > 256 * 1024) stream.destroy(new Error("FILE_TOO_LARGE"));
      else chunks.push(chunk);
    });
    stream.once("error", () => reject(new DomainError("CONFLICT", "Could not read a text file up to 256 KiB")));
    stream.once("end", resolve);
  });
  const data = Buffer.concat(chunks);
  if (data.includes(0)) throw new DomainError("VALIDATION_ERROR", "Binary files cannot be used as text");
  return { text: data.toString("utf8"), sha256: createHash("sha256").update(data).digest("hex"), size };
}

export async function writeRemoteText(
  sftp: SFTPWrapper,
  root: string,
  requested: string,
  content: string,
  expectedSha256?: string,
) {
  const candidate = posix.resolve(root, requested),
    parent = await canonicalRemotePath(sftp, root, posix.dirname(candidate));
  const target = posix.join(parent, posix.basename(candidate));
  if (Buffer.byteLength(content) > 256 * 1024 || /[\x00-\x1f]/.test(requested))
    throw new DomainError("VALIDATION_ERROR", "Invalid file write");
  const stat = await new Promise<Stats | null>((resolve, reject) =>
    sftp.lstat(target, (error, value) => {
      if (error && (error as Error & { code?: number }).code !== 2)
        reject(new DomainError("CONFLICT", "Cannot inspect destination"));
      else resolve(error ? null : value);
    }),
  );
  if (stat && !stat.isFile()) throw new DomainError("FORBIDDEN", "Destination must be a regular file");
  if (stat && (!expectedSha256 || (await readRemoteText(sftp, target)).sha256 !== expectedSha256))
    throw new DomainError("CONFLICT", "File changed since it was read");
  if (!stat && expectedSha256) throw new DomainError("CONFLICT", "File no longer exists");
  const temporary = posix.join(parent, ".nova-" + randomUUID() + ".tmp");
  let written = false;
  try {
    await new Promise<void>((resolve, reject) => {
      const stream = sftp.createWriteStream(temporary, { flags: "wx", mode: stat ? stat.mode & 0o777 : 0o600 });
      stream.once("error", () => reject(new DomainError("CONFLICT", "Could not write the remote file")));
      stream.once("close", resolve);
      stream.end(content);
    });
    written = true;
    if (stat && (await readRemoteText(sftp, target)).sha256 !== expectedSha256)
      throw new DomainError("CONFLICT", "File changed while preparing the write");
    await new Promise<void>((resolve, reject) =>
      (stat ? sftp.ext_openssh_rename.bind(sftp) : sftp.rename.bind(sftp))(temporary, target, (error) =>
        error ? reject(new DomainError("CONFLICT", "Could not replace the remote file")) : resolve(),
      ),
    );
    written = false;
    return {
      path: requested,
      sha256: createHash("sha256").update(content).digest("hex"),
      size: Buffer.byteLength(content),
    };
  } finally {
    if (written) await new Promise<void>((resolve) => sftp.unlink(temporary, () => resolve()));
  }
}
