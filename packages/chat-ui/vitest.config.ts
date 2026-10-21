import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { planVizVendorPlugin } from './plan-viz-aliases'

export default defineConfig({
  plugins: [planVizVendorPlugin(), react()],
  // The page gets mammoth's browser build (its package.json "browser" field); the tests run in Node, so they are pointed at the same build.
  resolve: { alias: { mammoth: 'mammoth/mammoth.browser.js' } },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test-setup.ts'],
    // `e2e/` holds Playwright specs (`*.spec.ts`), which Vitest's default glob would otherwise
    // pick up and fail on (`@playwright/test` is not a Vitest runner). They run via
    // `npm run test:e2e` / phase B4's CI job. See the internal plan B2.
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
})
