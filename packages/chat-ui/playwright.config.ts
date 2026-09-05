import { defineConfig, devices } from '@playwright/test'

/**
 * Browser E2E lane for plans/chat_ui_browser_e2e_plan.html phase B2.
 *
 * Chromium only (Playwright ships and manages its own binary — works headless with no `$DISPLAY`
 * on Linux; system Firefox here is a broken snap, system Chrome is absent). The app under test is
 * a real Vite production-shape build with `VITE_E2E=1`, served by `vite preview`, so the bundle,
 * `import.meta.env` substitution and CSP are all exercised for real — the gap jsdom can't close.
 *
 * The `oneLoopMode` ON/OFF matrix runs against a **single** build: B1 made the flag a runtime
 * value (a persisted `buildaharness.personal-assistant.config` entry), so `e2e/fixtures.ts` sets
 * it per-test via `addInitScript` rather than needing two preview builds.
 *
 * This config cannot run in the buildaharness dev container (no Chromium, no `npx playwright
 * install`). It is exercised on a dev machine / in CI (phase B4).
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  workers: process.env.CI ? 1 : undefined,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL: 'http://localhost:4173',
    trace: process.env.CI ? 'on-first-retry' : 'off',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    command: 'npm run build:e2e && npm run preview:e2e',
    url: 'http://localhost:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
    stdout: 'pipe',
    stderr: 'pipe',
  },
})
