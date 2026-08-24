import { inflateRawSync } from "node:zlib";
import { safeRelativePath } from "./schema.js";

export interface ArchiveFile {
  path: string;
  data: Uint8Array;
}

export interface ArchiveLimits {
  maxEntries?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
  maxCompressionRatio?: number;
}

export class SkillArchiveError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SkillArchiveError";
  }
}

interface ZipEntry {
  path: string;
  rawName: Uint8Array;
  flags: number;
  method: number;
  crc: number;
  compressedSize: number;
  uncompressedSize: number;
  localOffset: number;
  directory: boolean;
}

const DEFAULT_LIMITS = {
  maxEntries: 256,
  maxFileBytes: 4 * 1024 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  maxCompressionRatio: 100,
};

export function readSkillZip(input: Uint8Array, limits: ArchiveLimits = {}): ArchiveFile[] {
  const bytes = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const resolved = { ...DEFAULT_LIMITS, ...limits };
  const eocd = findEndOfCentralDirectory(bytes);
  const disk = u16(bytes, eocd + 4);
  const centralDisk = u16(bytes, eocd + 6);
  const entriesOnDisk = u16(bytes, eocd + 8);
  const entryCount = u16(bytes, eocd + 10);
  const centralSize = u32(bytes, eocd + 12);
  const centralOffset = u32(bytes, eocd + 16);
  if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entryCount)
    throw archiveError("multi-disk ZIP archives are not supported");
  if (entryCount === 0xffff || centralSize === 0xffffffff || centralOffset === 0xffffffff)
    throw archiveError("ZIP64 archives are not supported");
  if (entryCount > resolved.maxEntries) throw archiveError(`archive contains more than ${resolved.maxEntries} entries`);
  assertRange(bytes, centralOffset, centralSize, "central directory");

  const entries: ZipEntry[] = [];
  const paths = new Set<string>();
  let offset = centralOffset;
  let totalBytes = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (u32(bytes, offset) !== 0x02014b50) throw archiveError("invalid central directory entry");
    assertRange(bytes, offset, 46, "central directory entry");
    const flags = u16(bytes, offset + 8);
    const method = u16(bytes, offset + 10);
    const crc = u32(bytes, offset + 16);
    const compressedSize = u32(bytes, offset + 20);
    const uncompressedSize = u32(bytes, offset + 24);
    const nameLength = u16(bytes, offset + 28);
    const extraLength = u16(bytes, offset + 30);
    const commentLength = u16(bytes, offset + 32);
    const externalAttributes = u32(bytes, offset + 38);
    const localOffset = u32(bytes, offset + 42);
    const length = 46 + nameLength + extraLength + commentLength;
    assertRange(bytes, offset, length, "central directory entry");
    const rawName = bytes.subarray(offset + 46, offset + 46 + nameLength);
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(rawName).replaceAll("\\", "/");
    const directory = decoded.endsWith("/");
    const path = directory ? decoded.slice(0, -1) : decoded;
    if (!safeRelativePath(path)) throw archiveError(`unsafe archive path: ${decoded}`);
    const collisionKey = path.toLowerCase();
    if (paths.has(collisionKey)) throw archiveError(`duplicate archive path: ${path}`);
    paths.add(collisionKey);
    if ((flags & 0x1) !== 0) throw archiveError(`encrypted archive entry is not supported: ${path}`);
    if (method !== 0 && method !== 8) throw archiveError(`unsupported ZIP compression method ${method}: ${path}`);
    const unixMode = externalAttributes >>> 16;
    if ((unixMode & 0xf000) === 0xa000) throw archiveError(`symbolic links are not allowed: ${path}`);
    if (!directory) {
      if (uncompressedSize > resolved.maxFileBytes) throw archiveError(`archive entry exceeds size limit: ${path}`);
      totalBytes += uncompressedSize;
      if (totalBytes > resolved.maxTotalBytes) throw archiveError("archive exceeds total uncompressed size limit");
      if (
        uncompressedSize > 0 &&
        (compressedSize === 0 || uncompressedSize / compressedSize > resolved.maxCompressionRatio)
      ) {
        throw archiveError(`archive entry exceeds compression ratio limit: ${path}`);
      }
    }
    entries.push({ path, rawName, flags, method, crc, compressedSize, uncompressedSize, localOffset, directory });
    offset += length;
  }
  if (offset !== centralOffset + centralSize) throw archiveError("central directory size does not match its entries");

  return entries.filter((entry) => !entry.directory).map((entry) => extract(bytes, entry));
}

function extract(bytes: Buffer, entry: ZipEntry): ArchiveFile {
  assertRange(bytes, entry.localOffset, 30, `local header for ${entry.path}`);
  if (u32(bytes, entry.localOffset) !== 0x04034b50) throw archiveError(`invalid local header: ${entry.path}`);
  const nameLength = u16(bytes, entry.localOffset + 26);
  const extraLength = u16(bytes, entry.localOffset + 28);
  const nameStart = entry.localOffset + 30;
  assertRange(bytes, nameStart, nameLength + extraLength + entry.compressedSize, `entry data for ${entry.path}`);
  const localName = bytes.subarray(nameStart, nameStart + nameLength);
  if (!localName.equals(Buffer.from(entry.rawName)))
    throw archiveError(`local and central names differ: ${entry.path}`);
  const start = nameStart + nameLength + extraLength;
  const compressed = bytes.subarray(start, start + entry.compressedSize);
  let data: Buffer;
  try {
    data =
      entry.method === 0
        ? Buffer.from(compressed)
        : inflateRawSync(compressed, { maxOutputLength: Math.max(1, entry.uncompressedSize + 1) });
  } catch (error) {
    throw archiveError(`unable to decompress ${entry.path}: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (data.length !== entry.uncompressedSize) throw archiveError(`uncompressed size mismatch: ${entry.path}`);
  if (crc32(data) !== entry.crc) throw archiveError(`CRC mismatch: ${entry.path}`);
  return { path: entry.path, data };
}

function findEndOfCentralDirectory(bytes: Buffer): number {
  const minimum = 22;
  if (bytes.length < minimum) throw archiveError("file is not a ZIP archive");
  const start = Math.max(0, bytes.length - minimum - 0xffff);
  for (let offset = bytes.length - minimum; offset >= start; offset -= 1) {
    if (bytes.readUInt32LE(offset) !== 0x06054b50) continue;
    const commentLength = u16(bytes, offset + 20);
    if (offset + minimum + commentLength === bytes.length) return offset;
  }
  throw archiveError("end of ZIP central directory was not found");
}

function assertRange(bytes: Buffer, offset: number, length: number, label: string): void {
  if (
    !Number.isSafeInteger(offset) ||
    !Number.isSafeInteger(length) ||
    offset < 0 ||
    length < 0 ||
    offset + length > bytes.length
  ) {
    throw archiveError(`invalid ${label} range`);
  }
}

function u16(bytes: Buffer, offset: number): number {
  assertRange(bytes, offset, 2, "ZIP field");
  return bytes.readUInt16LE(offset);
}

function u32(bytes: Buffer, offset: number): number {
  assertRange(bytes, offset, 4, "ZIP field");
  return bytes.readUInt32LE(offset);
}

function archiveError(message: string): SkillArchiveError {
  return new SkillArchiveError(message);
}

const CRC_TABLE = Array.from({ length: 256 }, (_, value) => {
  let crc = value;
  for (let bit = 0; bit < 8; bit += 1) crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}
