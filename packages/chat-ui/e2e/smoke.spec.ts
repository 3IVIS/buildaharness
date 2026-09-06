import { test, expect } from './fixtures'

/**
 * B2 smoke: prove the harness is real (load the app, type, read a scripted reply), and that the
 * B1 `proposerKind` telemetry surfaces in a real browser under both flag states. The full
 * OFF-vs-ON parity matrix is phase B3.
 *
 * This spec cannot run in the buildaharness dev container (no Chromium). It runs on a dev machine
 * (`npm run test:e2e` in packages/chat-ui) or in CI (phase B4).
 */

test('load app, send a message, get a scripted reply — no tools, no approval card', async ({ chat }) => {
  const page = await chat({
    oneLoopMode: 'disabled', // explicit — the default is now 'enabled' (R5 flip); this spec pins the posthoc path
    script: { responses: ['Hello from the scripted client.'], streamChunks: ['Hello from the scripted client.'] },
  })

  await page.sendMessage('hi')

  await expect(page.lastAssistantBubble()).toHaveText(/Hello from the scripted client\./)
  await expect(page.approvalCard()).toHaveCount(0)
  expect(await page.proposerKind()).toBe('posthoc')
})

test('persisted oneLoopMode "enabled" flips proposerKind to flat-oneloop', async ({ chat }) => {
  const page = await chat({
    oneLoopMode: 'enabled',
    script: { responses: ['84'], streamChunks: ['84'] },
  })

  await page.sendMessage('What is 12 x 7?')

  await expect(page.lastAssistantBubble()).toHaveText(/84/)
  expect(await page.proposerKind()).toBe('flat-oneloop')
})
