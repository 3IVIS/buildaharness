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
      // Mirror packages/*/src/index.ts so vitest resolves packages from source
      // rather than requiring each package to be pre-built before running tests.
      '@itsharness/canvas': resolve(__dirname, 'packages/canvas/src/spec/schema.ts'),
      '@itsharness/runtime': resolve(__dirname, 'packages/runtime/src/index.ts'),
      '@itsharness/react': resolve(__dirname, 'packages/react/src/index.ts'),
    },
  },
  server: { port: 3000 },
  test: {
    environment: 'jsdom',
    globals: true,
    exclude: [
      '**/node_modules/**',
      '**/dist/**',
      '**/cypress/**',
      '**/.{idea,git,cache,output,temp}/**',
      '**/{karma,rollup,webpack,vite,vitest,jest,ava,babel,nyc,cypress,tsup,build,eslint,prettier}.config.*',
      'templates/**',
    ],
  },
})
