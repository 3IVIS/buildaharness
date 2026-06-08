import { defineConfig } from 'vitest/config'
import { resolve } from 'path'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
  },
  resolve: {
    alias: {
      '@itsharness/canvas': resolve(__dirname, '../canvas/src/spec/schema.ts'),
    },
  },
})
