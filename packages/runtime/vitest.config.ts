import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
  },
  resolve: {
    alias: {
      '@buildaharness/canvas': resolve(__dirname, '../canvas/src/spec/schema.ts'),
      '@buildaharness/harness': resolve(__dirname, '../harness/src/index.ts'),
    },
  },
})
