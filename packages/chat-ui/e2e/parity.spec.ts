import { test, expect, type ChatBootstrap, type ChatPage, type SettleOn } from './fixtures'
import type { LLMStructuredResponse } from '@buildaharness/runtime'

/**
 * B3 — the flag OFF-vs-ON parity matrix (the internal plan phase B3).
 *
 * The same shape as R5's CLI live-verification, now in a real browser, run under both
 * `oneLoopMode` states. Each scenario is one deterministic scripted-LLM conversation. The
 * assertion in every case: the flag changes *which proposer ran* (`proposerKind`) but not the
 * user-visible outcome — reply text, whether an approval card appeared, whether the turn
 * halted. That "same path-independent result" is exactly the evidence R5's `DEFAULT_ONE_LOOP_MODE`
 * flip needs.
 *
 * This spec cannot run in the buildaharness dev container (no Chromium). It runs on a dev machine
 * (`npm run test:e2e` in packages/chat-ui) or in CI (phase B4).
 */

const WORKSPACE = '/workspace'

/** A model turn that calls one tool, then (optionally) more responses follow for the loop. */
function toolCall(name: string, input: Record<string, unknown>): LLMStructuredResponse {
  return { content: '', toolCalls: [{ id: `call_${name}`, name, input }] }
}

interface ScenarioRun {
  reply: string
  proposerKind: string
  sawApprovalCard: boolean
  sawHalt: boolean
}

async function runScenario(
  chat: (b: ChatBootstrap) => Promise<ChatPage>,
  oneLoopMode: 'disabled' | 'enabled',
  message: string,
  bootstrap: Omit<ChatBootstrap, 'oneLoopMode'>,
  settleOn: SettleOn,
): Promise<{ page: ChatPage } & ScenarioRun> {
  const page = await chat({ ...bootstrap, oneLoopMode })
  await page.sendMessage(message, settleOn)
  const sawApprovalCard = (await page.approvalCard().count()) > 0
  const sawHalt = (await page.haltBanner().count()) > 0
  const reply = settleOn === 'reply' ? ((await page.lastAssistantBubble().textContent()) ?? '').trim() : ''
  const proposerKind = settleOn === 'reply' ? await page.proposerKind() : ''
  return { page, reply, proposerKind, sawApprovalCard, sawHalt }
}

test.describe('flag OFF vs ON parity matrix', () => {
  test('benign, no tools — identical reply, proposerKind flips', async ({ chat }) => {
    const script = { responses: ['84'], streamChunks: ['84'] }
    const off = await runScenario(chat, 'disabled', 'What is 12 x 7?', { script }, 'reply')
    const on = await runScenario(chat, 'enabled', 'What is 12 x 7?', { script }, 'reply')

    expect(off.reply).toMatch(/84/)
    expect(on.reply).toBe(off.reply)
    expect(off.sawApprovalCard).toBe(false)
    expect(on.sawApprovalCard).toBe(false)
    expect(off.proposerKind).toBe('posthoc')
    expect(on.proposerKind).toBe('flat-oneloop')
  })

  test('read-only tool call, gated — file content in the reply, tool step shown, no staging', async ({ chat }) => {
    const bootstrap = {
      fsSeed: { [`${WORKSPACE}/report.txt`]: 'quarterly numbers: 42' },
      script: {
        responses: [toolCall('read_file', { path: 'report.txt' }), 'The report says: quarterly numbers: 42.'],
        streamChunks: ['The report says: quarterly numbers: 42.'],
      },
    }
    const off = await runScenario(chat, 'disabled', 'Read report.txt and tell me the number', bootstrap, 'reply')
    const on = await runScenario(chat, 'enabled', 'Read report.txt and tell me the number', bootstrap, 'reply')

    for (const run of [off, on]) {
      expect(run.reply).toContain('quarterly numbers: 42')
      expect(run.sawApprovalCard).toBe(false) // read-only → gated, never staged for approval
      await expect(run.page.stepsToggle()).toBeVisible() // the tool call surfaced as a step
      await expect(run.page.haltBanner()).toHaveCount(0) // the ControlState gate ran without erroring
    }
    expect(on.reply).toBe(off.reply)
    expect(off.proposerKind).toBe('posthoc')
    expect(on.proposerKind).toBe('flat-oneloop')
  })

  test('write staged for approval — card appears with kind "write", approve applies it', async ({ chat }) => {
    const bootstrap = {
      script: { responses: [toolCall('write_file', { path: 'summary.md', content: 'draft summary' })] },
    }
    for (const mode of ['disabled', 'enabled'] as const) {
      const run = await runScenario(chat, mode, 'Write a summary to summary.md', bootstrap, 'approval')
      expect(run.sawApprovalCard).toBe(true)
      await expect(run.page.approvalCard()).toContainText('write')

      await run.page.approve()
      await expect(run.page.approvalResolution()).toHaveText('Approved.')
      await expect(run.page.lastAssistantBubble()).toContainText(/Wrote .summary\.md./)
    }
  })

  test('write staged for approval — deny discards it', async ({ chat }) => {
    const bootstrap = {
      script: { responses: [toolCall('write_file', { path: 'summary.md', content: 'never applied' })] },
    }
    for (const mode of ['disabled', 'enabled'] as const) {
      const run = await runScenario(chat, mode, 'Write a summary to summary.md', bootstrap, 'approval')
      expect(run.sawApprovalCard).toBe(true)

      await run.page.deny()
      await expect(run.page.approvalResolution()).toHaveText('Denied.')
      await expect(run.page.lastAssistantBubble()).toContainText('Cancelled')
    }
  })

  test('failing tool call — no crash, the reply acknowledges the failure, turn completes', async ({ chat }) => {
    const bootstrap = {
      fsSeed: {} as Record<string, string>,
      script: {
        responses: [
          toolCall('read_file', { path: 'nope.txt' }),
          'I could not read nope.txt — it does not exist, so I cannot summarize it.',
        ],
        streamChunks: ['I could not read nope.txt — it does not exist, so I cannot summarize it.'],
      },
    }
    const off = await runScenario(chat, 'disabled', 'Summarize nope.txt', bootstrap, 'reply')
    const on = await runScenario(chat, 'enabled', 'Summarize nope.txt', bootstrap, 'reply')

    for (const run of [off, on]) {
      expect(run.reply).toContain('could not read nope.txt')
      expect(run.sawHalt).toBe(false) // recovered inside the turn, not an escalation
    }
    expect(on.reply).toBe(off.reply)
    expect(off.proposerKind).toBe('posthoc')
    expect(on.proposerKind).toBe('flat-oneloop')
  })

  test('a model stuck in a tool loop ends cleanly in the UI, never hangs silently', async ({ chat }) => {
    // The model never produces a final answer — it just keeps calling the same tool. Where the flat loop
    // drives the turn (oneLoopMode disabled) its maxIterations cap turns that into a clean `escalated` result,
    // surfaced as the "Halted — needs your input" banner. Under one-loop (e5780668) an exhausted attempt is a
    // real task failure: the harness retries it with a fresh budget, and when that fails too the turn completes
    // with an honest could-not-complete reply (status ok, real trace) instead of a halt.
    const bootstrap = {
      fsSeed: { [`${WORKSPACE}/report.txt`]: 'quarterly numbers: 42' },
      script: {
        responses: Array.from({ length: 20 }, () => toolCall('read_file', { path: 'report.txt' })),
      },
    }
    const off = await runScenario(chat, 'disabled', 'Keep reading report.txt forever', bootstrap, 'halt')
    expect(off.sawHalt).toBe(true)
    await expect(off.page.haltBanner()).toContainText('Halted')
    await expect(off.page.lastAssistantBubble()).toHaveCount(0) // no fabricated answer

    const on = await runScenario(chat, 'enabled', 'Keep reading report.txt forever', bootstrap, 'reply')
    expect(on.sawHalt).toBe(false)
    expect(on.reply).toContain("couldn't complete")
  })
})

// AL8b — layerPolicyMode static vs adaptive: a routine turn must give the same user-visible outcome
// (the policy only restricts cost layers; floor layers and the reply path are untouched).
test.describe('layerPolicyMode static vs adaptive parity', () => {
  test('benign, no tools — identical reply and no approval card under both modes', async ({ chat }) => {
    const script = { responses: ['84'], streamChunks: ['84'] }
    const replies: string[] = []
    for (const layerPolicyMode of ['static', 'adaptive'] as const) {
      const page = await chat({ script, oneLoopMode: 'enabled', config: { layerPolicyMode } })
      await page.sendMessage('What is 12 x 7?', 'reply')
      replies.push(((await page.lastAssistantBubble().textContent()) ?? '').trim())
      expect(await page.approvalCard().count()).toBe(0)
    }
    expect(replies[0]).toMatch(/84/)
    expect(replies[1]).toBe(replies[0])
  })
})
