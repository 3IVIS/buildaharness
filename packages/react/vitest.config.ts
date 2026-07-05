import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: true,
  },
  resolve: {
    alias: {
      '@buildaharness/runtime': resolve(__dirname, '../runtime/src/index.ts'),
      '@buildaharness/canvas': resolve(__dirname, '../canvas/src/spec/schema.ts'),
      '@buildaharness/harness': resolve(__dirname, '../harness/src/index.ts'),
    },
  },
})
