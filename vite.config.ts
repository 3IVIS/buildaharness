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
      // packages/chat-ui/e2e/ holds Playwright specs (`*.spec.ts`) — `@playwright/test` is not a
      // Vitest runner, so the blanket root run must skip them just as chat-ui's own vitest.config.ts
      // does. They run via `npm run test:e2e` / phase B4's CI job. See plans/chat_ui_browser_e2e_plan.html B2.
      'packages/*/e2e/**',
      // tui-input.test.tsx renders real `ink` components through ink's own React 19 reconciler.
      // ink/react are deliberately nested under packages/personal-assistant only (root pins React
      // 18 for the rest of the repo — see ink-test-render.ts's header comment). Root's blanket run
      // goes through this file's own `@vitejs/plugin-react` + jsdom React-18 test environment, so
      // elements ink's reconciler receives come from a different React copy than the one it was
      // built against ("A React Element from an older version of React was rendered"). This file
      // is already covered, correctly isolated, by `npm run test:personal-assistant`'s own
      // vitest.config.ts (no alias/shared React 18 environment).
      'packages/personal-assistant/src/tui-input.test.tsx',
      // Same reason as tui-input.test.tsx immediately above — tui-app.test.tsx (Phase 3 of the
      // same plan) also mounts real `ink` components via ink-test-render.ts. Already covered by
      // `npm run test:personal-assistant`'s own vitest.config.ts.
      'packages/personal-assistant/src/tui-app.test.tsx',
    ],
  },
})
