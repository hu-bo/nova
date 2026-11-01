import { loadConfig } from "../dist/src/config.js";
import { createAuthServiceClient } from "../dist/src/modules/identity/auth-service.js";

try {
  const config = loadConfig();
  if (config.AUTH_MODE !== "casdoor") {
    throw new Error("Production deployment requires AUTH_MODE=casdoor.");
  }
  if (!config.MODEL_CONFIG_ENCRYPTION_KEY) {
    throw new Error("Production deployment requires MODEL_CONFIG_ENCRYPTION_KEY.");
  }
  // Fail before migrations or stopping the previous service if auth is not ready.
  createAuthServiceClient(config);
  await import("../dist/src/app.js");
  console.log("Production configuration and packaged imports are ready.");
} catch (error) {
  console.error(error instanceof Error ? error.message : "Deployment preflight failed.");
  process.exitCode = 1;
}
