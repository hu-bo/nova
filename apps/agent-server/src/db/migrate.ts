import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";

async function main(): Promise<void> {
  const databaseUrl = process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error("DATABASE_URL is required for database migrations");

  const client = postgres(databaseUrl, { max: 1 });
  try {
    console.log("Applying database migrations from ./drizzle");
    await migrate(drizzle(client), { migrationsFolder: "./drizzle" });
    console.log("Database migrations applied successfully");
  } finally {
    await client.end({ timeout: 5 });
  }
}

try {
  await main();
} catch (error) {
  console.error("Database migration failed");
  // Drizzle wraps the PostgreSQL error; print each cause without connection options.
  let cause: unknown = error;
  while (cause instanceof Error) {
    const code = "code" in cause ? String(cause.code) : cause.name;
    let message = cause.message;
    if (process.env.DATABASE_URL) message = message.replaceAll(process.env.DATABASE_URL, "[DATABASE_URL]");
    console.error(`[${code}] ${message}`);
    cause = cause.cause;
  }
  // Let Node flush output naturally instead of terminating inside an error renderer.
  process.exitCode = 1;
}
