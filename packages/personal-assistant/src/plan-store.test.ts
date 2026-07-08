import { describe, it, expect } from 'vitest'
import { InMemoryAdapter } from '@buildaharness/runtime'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import {
  loadActivePlan,
  createPlanRecord,
  savePlan,
  abandonPlan,
  updatePlanFromRun,
  planCompletionPct,
  computePlanPosition,
  nextPendingTask,
  formatPlanProgress,
  isAbandonPhrase,
  isAbandonPhraseWithLLM,
  type PlanRecord,
} from './plan-store.js'
import type { Plan } from './plan-builder.js'

function makePlan(): Plan {
  return {
    templateName: 'project_planning',
    successCriteria: 'The launch ships on time.',
    tasks: [
      { id: 't1', description: 'Gather requirements', depends_on: [] },
      { id: 't2', description: 'Build the thing', depends_on: ['t1'] },
      { id: 't3', description: 'Ship it', depends_on: ['t2'] },
    ],
  }
}

describe('loadActivePlan', () => {
  it('returns null when no plan exists for the session', async () => {
    const memory = new InMemoryAdapter()
    expect(await loadActivePlan(memory, 'session-1')).toBeNull()
  })

  it('returns the stored record when it is active', async () => {
    const memory = new InMemoryAdapter()
    const record = createPlanRecord(makePlan())
    await savePlan(memory, 'session-1', record)

    const loaded = await loadActivePlan(memory, 'session-1')
    expect(loaded).toEqual(record)
  })

  it('returns null when the stored record is done', async () => {
    const memory = new InMemoryAdapter()
    const record = createPlanRecord(makePlan())
    const done = updatePlanFromRun(record, record.tasks.map((t) => ({ id: t.id, status: 'COMPLETE' })))
    await savePlan(memory, 'session-1', done)

    expect(await loadActivePlan(memory, 'session-1')).toBeNull()
  })

  it('returns null when the stored record is abandoned', async () => {
    const memory = new InMemoryAdapter()
    const record = createPlanRecord(makePlan())
    await savePlan(memory, 'session-1', record)
    await abandonPlan(memory, 'session-1', record)

    expect(await loadActivePlan(memory, 'session-1')).toBeNull()
  })

  it('keys plans by session, not globally', async () => {
    const memory = new InMemoryAdapter()
    await savePlan(memory, 'session-1', createPlanRecord(makePlan()))

    expect(await loadActivePlan(memory, 'session-2')).toBeNull()
  })
})

describe('createPlanRecord', () => {
  it('starts every task as PENDING and the plan as active', () => {
    const record = createPlanRecord(makePlan())
    expect(record.status).toBe('active')
    expect(record.tasks.every((t) => t.status === 'PENDING')).toBe(true)
    expect(record.tasks.map((t) => t.id)).toEqual(['t1', 't2', 't3'])
  })
})

describe('updatePlanFromRun', () => {
  it('maps harness task statuses back onto the plan tasks by id', () => {
    const record = createPlanRecord(makePlan())
    const updated = updatePlanFromRun(record, [
      { id: 't1', status: 'COMPLETE' },
      { id: 't2', status: 'PENDING' },
      { id: 't3', status: 'PENDING' },
    ])

    expect(updated.tasks.find((t) => t.id === 't1')!.status).toBe('COMPLETE')
    expect(updated.tasks.find((t) => t.id === 't2')!.status).toBe('PENDING')
    expect(updated.status).toBe('active')
  })

  it('flips status to done once every task is COMPLETE', () => {
    const record = createPlanRecord(makePlan())
    const updated = updatePlanFromRun(record, record.tasks.map((t) => ({ id: t.id, status: 'COMPLETE' })))

    expect(updated.status).toBe('done')
  })

  it('leaves a task status unchanged if the harness result omits it', () => {
    const record = createPlanRecord(makePlan())
    const updated = updatePlanFromRun(record, [{ id: 't1', status: 'COMPLETE' }])

    expect(updated.tasks.find((t) => t.id === 't2')!.status).toBe('PENDING')
  })

  it('normalizes a task left RUNNING (step cap hit mid-task) back to PENDING, not stranding it', () => {
    const record = createPlanRecord(makePlan())
    const updated = updatePlanFromRun(record, [
      { id: 't1', status: 'RUNNING' },
      { id: 't2', status: 'PENDING' },
      { id: 't3', status: 'PENDING' },
    ])

    expect(updated.tasks.find((t) => t.id === 't1')!.status).toBe('PENDING')
    expect(updated.status).toBe('active')
  })
})

describe('planCompletionPct', () => {
  it('computes the percentage of COMPLETE tasks', () => {
    const record = createPlanRecord(makePlan())
    const updated = updatePlanFromRun(record, [{ id: 't1', status: 'COMPLETE' }])

    expect(planCompletionPct(updated)).toBeCloseTo(33.33, 1)
  })

  it('returns 0 for a plan with no tasks', () => {
    const empty: PlanRecord = { templateName: 'x', successCriteria: 'y', tasks: [], status: 'active', createdAt: '', updatedAt: '' }
    expect(planCompletionPct(empty)).toBe(0)
  })
})

describe('formatPlanProgress', () => {
  it('includes the template name, completion percentage, task lines, and success criteria', () => {
    const record = createPlanRecord(makePlan())
    const text = formatPlanProgress(record)

    expect(text).toContain('project_planning')
    expect(text).toContain('0.0% complete')
    expect(text).toContain('t1')
    expect(text).toContain('Gather requirements')
    expect(text).toContain('The launch ships on time.')
  })
})

describe('isAbandonPhrase', () => {
  it('matches common abandon phrases', () => {
    expect(isAbandonPhrase('Forget this plan, let\'s do something else.')).toBe(true)
    expect(isAbandonPhrase('Actually, start over.')).toBe(true)
    expect(isAbandonPhrase('Never mind the plan.')).toBe(true)
  })

  it('does not match ordinary messages', () => {
    expect(isAbandonPhrase('What is the next step?')).toBe(false)
  })
})

class StructuredOnlyLLMClient implements ILLMClient {
  constructor(private readonly content: string) {}

  async *callChat(): AsyncIterable<string> {
    yield ''
  }
  async callChatSync(): Promise<string> {
    return ''
  }
  async callChatStructured(_messages: ChatMessage[], _tools?: ToolDefinition[], _options?: ChatOptions): Promise<LLMStructuredResponse> {
    return { content: this.content }
  }
}

class ThrowingLLMClient implements ILLMClient {
  async *callChat(): AsyncIterable<string> {
    yield ''
  }
  async callChatSync(): Promise<string> {
    return ''
  }
  async callChatStructured(): Promise<LLMStructuredResponse> {
    throw new Error('proxy unreachable')
  }
}

describe('isAbandonPhraseWithLLM', () => {
  it('returns true when the LLM says the message abandons the plan', async () => {
    const llm = new StructuredOnlyLLMClient(JSON.stringify({ abandon: true }))
    expect(await isAbandonPhraseWithLLM("let's not bother with this plan anymore", llm)).toBe(true)
  })

  it('returns false when the LLM says the message does not abandon the plan', async () => {
    const llm = new StructuredOnlyLLMClient(JSON.stringify({ abandon: false }))
    expect(await isAbandonPhraseWithLLM('what is the next step?', llm)).toBe(false)
  })

  it('returns false on malformed JSON instead of throwing', async () => {
    const llm = new StructuredOnlyLLMClient('not json at all')
    expect(await isAbandonPhraseWithLLM('anything', llm)).toBe(false)
  })

  it('returns false when the LLM call itself throws', async () => {
    const llm = new ThrowingLLMClient()
    expect(await isAbandonPhraseWithLLM('anything', llm)).toBe(false)
  })
})

describe('computePlanPosition', () => {
  it('reports the first task before anything has started', () => {
    const plan = createPlanRecord(makePlan())
    const pos = computePlanPosition(plan, plan.tasks)
    expect(pos).toEqual({ templateName: 'project_planning', stepIndex: 1, stepCount: 3, currentTaskDescription: 'Gather requirements', completionPct: 0 })
  })

  it('reports the RUNNING task mid-run', () => {
    const plan = createPlanRecord(makePlan())
    const live = [
      { id: 't1', status: 'COMPLETE' as const },
      { id: 't2', status: 'RUNNING' as const },
      { id: 't3', status: 'PENDING' as const },
    ]
    const pos = computePlanPosition(plan, live)
    expect(pos?.stepIndex).toBe(2)
    expect(pos?.currentTaskDescription).toBe('Build the thing')
    expect(pos?.completionPct).toBeCloseTo(100 / 3)
  })

  it('falls back to the last COMPLETE task once nothing is RUNNING', () => {
    const plan = createPlanRecord(makePlan())
    const live = [
      { id: 't1', status: 'COMPLETE' as const },
      { id: 't2', status: 'COMPLETE' as const },
      { id: 't3', status: 'PENDING' as const },
    ]
    const pos = computePlanPosition(plan, live)
    expect(pos?.stepIndex).toBe(2)
    expect(pos?.currentTaskDescription).toBe('Build the thing')
    expect(pos?.completionPct).toBeCloseTo((2 / 3) * 100)
  })

  it('returns null for a plan with no tasks', () => {
    const plan: PlanRecord = { ...createPlanRecord(makePlan()), tasks: [] }
    expect(computePlanPosition(plan, [])).toBeNull()
  })
})

describe('nextPendingTask', () => {
  it('returns the first not-yet-COMPLETE task in plan order', () => {
    const plan = createPlanRecord(makePlan())
    plan.tasks[0].status = 'COMPLETE'
    expect(nextPendingTask(plan)?.id).toBe('t2')
  })

  it('returns null once every task is COMPLETE', () => {
    const plan = createPlanRecord(makePlan())
    for (const t of plan.tasks) t.status = 'COMPLETE'
    expect(nextPendingTask(plan)).toBeNull()
  })
})
