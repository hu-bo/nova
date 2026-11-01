import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import { harnessApiPlugin } from "./demo/harness-api.js";

export default defineConfig({
  esbuild: { jsx: "automatic" },
  plugins: [tailwindcss(), harnessApiPlugin()],
});
