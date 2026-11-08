import { fileURLToPath } from 'node:url';
import tailwindcss from '@tailwindcss/vite';
import { tanstackRouter } from '@tanstack/router-plugin/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, loadEnv } from 'vite';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, fileURLToPath(new URL('.', import.meta.url)), '');
  const proxy = {
    '/api': { target: env.API_PROXY_TARGET || 'http://127.0.0.1:9203', changeOrigin: true },
    '/health': { target: env.API_PROXY_TARGET || 'http://127.0.0.1:9203', changeOrigin: true },
  };
  return {
    build: { manifest: true },
    plugins: [tanstackRouter({ target: 'react', autoCodeSplitting: true }), react(), tailwindcss()],
    resolve: {
      dedupe: ['react', 'react-dom'],
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: { host: '0.0.0.0', port: 8003, strictPort: true, proxy },
    preview: { host: '127.0.0.1', port: 4173, strictPort: true, proxy },
  };
});
