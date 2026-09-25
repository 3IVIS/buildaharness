// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { attributeArm, attributeTranscript, classifyCall, explainCostDelta, renderCostMarkdown, type AttributableTranscript } from './cost-attribution.js'

const CLASSIFY = "Classify the user's message across eight independent judgments, for a personal-assistant"
const PROPOSER = 'You are Aielia, a helpful, concise personal assistant. Answer directly'
const REFRAME = "Restate the user's message as a single task description, starting with the concrete subject"

/** One request/response pair 1s apart with the given usage. */
function call(t0: number, system: string, cost: number, tokens: [number, number] = [10, 20]) {
  return [
    { t: t0, kind: 'llm_request', messages: [{ role: 'system', content: system }, { role: 'user', content: 'hi' }] },
    { t: t0 + 1000, kind: 'llm_response', reply: 'x', usage: { inputTokens: tokens[0], outputTokens: tokens[1], costUsd: cost } },
  ]
}

const transcript = (arm: string, ...pairs: Array<[string, number]>): AttributableTranscript => ({
  arm,
  events: pairs.flatMap(([sys, cost], i) => call(i * 2000, sys, cost)),
})

describe('classifyCall', () => {
  it('maps system-prompt signatures to purposes and falls back to unattributed', () => {
    expect(classifyCall(CLASSIFY)).toBe('classifier')
    expect(classifyCall(PROPOSER)).toBe('proposer')
    expect(classifyCall(REFRAME)).toBe('decomposition_reframe')
    expect(classifyCall('You check a personal assistant\'s beliefs for genuine contradictions — x')).toBe('contradiction_check')
    expect(classifyCall('something new')).toBe('unattributed')
  })
})

describe('attributeTranscript', () => {
  it('attributes calls, tokens, cost and latency per purpose and counts proposer iterations', () => {
    const a = attributeTranscript(transcript('on', [CLASSIFY, 0.01], [PROPOSER, 0.02], [PROPOSER, 0.03], [REFRAME, 0.005]))
    expect(a.byPurpose.classifier).toEqual({ calls: 1, tokens: 30, costUsd: 0.01, latencyMs: 1000 })
    expect(a.byPurpose.proposer?.calls).toBe(2)
    expect(a.byPurpose.proposer?.costUsd).toBeCloseTo(0.05)
    expect(a.byPurpose.decomposition_reframe?.calls).toBe(1)
    expect(a.proposerIterations).toBe(2)
  })

  it('counts an unanswered request as a call with no cost', () => {
    const a = attributeTranscript({ arm: 'on', events: [{ t: 0, kind: 'llm_request', messages: [{ role: 'system', content: PROPOSER }] }] })
    expect(a.byPurpose.proposer).toEqual({ calls: 1, tokens: 0, costUsd: 0, latencyMs: 0 })
  })
})

describe('explainCostDelta (fixture: a layer that adds a re-asked proposer iteration and its own call)', () => {
  const off = attributeArm('off', [transcript('off', [CLASSIFY, 0.01], [PROPOSER, 0.02]), transcript('off', [CLASSIFY, 0.01], [PROPOSER, 0.02])])
  const on = attributeArm('on', [transcript('on', [CLASSIFY, 0.01], [REFRAME, 0.01], [PROPOSER, 0.02], [PROPOSER, 0.02]), transcript('on', [CLASSIFY, 0.01], [REFRAME, 0.01], [PROPOSER, 0.02], [PROPOSER, 0.02])])
  const e = explainCostDelta(on, off)

  it('splits the arm delta into own calls, extra proposer iterations and the floor', () => {
    expect(e.relative.costUsd).toBeCloseTo(0.03 / 0.03) // $0.03 → $0.06
    expect(e.ownCalls.calls).toBeCloseTo(1)
    expect(e.ownCalls.costUsd).toBeCloseTo(0.01)
    expect(e.proposerDelta.calls).toBeCloseTo(1)
    expect(e.proposerDelta.costUsd).toBeCloseTo(0.02)
    expect(e.classifierDelta.costUsd).toBeCloseTo(0)
    expect(e.purposes.find((p) => p.purpose === 'proposer')?.shareOfCostDelta).toBeCloseTo(2 / 3)
    expect(e.summary).toMatch(/own sub-calls account for 33%/)
    expect(e.summary).not.toMatch(/run-to-run/)
  })

  it('flags a delta carried by the identical classifier call as run-to-run noise', () => {
    const noisyOn = attributeArm('on', [transcript('on', [CLASSIFY, 0.02], [PROPOSER, 0.02])])
    const noisy = explainCostDelta(noisyOn, attributeArm('off', [transcript('off', [CLASSIFY, 0.01], [PROPOSER, 0.02])]))
    expect(noisy.summary).toMatch(/run-to-run variation/)
  })

  it('renders a table with the purposes', () => {
    const md = renderCostMarkdown([{ feature: 'f', mechanism: 'verification', onArm: 'on', offArm: 'off', explanation: e }])
    expect(md).toContain('| proposer |')
    expect(md).toContain('## f')
  })
})
