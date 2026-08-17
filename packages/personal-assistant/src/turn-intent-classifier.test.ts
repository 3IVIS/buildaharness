import { describe, it, expect } from 'vitest'
import type { ChatMessage, ChatOptions, ILLMClient, LLMStructuredResponse, ToolDefinition } from '@buildaharness/runtime'
import { classifyTurnIntent, type TurnIntentContext } from './turn-intent-classifier.js'

class StructuredOnlyLLMClient implements ILLMClient {
  calls = 0
  receivedMessages: ChatMessage[][] = []
  constructor(private readonly content: string) {}

  async *callChat(): AsyncIterable<string> {
    yield ''
  }

  async callChatSync(): Promise<string> {
    return ''
  }

  async callChatStructured(messages: ChatMessage[], _tools?: ToolDefinition[], _options?: ChatOptions): Promise<LLMStructuredResponse> {
    this.calls++
    this.receivedMessages.push(messages)
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

const NO_PLAN: TurnIntentContext = { hasActivePlan: false }
const ACTIVE_PLAN: TurnIntentContext = { hasActivePlan: true }

/** A fully-formed, valid response — individual tests override only the fields they care about. */
function response(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    riskLevel: 'LOW',
    riskReason: 'Conversational request with no detected side effects.',
    isTrivial: true,
    decomposedTasks: [],
    isReminderRequest: false,
    isBulkReminderRequest: false,
    isAbandonRequest: false,
    matchedPlanTemplate: null,
    statesDurableFact: null,
    ...overrides,
  })
}

describe('classifyTurnIntent — happy path field derivation', () => {
  it('adopts the LLM verdict for an ordinary LOW-risk, trivial message', async () => {
    const llm = new StructuredOnlyLLMClient(response())

    const result = await classifyTurnIntent('What timezone is Tokyo in?', llm, NO_PLAN)

    expect(result).toEqual({
      riskLevel: 'LOW',
      riskReason: 'Conversational request with no detected side effects.',
      requiresApproval: false,
      isTrivial: true,
      decomposedTasks: null,
      isReminderRequest: false,
      isBulkReminderRequest: false,
      isAbandonRequest: false,
      matchedPlanTemplate: null,
      statesDurableFact: null,
    })
    expect(llm.calls).toBe(1)
  })

  it('sends the raw message as the user turn, with plan-active context folded into the system prompt instead of prefixing it', async () => {
    const llm = new StructuredOnlyLLMClient(response())

    await classifyTurnIntent('What timezone is Tokyo in?', llm, NO_PLAN)

    const [messages] = llm.receivedMessages
    expect(messages.find((m) => m.role === 'user')?.content).toBe('What timezone is Tokyo in?')
    expect(messages.find((m) => m.role === 'system')?.content).toContain('No plan is currently active')
  })

  it('mentions an active plan in the system prompt when one exists', async () => {
    const llm = new StructuredOnlyLLMClient(response())

    await classifyTurnIntent('Give me an update.', llm, ACTIVE_PLAN)

    const [messages] = llm.receivedMessages
    expect(messages.find((m) => m.role === 'system')?.content).toContain('An active multi-step plan is currently running')
  })

  it('sets requiresApproval for HIGH risk', async () => {
    const llm = new StructuredOnlyLLMClient(response({ riskLevel: 'HIGH', riskReason: 'sends a message on the user\'s behalf', isTrivial: false }))

    const result = await classifyTurnIntent('Please send an email to my boss telling him I quit.', llm, NO_PLAN)

    expect(result.riskLevel).toBe('HIGH')
    expect(result.requiresApproval).toBe(true)
  })

  it('sets requiresApproval for a bulk reminder request even though risk is only MEDIUM', async () => {
    const llm = new StructuredOnlyLLMClient(
      response({ riskLevel: 'MEDIUM', riskReason: 'creates several reminders', isTrivial: false, isReminderRequest: true, isBulkReminderRequest: true }),
    )

    const result = await classifyTurnIntent('Remind me to call the bank, email the landlord, and pick up dry cleaning.', llm, NO_PLAN)

    expect(result.riskLevel).toBe('MEDIUM')
    expect(result.requiresApproval).toBe(true)
    expect(result.isBulkReminderRequest).toBe(true)
  })

  it('does not require approval for an ordinary single-item reminder request', async () => {
    const llm = new StructuredOnlyLLMClient(
      response({ riskLevel: 'MEDIUM', riskReason: 'creates a calendar or reminder entry', isTrivial: false, isReminderRequest: true }),
    )

    const result = await classifyTurnIntent('Remind me to call the dentist tomorrow.', llm, NO_PLAN)

    expect(result.requiresApproval).toBe(false)
    expect(result.isReminderRequest).toBe(true)
    expect(result.isBulkReminderRequest).toBe(false)
  })

  it('forces isBulkReminderRequest false when the model says bulk but not a reminder request at all (internally inconsistent output)', async () => {
    const llm = new StructuredOnlyLLMClient(response({ isReminderRequest: false, isBulkReminderRequest: true }))

    const result = await classifyTurnIntent('anything', llm, NO_PLAN)

    expect(result.isBulkReminderRequest).toBe(false)
    expect(result.requiresApproval).toBe(false)
  })

  it('forces isTrivial false whenever riskLevel is not LOW, even if the model says trivial', async () => {
    const llm = new StructuredOnlyLLMClient(response({ riskLevel: 'MEDIUM', isTrivial: true }))

    const result = await classifyTurnIntent('anything', llm, NO_PLAN)

    expect(result.isTrivial).toBe(false)
  })

  it('collapses an empty or single-item decomposedTasks array to null (not decomposed)', async () => {
    const llmEmpty = new StructuredOnlyLLMClient(response({ decomposedTasks: [] }))
    const llmOne = new StructuredOnlyLLMClient(
      response({ decomposedTasks: [{ id: 'a', description: 'do the one thing', depends_on: [], riskLevel: 'LOW' }] }),
    )

    expect((await classifyTurnIntent('anything', llmEmpty, NO_PLAN)).decomposedTasks).toBeNull()
    expect((await classifyTurnIntent('anything', llmOne, NO_PLAN)).decomposedTasks).toBeNull()
  })

  it('keeps a 2+ item decomposedTasks array, filtering out any malformed entries', async () => {
    const llm = new StructuredOnlyLLMClient(
      response({
        decomposedTasks: [
          { id: 'step-1', description: 'Book the flight', depends_on: [], riskLevel: 'MEDIUM' },
          { id: 'step-2', description: 'Book the hotel', depends_on: ['step-1'], riskLevel: 'MEDIUM' },
          { id: 'step-3', description: 123, depends_on: [], riskLevel: 'LOW' }, // malformed — description not a string
          { id: 'step-4', description: 'Missing risk level entirely', depends_on: [] }, // malformed — no riskLevel
          { id: 'step-5', description: 'Invalid risk level', depends_on: [], riskLevel: 'EXTREME' }, // malformed — not one of LOW/MEDIUM/HIGH
        ],
      }),
    )

    const result = await classifyTurnIntent('First book my flight, then book a hotel.', llm, NO_PLAN)

    expect(result.decomposedTasks).toEqual([
      { id: 'step-1', description: 'Book the flight', depends_on: [], riskLevel: 'MEDIUM' },
      { id: 'step-2', description: 'Book the hotel', depends_on: ['step-1'], riskLevel: 'MEDIUM' },
    ])
  })

  it('drops a dangling depends_on reference to a task id that was never actually returned, instead of passing a broken graph through', async () => {
    // Shape mirrors the live failure (convB, batch 93): task "3" depends on task "2", but "2"
    // was never emitted. Left unfiltered, this would reach HarnessRuntime.run()'s initialTasks
    // and throw InvalidTaskGraphError ("Task \"3\" depends on unknown task \"2\"") deep inside
    // the harness, crashing the whole turn after the draft reply had already been shown.
    const llm = new StructuredOnlyLLMClient(
      response({
        decomposedTasks: [
          { id: '1', description: "today's date: look it up", depends_on: [], riskLevel: 'LOW' },
          { id: '3', description: "'quick': give a one-word synonym", depends_on: ['2'], riskLevel: 'LOW' },
        ],
      }),
    )

    const result = await classifyTurnIntent('First look up the date, then give a synonym for quick.', llm, NO_PLAN)

    expect(result.decomposedTasks).toEqual([
      { id: '1', description: "today's date: look it up", depends_on: [], riskLevel: 'LOW' },
      { id: '3', description: "'quick': give a one-word synonym", depends_on: [], riskLevel: 'LOW' },
    ])
  })

  it('drops a depends_on reference left dangling by isDecomposedTaskSpec filtering out its malformed target', async () => {
    // step-2 legitimately depends on step-1, but step-1 itself is malformed (no riskLevel) and
    // gets filtered out by isDecomposedTaskSpec — leaving step-2's depends_on pointing at an id
    // that no longer exists in the returned array at all.
    const llm = new StructuredOnlyLLMClient(
      response({
        decomposedTasks: [
          { id: 'step-1', description: 'Book the flight', depends_on: [] }, // malformed — no riskLevel, gets filtered
          { id: 'step-2', description: 'Book the hotel', depends_on: ['step-1'], riskLevel: 'MEDIUM' },
          { id: 'step-3', description: 'Rent a car', depends_on: ['step-2'], riskLevel: 'MEDIUM' },
        ],
      }),
    )

    const result = await classifyTurnIntent('First book my flight, then a hotel, then a car.', llm, NO_PLAN)

    expect(result.decomposedTasks).toEqual([
      { id: 'step-2', description: 'Book the hotel', depends_on: [], riskLevel: 'MEDIUM' },
      { id: 'step-3', description: 'Rent a car', depends_on: ['step-2'], riskLevel: 'MEDIUM' },
    ])
  })

  it('gives each decomposed task its own riskLevel, not a broadcast of the overall turn-level riskLevel', async () => {
    // A compound request mixing a LOW step and a HIGH step — the point of per-task riskLevel is
    // that these don't have to match each other or the overall classification.riskLevel.
    const llm = new StructuredOnlyLLMClient(
      response({
        riskLevel: 'HIGH',
        decomposedTasks: [
          { id: 'step-1', description: 'the email: reply to the landlord', depends_on: [], riskLevel: 'LOW' },
          { id: 'step-2', description: 'the drafts folder: delete it', depends_on: ['step-1'], riskLevel: 'HIGH' },
        ],
      }),
    )

    const result = await classifyTurnIntent('Reply to the landlord, then delete the drafts folder.', llm, NO_PLAN)

    expect(result.decomposedTasks).toEqual([
      { id: 'step-1', description: 'the email: reply to the landlord', depends_on: [], riskLevel: 'LOW' },
      { id: 'step-2', description: 'the drafts folder: delete it', depends_on: ['step-1'], riskLevel: 'HIGH' },
    ])
  })
})

describe('classifyTurnIntent — statesDurableFact', () => {
  it('passes through a stated fact', async () => {
    const llm = new StructuredOnlyLLMClient(
      response({ statesDurableFact: { text: 'the user is allergic to peanuts', durable: true } }),
    )
    const result = await classifyTurnIntent("I'm allergic to peanuts.", llm, NO_PLAN)
    expect(result.statesDurableFact).toEqual({ text: 'the user is allergic to peanuts', durable: true })
  })

  it('defaults to null when the message states no fact', async () => {
    const llm = new StructuredOnlyLLMClient(response({ statesDurableFact: null }))
    const result = await classifyTurnIntent('What time is it in Tokyo?', llm, NO_PLAN)
    expect(result.statesDurableFact).toBeNull()
  })

  it('treats a malformed statesDurableFact (missing durable) as null rather than failing the whole classification', async () => {
    const llm = new StructuredOnlyLLMClient(response({ statesDurableFact: { text: 'the user likes tea' } }))
    const result = await classifyTurnIntent('I really like tea.', llm, NO_PLAN)
    expect(result.statesDurableFact).toBeNull()
    expect(result.riskLevel).toBe('LOW') // rest of the classification is unaffected
  })

  it('treats an empty-string text as null', async () => {
    const llm = new StructuredOnlyLLMClient(response({ statesDurableFact: { text: '', durable: true } }))
    const result = await classifyTurnIntent('...', llm, NO_PLAN)
    expect(result.statesDurableFact).toBeNull()
  })
})

describe('classifyTurnIntent — context gating', () => {
  it('forces isAbandonRequest false when no plan is active, even if the model says true', async () => {
    const llm = new StructuredOnlyLLMClient(response({ isAbandonRequest: true }))

    const result = await classifyTurnIntent('Forget this plan.', llm, NO_PLAN)

    expect(result.isAbandonRequest).toBe(false)
  })

  it('respects isAbandonRequest when a plan is active', async () => {
    const llm = new StructuredOnlyLLMClient(response({ isAbandonRequest: true }))

    const result = await classifyTurnIntent('Forget this plan.', llm, ACTIVE_PLAN)

    expect(result.isAbandonRequest).toBe(true)
  })

  it('forces matchedPlanTemplate null when a plan is already active, even if the model names one', async () => {
    const llm = new StructuredOnlyLLMClient(response({ matchedPlanTemplate: 'project_planning' }))

    const result = await classifyTurnIntent('Plan and launch the redesign project.', llm, ACTIVE_PLAN)

    expect(result.matchedPlanTemplate).toBeNull()
  })

  it('accepts a matchedPlanTemplate that is one of the known template names when no plan is active', async () => {
    const llm = new StructuredOnlyLLMClient(response({ matchedPlanTemplate: 'trip_planning' }))

    const result = await classifyTurnIntent('Plan a trip to Kyoto next month.', llm, NO_PLAN)

    expect(result.matchedPlanTemplate).toBe('trip_planning')
  })

  it('rejects a matchedPlanTemplate name that is not one of the known templates', async () => {
    const llm = new StructuredOnlyLLMClient(response({ matchedPlanTemplate: 'not_a_real_template' }))

    const result = await classifyTurnIntent('Plan something.', llm, NO_PLAN)

    expect(result.matchedPlanTemplate).toBeNull()
  })
})

describe('classifyTurnIntent — fail-safe fallback', () => {
  const FAIL_SAFE = {
    riskLevel: 'UNKNOWN',
    riskReason: 'Risk could not be determined — classification failed or returned an unusable result.',
    requiresApproval: true,
    isTrivial: false,
    decomposedTasks: null,
    isReminderRequest: false,
    isBulkReminderRequest: false,
    isAbandonRequest: false,
    matchedPlanTemplate: null,
    statesDurableFact: null,
  }

  it('falls back on malformed JSON instead of throwing, folding the JSON.parse error into riskReason (same classifyError path as a genuine LLM-call throw, since JSON.parse throwing inside parseTurnIntent is likewise a real caught error, not a semantic-validation null-return)', async () => {
    const llm = new StructuredOnlyLLMClient('not json at all')

    const result = await classifyTurnIntent('anything', llm, NO_PLAN)

    expect(result.riskReason).toMatch(/^Risk could not be determined.*Something went wrong.*not valid JSON/)
    expect(result).toEqual({ ...FAIL_SAFE, riskReason: result.riskReason })
  })

  it('falls back on an unrecognized riskLevel value', async () => {
    const llm = new StructuredOnlyLLMClient(response({ riskLevel: 'EXTREME' }))

    expect(await classifyTurnIntent('anything', llm, NO_PLAN)).toEqual(FAIL_SAFE)
  })

  it('falls back when a required boolean field is missing', async () => {
    const llm = new StructuredOnlyLLMClient(JSON.stringify({ riskLevel: 'LOW', riskReason: 'ok' }))

    expect(await classifyTurnIntent('anything', llm, NO_PLAN)).toEqual(FAIL_SAFE)
  })

  it('falls back when matchedPlanTemplate is neither a string nor null', async () => {
    const llm = new StructuredOnlyLLMClient(response({ matchedPlanTemplate: 42 }))

    expect(await classifyTurnIntent('anything', llm, NO_PLAN)).toEqual(FAIL_SAFE)
  })

  it('falls back to a generic reason when riskReason is missing or blank, without failing the whole classification', async () => {
    const llm = new StructuredOnlyLLMClient(response({ riskReason: '' }))

    const result = await classifyTurnIntent('anything', llm, NO_PLAN)

    expect(result.riskReason).toBe('LLM classified this as LOW risk.')
  })

  it('falls back when the LLM call itself throws, folding the classified error into riskReason instead of discarding it (conv03 batch finding: a broken CLAUDE_PATH silently fell back to the generic reason on every turn, never surfacing error-classifier.ts\'s actionable ENOENT message)', async () => {
    const llm = new ThrowingLLMClient()

    const result = await classifyTurnIntent('anything', llm, NO_PLAN)

    expect(result).toEqual({
      ...FAIL_SAFE,
      riskReason: `${FAIL_SAFE.riskReason} (Something went wrong (proxy unreachable). Try again in a moment.)`,
    })
  })
})

// A representative slice of risk-classifier.ts's 45 "found via live testing" English regressions —
// full parity coverage for classifyRisk's own keyword patterns already lives in
// risk-classifier.test.ts (unchanged, still exercised directly at the per-task-risk call site in
// assistant.ts). These confirm the same sentences flow correctly end-to-end through
// classifyTurnIntent's parsing once a real model (stood in for here by a scripted response
// matching what classifyRisk itself would say) returns the expected verdict — plumbing parity,
// not a second copy of the regex corpus. Real multilingual/accuracy validation against these and
// new non-English cases is scripts/eval-turn-intent.ts's job (Phase 3b), run against a real LLM.
describe('classifyTurnIntent — representative English regression parity', () => {
  const cases: { message: string; response: string }[] = [
    { message: 'My coffee order is an oat milk cortado.', response: response({ riskLevel: 'LOW', riskReason: 'Conversational request with no detected side effects.' }) },
    { message: 'Please order me a pizza for dinner.', response: response({ riskLevel: 'HIGH', riskReason: 'spends money or moves funds', isTrivial: false }) },
    { message: 'Did that actually send a real email just now?', response: response({ riskLevel: 'LOW' }) },
    { message: 'Please forward our proposal to the client before end of day.', response: response({ riskLevel: 'HIGH', riskReason: "sends a message on the user's behalf", isTrivial: false }) },
    { message: 'Remove.bg is a great tool for removing backgrounds from photos.', response: response({ riskLevel: 'LOW' }) },
    { message: 'Wire fraud cases have increased significantly this year.', response: response({ riskLevel: 'LOW' }) },
    {
      message: 'Set reminders for calling the bank, emailing the landlord, and picking up dry cleaning',
      response: response({ riskLevel: 'MEDIUM', riskReason: 'creates a calendar or reminder entry', isTrivial: false, isReminderRequest: true, isBulkReminderRequest: true }),
    },
    { message: 'I already deleted the old vacation photos last year.', response: response({ riskLevel: 'LOW' }) },
    { message: 'My roommate warned that she plans to delete our shared documents folder.', response: response({ riskLevel: 'LOW' }) },
  ]

  for (const { message, response: scriptedResponse } of cases) {
    it(`classifies: "${message}"`, async () => {
      const llm = new StructuredOnlyLLMClient(scriptedResponse)
      const result = await classifyTurnIntent(message, llm, NO_PLAN)
      expect(result.riskLevel).toBe((JSON.parse(scriptedResponse) as { riskLevel: string }).riskLevel)
    })
  }
})
