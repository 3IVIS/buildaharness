import { describe, it, expect } from 'vitest'
import { HarnessRuntime } from './harness-runtime.js'
import type { Task } from './state/task-graph.js'

// A host callback or semantic hook that throws (a tracing hook bug, an LLM/network error inside a checker) must not
// abort the run: observability handlers are ignored, and the semantic hooks fail open.

const task: Task = {
  id: 't1', description: 'Answer the question', status: 'PENDING', risk_level: 'LOW',
  depends_on: [], parallel_write_domains: [], abstraction_level: 1, assigned_strategy: null,
}

describe('throwing host callbacks and hooks', () => {
  it('still completes when every observability handler and semantic hook throws', async () => {
    const boom = (): never => { throw new Error('host fault') }
    const out = await new HarnessRuntime().run('answer', ['answered'], {
      initialTasks: [{ ...task }],
      max_steps: 8,
      toolExecutors: { default: () => 'The answer is 42.' },
      onLayerActivity: boom,
      onVerification: boom,
      onGateDecision: boom,
      onReviewConflict: boom,
      contradictionChecker: async () => boom(),
      semanticChangeReviewer: async () => boom(),
      semanticFailureMatcher: async () => boom(),
      factExtractor: () => [{ statement: 'The user likes tea', isNew: true }, { statement: 'The user dislikes tea', isNew: true }],
    })
    expect(out.status).toBe('complete')
    if (out.status === 'complete') expect(out.result.finalResult).toBe('The answer is 42.')
  })
})
