/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_A2A_ENABLED:         string
  readonly VITE_LANGFUSE_ENABLED:    string
  readonly VITE_LANGFUSE_PUBLIC_KEY: string
  readonly VITE_LANGFUSE_HOST:       string
}

interface ImportMeta {
  readonly env: ImportMetaEnv
}
