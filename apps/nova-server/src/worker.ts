import "./environment.js";
import { buildApp } from "./app.js";
import { loadConfig } from "./config.js";
async function main() {
  const config = loadConfig();
  if (config.ROLE !== "worker" && config.ROLE !== "all") throw new Error("Use ROLE=worker or ROLE=all");
  const app = await buildApp({ ...config, ROLE: "worker" });
  await app.ready();
  const close = () => {
    void app.close().then(() => {
      process.exitCode = 0;
    });
  };
  process.once("SIGINT", close);
  process.once("SIGTERM", close);
}
main().catch(() => {
  console.error("Worker startup failed");
  process.exitCode = 1;
});
