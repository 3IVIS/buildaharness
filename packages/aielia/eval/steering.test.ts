import { describe, it, expect } from 'vitest'
import type { ILLMClient, ChatMessage } from '@buildaharness/runtime'
import { bareArm } from './bare-arm.js'
import type { MakeLlm } from './arms.js'
import { goalGraphOnArm, ALL_ARMS, IMPLEMENTED_ARMS, armHonorsInjectedFailure } from './arms.js'
import { parseTaskSpec, steeringAsFollowups } from './corpus/schema.js'

const base = {
  id: 'steer-fake',
  category: 'multi_step',
  intent: 'i',
  prompt: 'turn one',
  grader: { contains: ['x'] },
}

describe('TaskSpec.steering', () => {
  it('defaults to empty and defaults afterTraceEvents to 1', () => {
    expect(parseTaskSpec(base, 't').steering).toEqual([])
    const t = parseTaskSpec({ ...base, steering: [{ message: 'hey' }] }, 't')
    expect(t.steering).toEqual([{ message: 'hey', afterTraceEvents: 1 }])
  })

  it('rejects an empty message and a zero threshold', () => {
    expect(() => parseTaskSpec({ ...base, steering: [{ message: '' }] }, 't')).toThrow()
    expect(() => parseTaskSpec({ ...base, steering: [{ message: 'a', afterTraceEvents: 0 }] }, 't')).toThrow()
  })
})

describe('steeringAsFollowups', () => {
  it('is the identity for a task without steering', () => {
    const t = parseTaskSpec(base, 't')
    expect(steeringAsFollowups(t)).toBe(t)
  })

  it('queues steering messages, in order, ahead of declared followups', () => {
    const t = parseTaskSpec(
      { ...base, steering: [{ message: 's1' }, { message: 's2', afterTraceEvents: 3 }], followups: [{ prompt: 'f1' }] },
      't',
    )
    const q = steeringAsFollowups(t)
    expect(q.steering).toEqual([])
    expect(q.followups.map((f) => f.prompt)).toEqual(['s1', 's2', 'f1'])
    expect(t.steering).toHaveLength(2) // input not mutated
  })
})

describe('bare arm with steering', () => {
  it('treats each steering message as the next user turn', async () => {
    const seen: string[][] = []
    const makeLlm: MakeLlm = () =>
      ({
        callChat: () => {
          throw new Error('unused')
        },
        callChatSync: () => Promise.reject(new Error('unused')),
        callChatStructured: async (messages: ChatMessage[]) => {
          seen.push(messages.filter((m) => m.role === 'user').map((m) => String(m.content)))
          return { content: `reply ${seen.length}` }
        },
      }) as ILLMClient
    const task = parseTaskSpec({ ...base, steering: [{ message: 'steer me' }] }, 't')
    const out = await bareArm.run(task, makeLlm)
    expect(out?.turns).toBe(2)
    expect(out?.reply).toBe('reply 2')
    expect(seen[1]).toEqual(['turn one', 'steer me'])
  })
})

describe('goalGraphOn arm registration', () => {
  it('is registered, runs the one-loop path, and honors injected failures like flagOn', () => {
    expect(goalGraphOnArm.name).toBe('goalGraphOn')
    expect(ALL_ARMS).toContain(goalGraphOnArm)
    expect(IMPLEMENTED_ARMS).toContain(goalGraphOnArm)
    expect(armHonorsInjectedFailure('goalGraphOn', 'persistent_tool_failure')).toBe(true)
  })
})
