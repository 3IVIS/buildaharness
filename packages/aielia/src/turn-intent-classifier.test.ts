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

  receivedOptions: (ChatOptions | undefined)[] = []
  async callChatStructured(messages: ChatMessage[], _tools?: ToolDefinition[], _options?: ChatOptions): Promise<LLMStructuredResponse> {
    this.calls++
    this.receivedOptions.push(_options)
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
    isPlanQuestion: false,
    isUnderdetermined: false,
    matchedPlanTemplate: null,
    needsMultiStepPlan: false,
    statesDurableFacts: [],
    needsGrounding: false,
    ambiguity: 'none',
    userPosture: 'informational',
    pushbackOnPriorTurn: false,
    statesConstraint: false,
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
      isPlanQuestion: false,
      isUnderdetermined: false,
      matchedPlanTemplate: null,
      needsMultiStepPlan: false,
      statesDurableFacts: [],
      needsGrounding: false,
      ambiguity: 'none',
      userPosture: 'informational',
      pushbackOnPriorTurn: false,
      statesConstraint: false,
      statedConstraints: [],
    liftedConstraints: [],
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

describe('classifyTurnIntent — statesDurableFacts', () => {
  it('passes through a single stated fact', async () => {
    const llm = new StructuredOnlyLLMClient(
      response({ statesDurableFacts: [{ text: 'the user is allergic to peanuts', durable: true, confidence: 'high', category: 'health' }] }),
    )
    const result = await classifyTurnIntent("I'm allergic to peanuts.", llm, NO_PLAN)
    expect(result.statesDurableFacts).toEqual([{ text: 'the user is allergic to peanuts', durable: true, confidence: 'high', category: 'health' }])
  })

  it('passes through more than one fact stated in the same turn', async () => {
    const llm = new StructuredOnlyLLMClient(
      response({
        statesDurableFacts: [
          { text: 'the user is named Priya', durable: true, confidence: 'high', category: 'identity' },
          { text: 'the user is vegetarian', durable: true, confidence: 'high', category: 'preference' },
          { text: 'the user lives in Austin', durable: false, confidence: 'high', category: 'location' },
        ],
      }),
    )
    const result = await classifyTurnIntent("I'm Priya, I'm vegetarian, and I live in Austin.", llm, NO_PLAN)
    expect(result.statesDurableFacts).toHaveLength(3)
  })

  it('defaults to an empty array when the message states no fact', async () => {
    const llm = new StructuredOnlyLLMClient(response({ statesDurableFacts: [] }))
    const result = await classifyTurnIntent('What time is it in Tokyo?', llm, NO_PLAN)
    expect(result.statesDurableFacts).toEqual([])
  })

  it('drops a malformed entry (missing durable) rather than failing the whole classification', async () => {
    const llm = new StructuredOnlyLLMClient(
      response({
        statesDurableFacts: [
          { text: 'the user likes tea', confidence: 'high', category: 'preference' },
          { text: 'the user likes coffee', durable: false, confidence: 'medium', category: 'preference' },
        ],
      }),
    )
    const result = await classifyTurnIntent('I really like tea and coffee.', llm, NO_PLAN)
    expect(result.statesDurableFacts).toEqual([{ text: 'the user likes coffee', durable: false, confidence: 'medium', category: 'preference' }])
    expect(result.riskLevel).toBe('LOW') // rest of the classification is unaffected
  })

  it('drops an entry with empty-string text', async () => {
    const llm = new StructuredOnlyLLMClient(response({ statesDurableFacts: [{ text: '', durable: true, confidence: 'high', category: 'other' }] }))
    const result = await classifyTurnIntent('...', llm, NO_PLAN)
    expect(result.statesDurableFacts).toEqual([])
  })

  it('drops an entry with an unrecognized confidence value', async () => {
    const llm = new StructuredOnlyLLMClient(
      response({ statesDurableFacts: [{ text: 'the user is allergic to peanuts', durable: true, confidence: 'certain', category: 'health' }] }),
    )
    const result = await classifyTurnIntent("I'm allergic to peanuts.", llm, NO_PLAN)
    expect(result.statesDurableFacts).toEqual([])
  })

  it('drops an entry with an unrecognized category value', async () => {
    const llm = new StructuredOnlyLLMClient(
      response({ statesDurableFacts: [{ text: 'the user is allergic to peanuts', durable: true, confidence: 'high', category: 'allergies' }] }),
    )
    const result = await classifyTurnIntent("I'm allergic to peanuts.", llm, NO_PLAN)
    expect(result.statesDurableFacts).toEqual([])
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

describe('classifyTurnIntent — AL5a turn signals', () => {
  it('parses the five signal fields from the single classifier call', async () => {
    const llm = new StructuredOnlyLLMClient(
      response({ needsGrounding: true, ambiguity: 'high', userPosture: 'corrective', pushbackOnPriorTurn: true, statesConstraint: true }),
    )

    const result = await classifyTurnIntent('No, that is wrong. Only use metric units from now on.', llm, NO_PLAN)

    expect(result).toMatchObject({ needsGrounding: true, ambiguity: 'high', userPosture: 'corrective', pushbackOnPriorTurn: true, statesConstraint: true })
    expect(llm.calls).toBe(1)
  })

  it('degrades missing or out-of-enum signals to their fail-safe values without discarding the classification', async () => {
    const base = JSON.parse(response()) as Record<string, unknown>
    for (const k of ['needsGrounding', 'ambiguity', 'userPosture', 'pushbackOnPriorTurn', 'statesConstraint']) delete base[k]
    const llm = new StructuredOnlyLLMClient(JSON.stringify({ ...base, ambiguity: 'extreme' }))

    const result = await classifyTurnIntent('What timezone is Tokyo in?', llm, NO_PLAN)

    expect(result.riskLevel).toBe('LOW')
    expect(result).toMatchObject({ needsGrounding: true, ambiguity: 'unknown', userPosture: 'unknown', pushbackOnPriorTurn: false, statesConstraint: false })
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
    isPlanQuestion: false,
    isUnderdetermined: false,
    matchedPlanTemplate: null,
    needsMultiStepPlan: false,
    statesDurableFacts: [],
    needsGrounding: true,
    ambiguity: 'unknown',
    userPosture: 'unknown',
    pushbackOnPriorTurn: false,
    statesConstraint: false,
    statedConstraints: [],
    liftedConstraints: [],
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

describe('classifyTurnIntent — isPlanQuestion', () => {
  it('is true only when a plan is active and the model says the message only asks about it', async () => {
    const llm = new StructuredOnlyLLMClient(response({ isTrivial: false, isPlanQuestion: true }))
    expect((await classifyTurnIntent('Where does the plan stand?', llm, ACTIVE_PLAN)).isPlanQuestion).toBe(true)
  })

  it('is forced false when no plan is active, whatever the model said', async () => {
    const llm = new StructuredOnlyLLMClient(response({ isTrivial: false, isPlanQuestion: true }))
    expect((await classifyTurnIntent('Where does the plan stand?', llm, NO_PLAN)).isPlanQuestion).toBe(false)
  })

  it('is false when the message is an abandon request (abandon wins)', async () => {
    const llm = new StructuredOnlyLLMClient(response({ isTrivial: false, isAbandonRequest: true, isPlanQuestion: true }))
    const result = await classifyTurnIntent('Scrap the plan.', llm, ACTIVE_PLAN)
    expect(result.isAbandonRequest).toBe(true)
    expect(result.isPlanQuestion).toBe(false)
  })

  it('a response that omits the field is false, not a rejected classification', async () => {
    const raw = JSON.parse(response({ isTrivial: false })) as Record<string, unknown>
    delete raw.isPlanQuestion
    const result = await classifyTurnIntent('Go ahead.', new StructuredOnlyLLMClient(JSON.stringify(raw)), ACTIVE_PLAN)
    expect(result.riskLevel).toBe('LOW')
    expect(result.isPlanQuestion).toBe(false)
  })
})

describe('classifyTurnIntent — isUnderdetermined', () => {
  it('is true only when the model says the message asks why / which and nothing settles it', async () => {
    const llm = new StructuredOnlyLLMClient(response({ isTrivial: false, isUnderdetermined: true }))
    expect((await classifyTurnIntent('Export says 4,212 rows, dashboard 3,980 — why?', llm, NO_PLAN)).isUnderdetermined).toBe(true)
  })

  it('a response that omits the field, or sends a non-boolean, is false — never a rejected classification', async () => {
    const raw = JSON.parse(response({ isTrivial: false })) as Record<string, unknown>
    delete raw.isUnderdetermined
    expect((await classifyTurnIntent('Hi.', new StructuredOnlyLLMClient(JSON.stringify(raw)), NO_PLAN)).isUnderdetermined).toBe(false)
    const odd = await classifyTurnIntent('Hi.', new StructuredOnlyLLMClient(response({ isTrivial: false, isUnderdetermined: 'yes' })), NO_PLAN)
    expect(odd.riskLevel).toBe('LOW')
    expect(odd.isUnderdetermined).toBe(false)
  })

  it('a classifier failure never claims the request is underdetermined', async () => {
    const result = await classifyTurnIntent('Hi.', new ThrowingLLMClient(), NO_PLAN)
    expect(result.isUnderdetermined).toBe(false)
  })

  it('asks for the judgment: fifteen judgments in the prompt, and the field in the schema and the answer shape', async () => {
    const llm = new StructuredOnlyLLMClient(response({ isTrivial: false }))
    await classifyTurnIntent('Hi.', llm, NO_PLAN)
    const system = llm.receivedMessages[0].find((m) => m.role === 'system')?.content ?? ''
    expect(system).toContain('fifteen independent judgments')
    expect(system).toContain('15. isUnderdetermined')
    expect(system).toContain('"isUnderdetermined": boolean')
  })
})

describe('classifyTurnIntent — output a backend could not constrain to bare JSON', () => {
  it('classifies a reply wrapped in a code fence or behind stray text, instead of falling back to UNKNOWN risk', async () => {
    const body = response({ isTrivial: false })
    for (const content of ['```json\n' + body + '\n```', '<invoke name="none"></invoke>\n```json\n' + body + '\n```', 'Classifying now.\n' + body]) {
      const result = await classifyTurnIntent('Where does the plan stand?', new StructuredOnlyLLMClient(content), NO_PLAN)
      expect(result.riskLevel).toBe('LOW')
      expect(result.requiresApproval).toBe(false)
    }
  })

  it('still falls back to the fail-safe when there is no JSON at all', async () => {
    const result = await classifyTurnIntent('Where does the plan stand?', new StructuredOnlyLLMClient('I cannot classify that.'), NO_PLAN)
    expect(result.riskLevel).toBe('UNKNOWN')
    expect(result.requiresApproval).toBe(true)
  })
})

describe('statedConstraints', () => {
  const stated = async (overrides: Record<string, unknown>) =>
    (await classifyTurnIntent('Never use tabs.', new StructuredOnlyLLMClient(response(overrides)), NO_PLAN)).statedConstraints

  it('keeps trimmed, non-empty strings when the message states a constraint, capped at MAX_STATED_CONSTRAINTS', async () => {
    expect(await stated({ statesConstraint: true, statedConstraints: [' Do not use tabs ', '', 7, 'a', 'b', 'c', 'd'] })).toEqual(['Do not use tabs', 'a', 'b', 'c'])
  })
  it('is empty when statesConstraint is false, even if the model listed some', async () => {
    expect(await stated({ statesConstraint: false, statedConstraints: ['Do not use tabs'] })).toEqual([])
  })
  it('is empty when the field is missing or malformed', async () => {
    expect(await stated({ statesConstraint: true })).toEqual([])
    expect(await stated({ statesConstraint: true, statedConstraints: 'no tabs' })).toEqual([])
  })
})

describe('liftedConstraints', () => {
  const lifted = async (overrides: Record<string, unknown>, standingConstraints?: string[]) =>
    (await classifyTurnIntent('Tabs are fine now.', new StructuredOnlyLLMClient(response(overrides)), { hasActivePlan: false, standingConstraints })).liftedConstraints

  it('keeps distinct in-range 1-based positions of the standing list', async () => {
    expect(await lifted({ liftedConstraints: [2, 2, 1, 0, 3, 1.5, 'x'] }, ['a', 'b'])).toEqual([2, 1])
  })
  it('is empty when no standing constraints were shown, even if the model named one', async () => {
    expect(await lifted({ liftedConstraints: [1] })).toEqual([])
  })
  it('is empty when the field is missing or malformed', async () => {
    expect(await lifted({}, ['a'])).toEqual([])
    expect(await lifted({ liftedConstraints: 'a' }, ['a'])).toEqual([])
  })
  it('shows the numbered standing constraints to the model only when there are some', async () => {
    const seen: string[] = []
    const client = new StructuredOnlyLLMClient(response({}))
    const orig = client.callChatStructured.bind(client)
    client.callChatStructured = (async (m: Parameters<typeof orig>[0], ...rest: unknown[]) => {
      seen.push(m[0].content)
      return (orig as (...a: unknown[]) => unknown)(m, ...rest)
    }) as typeof client.callChatStructured
    await classifyTurnIntent('hi', client, { hasActivePlan: false, standingConstraints: ['Do not use tabs'] })
    await classifyTurnIntent('hi', client, { hasActivePlan: false })
    expect(seen[0]).toContain('1. Do not use tabs')
    expect(seen[1]).not.toContain('stated earlier in this conversation')
  })
})

describe('knownFactKeys', () => {
  it('lists stored keys with their text so the model can reuse one, and only when there are some', async () => {
    const seen: string[] = []
    const client = new StructuredOnlyLLMClient(response({}))
    const orig = client.callChatStructured.bind(client)
    client.callChatStructured = (async (m: Parameters<typeof orig>[0], ...rest: unknown[]) => {
      seen.push(m[0].content)
      return (orig as (...a: unknown[]) => unknown)(m, ...rest)
    }) as typeof client.callChatStructured
    await classifyTurnIntent('I moved to Oslo', client, { hasActivePlan: false, knownFactKeys: [{ key: 'home_city', text: 'the user lives in Austin' }] })
    await classifyTurnIntent('hi', client, { hasActivePlan: false })
    expect(seen[0]).toContain('- home_city: the user lives in Austin')
    expect(seen[0]).toContain('reuse that exact key')
    expect(seen[1]).not.toContain('Facts already stored')
  })
})

describe('lastingConstraints', () => {
  const lasting = async (overrides: Record<string, unknown>) =>
    (await classifyTurnIntent('x', new StructuredOnlyLLMClient(response({ statesConstraint: true, statedConstraints: ['a', 'b'], ...overrides })), NO_PLAN)).lastingConstraints

  it('keeps distinct in-range 1-based positions of statedConstraints', async () => {
    expect(await lasting({ lastingConstraints: [2, 2, 0, 3, 'x'] })).toEqual([2])
    expect(await lasting({ lastingConstraints: [] })).toEqual([])
  })
  it('is undefined (not []) when the model omitted the field or it is malformed', async () => {
    expect(await lasting({})).toBeUndefined()
    expect(await lasting({ lastingConstraints: 'a' })).toBeUndefined()
  })
  it('is undefined when the message states no constraint', async () => {
    expect(await lasting({ statesConstraint: false, lastingConstraints: [1] })).toBeUndefined()
  })
})

describe('continuesPlan', () => {
  const run = async (overrides: Record<string, unknown>, hasActivePlan: boolean) =>
    (await classifyTurnIntent('x', new StructuredOnlyLLMClient(response(overrides)), { hasActivePlan })).continuesPlan
  it('is the model\'s boolean when a plan is active', async () => {
    expect(await run({ continuesPlan: true }, true)).toBe(true)
    expect(await run({ continuesPlan: false }, true)).toBe(false)
  })
  it('is undefined when no plan is active, on abandon, or when the model omitted/garbled it', async () => {
    expect(await run({ continuesPlan: false }, false)).toBeUndefined()
    expect(await run({ continuesPlan: false, isAbandonRequest: true }, true)).toBeUndefined()
    expect(await run({}, true)).toBeUndefined()
    expect(await run({ continuesPlan: 'no' }, true)).toBeUndefined()
  })
})

describe('classifyTurnIntent: write-gate judgements are required', () => {
  it('requires containsSecret and looksLikeInstruction on every stated fact so the M2 gate never fails closed on an omission', async () => {
    const llm = new StructuredOnlyLLMClient('{}')
    await classifyTurnIntent('msg', llm, NO_PLAN)
    const schema = llm.receivedOptions[0]?.structuredOutput?.schema as { properties: { statesDurableFacts: { items: { required: string[] } } } }
    expect(schema.properties.statesDurableFacts.items.required).toEqual(expect.arrayContaining(['containsSecret', 'looksLikeInstruction']))
    expect(JSON.stringify(llm.receivedMessages[0])).toContain('ALWAYS include it')
  })
})

describe('classifyTurnIntent — changing attributes under AUDIT_MEMORY_BUDGETED_RENDER (M1)', () => {
  const systemFor = async (flag: string | undefined): Promise<string> => {
    const prev = process.env.AUDIT_MEMORY_BUDGETED_RENDER
    if (flag === undefined) delete process.env.AUDIT_MEMORY_BUDGETED_RENDER
    else process.env.AUDIT_MEMORY_BUDGETED_RENDER = flag
    try {
      const llm = new StructuredOnlyLLMClient(response({ isTrivial: false }))
      await classifyTurnIntent('Hi.', llm, NO_PLAN)
      return llm.receivedMessages[0].find((m) => m.role === 'system')?.content ?? ''
    } finally {
      if (prev === undefined) delete process.env.AUDIT_MEMORY_BUDGETED_RENDER
      else process.env.AUDIT_MEMORY_BUDGETED_RENDER = prev
    }
  }

  it('flag =0 (legacy): the base wording is unchanged (a changing attribute is not durable)', async () => {
    const system = await systemFor('0')
    expect(system).toContain('false for something expected to change (current location, current job')
    expect(system).not.toContain('team size) that you give a `key` is also `durable: true`')
  })

  it('default (env unset) is ON: the keyed wording is used', async () => {
    const system = await systemFor(undefined)
    expect(system).not.toContain('false for something expected to change')
    expect(system).toContain('team size) that you give a `key` is also `durable: true`')
  })

  it('flag on: a keyed changing attribute (location, job, team size) is durable so supersession can replace it', async () => {
    const system = await systemFor('1')
    expect(system).not.toContain('false for something expected to change')
    expect(system).toContain('team size) that you give a `key` is also `durable: true`')
  })
})
