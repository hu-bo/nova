import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [tailwindcss()],
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
  server: {
    port: 4173,
    proxy: {
      "/api/apps": {
        target: "http://auth.8and1.cn",
        changeOrigin: true,
      },
      "/api": {
        target: "http://127.0.0.1:9203",
        changeOrigin: true,
      },
      "/admin": {
        target: "http://127.0.0.1:9203",
        changeOrigin: true,
      },
    },
  },
});
