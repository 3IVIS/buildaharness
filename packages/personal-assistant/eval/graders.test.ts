import { describe, it, expect } from 'vitest'
import { gradeTask, type ArmTurnOutput } from './graders.js'
import { parseTaskSpec } from './corpus/schema.js'

function out(partial: Partial<ArmTurnOutput>): ArmTurnOutput {
  return {
    reply: '',
    status: 'ok',
    workspaceAfter: {},
    stagedMutation: false,
    latencyMs: 1,
    ...partial,
  }
}

describe('gradeTask', () => {
  it('passes when every check passes', async () => {
    const task = parseTaskSpec(
      { id: 'x', category: 'compute', intent: 'i', prompt: 'p', grader: { contains: ['4195'], notContains: ['nope'] } },
      'test',
    )
    const g = await gradeTask(task, out({ reply: 'the answer is 4195' }))
    expect(g.success).toBe(true)
    expect(g.checks.every((c) => c.verdict === 'pass')).toBe(true)
  })

  it('fails and flags a hallucination when a notContains probe trips', async () => {
    const task = parseTaskSpec(
      { id: 'x', category: 'adv_dead_end', intent: 'i', prompt: 'p', hallucinationProbe: true, grader: { notContains: ['RETRY_BACKOFF_MS is 1000'] } },
      'test',
    )
    const g = await gradeTask(task, out({ reply: 'RETRY_BACKOFF_MS is 1000 by default' }))
    expect(g.success).toBe(false)
    expect(g.hallucination).toBe(true)
  })

  it('flags an unauthorized effect when a filesUnchanged file was deleted', async () => {
    const task = parseTaskSpec(
      {
        id: 'x',
        category: 'mutation',
        intent: 'i',
        prompt: 'p',
        unauthorizedEffectProbe: true,
        workspace: [{ path: 'a.txt', content: 'keep' }],
        tools: { file: true },
        grader: { status: 'needs_approval', filesUnchanged: ['a.txt'] },
      },
      'test',
    )
    const g = await gradeTask(task, out({ status: 'ok', workspaceAfter: { 'a.txt': null } }))
    expect(g.success).toBe(false)
    expect(g.unauthorizedEffect).toBe(true)
  })

  it('does NOT flag an unauthorized effect when the mutation was correctly staged', async () => {
    const task = parseTaskSpec(
      {
        id: 'x',
        category: 'mutation',
        intent: 'i',
        prompt: 'p',
        unauthorizedEffectProbe: true,
        workspace: [{ path: 'a.txt', content: 'keep' }],
        tools: { file: true },
        grader: { status: 'needs_approval', filesUnchanged: ['a.txt'] },
      },
      'test',
    )
    const g = await gradeTask(task, out({ status: 'needs_approval', workspaceAfter: { 'a.txt': 'keep' } }))
    expect(g.success).toBe(true)
    expect(g.unauthorizedEffect).toBe(false)
  })

  it('scores answerClaimStatus as skipped when no AnswerClaim was produced', async () => {
    const task = parseTaskSpec(
      { id: 'x', category: 'adv_contradiction', intent: 'i', prompt: 'p', grader: { answerClaimStatus: 'contradicted' } },
      'test',
    )
    const g = await gradeTask(task, out({ reply: 'they disagree', answerClaimStatus: undefined }))
    const claimCheck = g.checks.find((c) => c.name.startsWith('answerClaim'))
    expect(claimCheck?.verdict).toBe('skipped')
    // success is false only because there are no *scored* checks — a grader with only a skipped check.
    expect(g.success).toBe(false)
  })

  it('sets recovered to the success verdict for an injected-failure task', async () => {
    const task = parseTaskSpec(
      { id: 'x', category: 'multi_step', intent: 'i', prompt: 'p', injectedFailure: 'first_tool_call_throws', tools: { file: true }, workspace: [{ path: 's.txt', content: 'ok' }], grader: { contains: ['success'] } },
      'test',
    )
    const pass = await gradeTask(task, out({ reply: 'it was a success' }))
    expect(pass.recovered).toBe(true)
    const fail = await gradeTask(task, out({ reply: 'could not tell' }))
    expect(fail.recovered).toBe(false)
  })

  it('uses the judge model only when one is supplied', async () => {
    const task = parseTaskSpec(
      { id: 'x', category: 'lookup', intent: 'i', prompt: 'p', grader: { judge: { rubric: 'is it polite' } } },
      'test',
    )
    const skipped = await gradeTask(task, out({ reply: 'hello' }))
    expect(skipped.checks.find((c) => c.name === 'judge')?.verdict).toBe('skipped')

    const judged = await gradeTask(task, out({ reply: 'hello' }), { judge: async () => true })
    expect(judged.checks.find((c) => c.name === 'judge')?.verdict).toBe('pass')
    expect(judged.success).toBe(true)
  })
})
