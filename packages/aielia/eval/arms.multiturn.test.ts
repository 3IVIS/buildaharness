import { describe, it, expect } from 'vitest'
import type { ILLMClient, ChatMessage } from '@buildaharness/runtime'
import { bareArm } from './bare-arm.js'
import type { MakeLlm } from './arms.js'
import { parseTaskSpec } from './corpus/schema.js'

/**
 * Multi-turn support (plans/multi_turn_benchmark_corpus_plan.md): a task with `followups` is
 * sent turn-by-turn to the *same* session. Exercised here against the `bare` arm because it
 * needs no `PersonalAssistant` — a fake `ILLMClient` that replies with plain text (no tool
 * calls) is enough to prove the loop.
 */
describe('multi-turn arm loop (bare)', () => {
  it('sends turn 1 + every followup, sums usage, marks turns, and records turn boundaries', async () => {
    const userMessagesSeen: string[][] = []
    let call = 0
    const makeLlm: MakeLlm = () => {
      const client: ILLMClient = {
        callChat: () => {
          throw new Error('unused')
        },
        callChatSync: () => Promise.reject(new Error('unused')),
        callChatStructured: async (messages: ChatMessage[], _tools, options) => {
          call += 1
          userMessagesSeen.push(messages.filter((m) => m.role === 'user').map((m) => String(m.content)))
          options?.onUsage?.({ inputTokens: 10, outputTokens: 4, costUsd: 0.002 })
          return { content: `reply ${call}` }
        },
      }
      return client
    }

    const task = parseTaskSpec(
      {
        id: 'mt-fake',
        category: 'multi_step',
        intent: 'i',
        prompt: 'turn one',
        followups: [{ prompt: 'turn two' }, { prompt: 'turn three' }],
        grader: { contains: ['reply 3'] },
      },
      't',
    )

    const out = await bareArm.run(task, makeLlm)
    expect(out).not.toBeNull()
    if (!out) return

    expect(out.turns).toBe(3)
    // one structured call per turn (no tool calls → the inner loop breaks immediately)
    expect(call).toBe(3)
    // the final reply is turn 3's
    expect(out.reply).toBe('reply 3')
    // usage summed across turns
    expect(out.inputTokens).toBe(30)
    expect(out.outputTokens).toBe(12)
    expect(out.costUsd).toBeCloseTo(0.006)
    // by the last call the model saw all three user messages in one growing history
    expect(userMessagesSeen[2]).toEqual(['turn one', 'turn two', 'turn three'])
    // transcript carries a turn_boundary marker per followup
    const boundaries = (out.transcript ?? []).filter(
      (e) => e.kind === 'trace' && (e.detail as { kind?: string } | undefined)?.kind === 'turn_boundary',
    )
    expect(boundaries).toHaveLength(2)
  })

  it('a task with no followups still runs as a single turn', async () => {
    const makeLlm: MakeLlm = () => ({
      callChat: () => {
        throw new Error('unused')
      },
      callChatSync: () => Promise.reject(new Error('unused')),
      callChatStructured: async () => ({ content: 'only reply' }),
    })
    const task = parseTaskSpec({ id: 'st-fake', category: 'compute', intent: 'i', prompt: 'p', grader: { contains: ['only'] } }, 't')
    const out = await bareArm.run(task, makeLlm)
    expect(out?.turns).toBe(1)
    expect(out?.reply).toBe('only reply')
  })
})
