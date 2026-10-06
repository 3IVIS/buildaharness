import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor, cleanup } from '@testing-library/react'

/**
 * P4 of plans/plan_visualization_plan.html — the planGraphMode flag at the App level. The flag is read once into a
 * module-level constant when App.tsx is first evaluated (browser-config.ts), so each case stubs the env var, resets
 * modules and imports App fresh (same pattern as App.goal-graph-steering.test.tsx). Flag OFF must leave no trace: no
 * header button and no panel, even though a persisted plan exists and getPlanGraph would return it.
 */

const PLAN = {
  templateName: null,
  successCriteria: 'ship it',
  rationale: 'test',
  mode: 'active',
  executingOnPlan: false,
  tasks: [
    { id: 'T1', description: 'first', depends_on: [], status: 'COMPLETE' },
    { id: 'T2', description: 'second', depends_on: ['T1'], status: 'PENDING' },
  ],
}

type PlanGraphFn = () => Promise<unknown>

function fakeAssistant(getPlanGraph: PlanGraphFn) {
  return {
    turn: vi.fn(async () => ({ status: 'ok', reply: 'ok', riskLevel: 'LOW', usage: { inputTokens: 1, outputTokens: 1 } })),
    getTranscript: vi.fn(async () => []),
    getPlanState: vi.fn(async () => null),
    getPlanGraph,
    clearSession: vi.fn(async () => {}),
    undoLastTurn: vi.fn(async () => ({ undone: false })),
    getMemorySummary: vi.fn(async () => ({ facts: [], reminders: [], pending: [], experience: { strategyWeights: {}, decompositions: [], recoverySequences: [] } })),
    getLastMemoryInjection: vi.fn(() => undefined),
    getMemoryStatus: vi.fn(async () => ({ mode: 'staged', off: false, budgetedRender: false, budgetChars: 4000, storeChars: 0, liveFacts: 0, pending: 0, flaggedPending: 0, retired: 0, auditEnabled: false, auditEntries: 0 })),
    searchTranscript: vi.fn(async () => []),
  }
}

async function mountApp(getPlanGraph: PlanGraphFn): Promise<void> {
  vi.doMock('@buildaharness/aielia', async () => {
    const actual = await vi.importActual<typeof import('@buildaharness/aielia')>('@buildaharness/aielia')
    return { ...actual, PersonalAssistant: { create: vi.fn(async () => fakeAssistant(getPlanGraph)) } }
  })
  const { App } = await import('./App')
  render(<App />)
}

describe('App: planGraphMode flag', () => {
  beforeEach(() => {
    localStorage.setItem('buildaharness.personal-assistant.config', JSON.stringify({ llmBackend: 'proxy' }))
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('no network in tests')))
    vi.resetModules()
  })
  afterEach(() => {
    cleanup()
    localStorage.clear()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
    vi.resetModules()
  })

  it('flag off (the default): no Plan graph button, no panel, and the plan is never queried', async () => {
    const getPlanGraph = vi.fn(async () => PLAN)
    await mountApp(getPlanGraph)
    await screen.findByPlaceholderText('Message Aielia…')
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Plan graph' })).toBeNull())
    expect(screen.queryByTestId('plan-viz-panel')).toBeNull()
    expect(getPlanGraph).not.toHaveBeenCalled()
  })

  it('flag on with a persisted plan: the Plan graph button appears', async () => {
    vi.stubEnv('VITE_ASSISTANT_PLAN_GRAPH', 'enabled')
    vi.resetModules()
    const getPlanGraph = vi.fn(async () => PLAN)
    await mountApp(getPlanGraph)
    expect(await screen.findByRole('button', { name: 'Plan graph' })).toBeInTheDocument()
    expect(getPlanGraph).toHaveBeenCalled()
  })

  it('flag on but no plan yet: no button', async () => {
    vi.stubEnv('VITE_ASSISTANT_PLAN_GRAPH', 'enabled')
    vi.resetModules()
    const getPlanGraph = vi.fn(async () => null)
    await mountApp(getPlanGraph)
    await screen.findByPlaceholderText('Message Aielia…')
    await waitFor(() => expect(getPlanGraph).toHaveBeenCalled())
    expect(screen.queryByRole('button', { name: 'Plan graph' })).toBeNull()
  })
})
