import { randomBytes } from "node:crypto";
import { sql, type SQLWrapper } from "drizzle-orm";
import { customType } from "drizzle-orm/pg-core";
import {
  conversationIdSchema,
  pendingInputIdSchema,
  productIdBytes,
  productIdPrefixes,
  runIdSchema,
} from "@nova/agent-ui-contracts/product-ids";

type ProductIdKind = keyof typeof productIdPrefixes;
const schemas = {
  conversation: conversationIdSchema,
  run: runIdSchema,
  pendingInput: pendingInputIdSchema,
};

export function newProductId(kind: ProductIdKind): string {
  return formatProductId(kind, randomBytes(productIdBytes));
}

export function formatProductId(kind: ProductIdKind, bytes: Buffer): string {
  if (bytes.length !== productIdBytes) throw new Error("Invalid product ID byte length");
  return productIdPrefixes[kind] + bytes.toString("base64url");
}

/** Encode a binary ID for SQL statements that write directly to JSON or text. */
export function productIdText(kind: ProductIdKind, column: SQLWrapper) {
  return sql<string>`${productIdPrefixes[kind]}::text || translate(encode(${column}, 'base64'), '+/', '-_')`;
}

export function productId(name: string, kind: ProductIdKind) {
  const prefix = productIdPrefixes[kind];
  return customType<{ data: string; driverData: Buffer }>({
    dataType: () => "bytea",
    toDriver(value) {
      return Buffer.from(schemas[kind].parse(value).slice(prefix.length), "base64url");
    },
    fromDriver(value) {
      return formatProductId(kind, value);
    },
  })(name);
}

// Take only the fully random bytes before and after the UUID version and variant.
export const randomProductId = sql`substring(uuid_send(gen_random_uuid()) from 1 for 6)
  || substring(uuid_send(gen_random_uuid()) from 10 for ${sql.raw(String(productIdBytes - 6))})`;
