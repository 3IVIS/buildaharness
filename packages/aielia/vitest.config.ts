import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    // The reply audit adds an LLM call per turn; scripted-LLM tests count calls, so it is off here and switched on per test (`replyAudit: true`).
    env: { AIELIA_REPLY_AUDIT: '0' },
  },
})
