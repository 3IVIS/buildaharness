/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL:             string   // adapter base URL; defaults to http://localhost:8000
  readonly VITE_A2A_ENABLED:         string
  readonly VITE_LANGFUSE_ENABLED:    string
  readonly VITE_LANGFUSE_PUBLIC_KEY: string
  readonly VITE_LANGFUSE_HOST:       string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
