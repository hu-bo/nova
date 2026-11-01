import { config } from "dotenv";
import { resolve } from "node:path";
import { defineConfig } from "drizzle-kit";

// pnpm runs the database commands from the server package root.
config({ path: resolve(".env") });
export default defineConfig({
  schema: "./database/schema/*.table.ts",
  out: "./database/migrations",
  dialect: "postgresql",
  dbCredentials: { url: process.env.DATABASE_URL ?? "" },
});
