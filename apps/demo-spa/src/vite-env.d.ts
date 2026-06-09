/// <reference types="vite/client" />

// Augment Vite's ImportMetaEnv with the demo SPA's required keys.
// Listing them here gives `import.meta.env.VITE_*` proper typing at
// usage sites — see `lib/config.ts`.
interface ImportMetaEnv {
  readonly VITE_OIDC_ISSUER_URL: string;
  readonly VITE_OIDC_CLIENT_ID: string;
  readonly VITE_WS_URL: string;
  readonly VITE_UPLOAD_URL: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
