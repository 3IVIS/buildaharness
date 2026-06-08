import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Fix #14: tsconfig.json declares "@/*" → "src/*" paths but Vite requires its own alias.
    // Without this, any `import ... from '@/...'` compiles in TS but fails at build time.
    alias: {
      '@': resolve(__dirname, 'src'),
      // Mirror packages/runtime/tsconfig.json paths so vitest resolves the canvas
      // spec module from source rather than requiring the package to be pre-built.
      '@itsharness/canvas': resolve(__dirname, 'packages/canvas/src/spec/schema.ts'),
    },
  },
  server: { port: 3000 },
  test: { environment: 'jsdom' },
})
