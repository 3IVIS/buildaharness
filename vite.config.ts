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
      '@buildaharness/runtime': resolve(__dirname, 'packages/runtime/src/index.ts'),
      '@buildaharness/react': resolve(__dirname, 'packages/react/src/index.ts'),
      '@buildaharness/harness': resolve(__dirname, 'packages/harness/src/index.ts'),
      '@buildaharness/personal-assistant': resolve(__dirname, 'packages/personal-assistant/src/index.ts'),
    },
  },
  server: { port: 3000 },
  test: {
    environment: 'jsdom',
    globals: true,
    // packages/chat-ui's own tests need jest-dom matchers + a scrollIntoView
    // polyfill (jsdom doesn't implement it) — root's blanket test run picks up
    // that package's *.test.* files too, so it needs the same setup.
    setupFiles: ['./packages/chat-ui/src/test-setup.ts'],
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
