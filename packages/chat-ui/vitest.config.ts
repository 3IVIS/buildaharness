import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
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
