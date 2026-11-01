/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_BASE_URL?: string;
  readonly VITE_AUTH_BASE_URL?: string;
  readonly VITE_AUTH_APP_NAME?: string;
  readonly VITE_AUTH_MODE?: 'casdoor' | 'dev';
}
interface ImportMeta {
  readonly env: ImportMetaEnv;
}
