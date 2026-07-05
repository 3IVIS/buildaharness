import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { resolve } from 'path'

export default defineConfig({
  plugins: [react()],
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
  },
  resolve: {
    alias: {
      '@buildaharness/personal-assistant': resolve(__dirname, '../personal-assistant/src/index.ts'),
      '@buildaharness/runtime': resolve(__dirname, '../runtime/src/index.ts'),
      '@buildaharness/harness': resolve(__dirname, '../harness/src/index.ts'),
      '@buildaharness/canvas': resolve(__dirname, '../canvas/src/spec/schema.ts'),
    },
  },
})
