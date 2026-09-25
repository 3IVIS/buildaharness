import { describe, it, expect } from 'vitest'
import type { ILLMClient, ChatMessage } from '@buildaharness/runtime'
import { adaptivePolicyArm, flagOnArm, ALL_ARMS, IMPLEMENTED_ARMS, armHonorsInjectedFailure, type MakeLlm } from './arms.js'
import { parseTaskSpec } from './corpus/schema.js'
import { resolveEscalationPlan } from '../src/layer-policy-wiring.js'
import { computeRunState } from '@buildaharness/harness'

/** AL10: the `adaptivePolicy` arm exists, runs one task end-to-end under a scripted client, and static stays untouched. */
const makeLlm: MakeLlm = () => {
  const client: ILLMClient = {
    callChat: async function* () { yield 'The answer is 4.' },
    callChatSync: async () => 'The answer is 4.',
    callChatStructured: async (messages: ChatMessage[], _tools, options) => {
      options?.onUsage?.({ inputTokens: 5, outputTokens: 3, costUsd: 0.001 })
      // The turn classifier asks for JSON; anything else gets a plain answer.
      if (String(messages[0]?.content).startsWith("Classify the user's message")) {
        return {
          content: JSON.stringify({
            riskLevel: 'LOW', riskReason: 'arithmetic', isTrivial: false, decomposedTasks: [], isReminderRequest: false,
            isBulkReminderRequest: false, isAbandonRequest: false, matchedPlanTemplate: null, needsMultiStepPlan: false,
            statesDurableFacts: [], needsGrounding: false, ambiguity: 'none', userPosture: 'informational',
            pushbackOnPriorTurn: false, statesConstraint: false,
          }),
        }
      }
      return { content: 'The answer is 4.' }
    },
  }
  return client
}

const task = parseTaskSpec({ id: 'adaptive-smoke', category: 'multi_step', intent: 'i', prompt: 'What is 2+2?', grader: { contains: ['4'] } }, 't')

describe('adaptivePolicy arm (AL10)', () => {
  it('is registered and honours the one-loop injected-failure path like flagOn', () => {
    expect(ALL_ARMS).toContain(adaptivePolicyArm)
    expect(IMPLEMENTED_ARMS).toContain(adaptivePolicyArm)
    expect(armHonorsInjectedFailure('adaptivePolicy', 'persistent_tool_failure')).toBe(true)
  })

  it('runs one task end-to-end under a scripted client, as does flagOn', async () => {
    const a = await adaptivePolicyArm.run(task, makeLlm)
    const f = await flagOnArm.run(task, makeLlm)
    expect(a).not.toBeNull()
    expect(f).not.toBeNull()
    expect(a?.reply).toContain('4')
  })

  it('a trace of the executed policy shows a skipped-with-trigger and an escalated-with-trigger layer; static is untouched', () => {
    const tools = new Set(['write_file'])
    const calm = resolveEscalationPlan('adaptive', { riskLevel: 'LOW', taskCount: 1, hasDurablePlan: false, consequentialTools: tools, userPosture: 'informational' }, computeRunState())
    expect(calm.policy.reviewer_adversarial).toMatchObject({ decision: 'off', trigger: 'low_risk_no_failure' })
    const risky = resolveEscalationPlan('adaptive', { riskLevel: 'HIGH', taskCount: 1, hasDurablePlan: false, consequentialTools: tools }, computeRunState())
    expect(risky.policy.reviewer_adversarial).toMatchObject({ decision: 'full', trigger: 'risk_medium_plus' })
    // static executes today's behaviour: every layer static/full; shadow executes static but records the adaptive decision
    const stat = resolveEscalationPlan('static', { riskLevel: 'LOW', taskCount: 1, hasDurablePlan: false, consequentialTools: tools }, computeRunState())
    expect(Object.values(stat.policy).every((d) => d.decision === 'full' && d.trigger === 'static')).toBe(true)
    const shadow = resolveEscalationPlan('shadow', { riskLevel: 'LOW', taskCount: 1, hasDurablePlan: false, consequentialTools: tools, userPosture: 'informational' }, computeRunState())
    expect(Object.values(shadow.policy).every((d) => d.decision === 'full')).toBe(true)
    expect(shadow.shadow?.policy.reviewer_adversarial.decision).toBe('off')
  })
})
