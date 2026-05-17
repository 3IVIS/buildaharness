import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  resolve: {
    // Fix #14: tsconfig.json declares "@/*" → "src/*" paths but Vite requires its own alias.
    // Without this, any `import ... from '@/...'` compiles in TS but fails at build time.
    alias: { '@': resolve(__dirname, 'src') },
  },
  server: { port: 3000 },
  test: { environment: 'jsdom' },
})
