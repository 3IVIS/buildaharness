import type { ILLMClient, TokenUsage, MemoryAdapter } from '@buildaharness/runtime'
import { makeQuestionsBatch, validateAskResponse, type AskQuestion, type AskResponse } from '@buildaharness/harness'
import { testAny, getPlanModeCancelPatterns } from './lexical/patterns.js'
import { draftPlanRevision } from './plan-drafting.js'
import { loadTemplate } from './plan-templates/index.js'
import type { PlanRecord, PlanTaskRecord } from './plan-store.js'
import type { AssistantSession } from './assistant-session.js'
import type { PlanService } from './plan-service.js'
import type { PlanApprovalService } from './plan-approval-service.js'
import type { AssistantTurnResult } from './assistant-types.js'
import type { TraceEvent } from './trace-events.js'
import type { AgentLoop } from './agent-loop.js'
import { verifyPlanDraft } from './plan-verification.js'
import { formatAskResponse } from './ask-response-format.js'

/**
 * `{ fallThrough: true }` only ever comes from a *fresh, auto-triggered* entry (`seed` set —
 * assistant.ts's P3 auto-trigger, never PersonalAssistant.enterPlanMode's manual/test entry point)
 * whose very first drafting call failed (malformed/insufficient LLM output, or a thrown error —
 * draftPlanRevision's own try/catch already normalizes both to `null`) — this phase's Validation
 * requires falling back to *not entering plan mode at all* rather than staging a broken draft or
 * getting the user stuck in a "couldn't update the draft" loop they never asked to enter (same
 * "null means fall through" convention `buildPlanFromTemplate` already used). Mirrors
 * `PlanApprovalOutcome`'s exact shape/discipline. A manual `enterPlanMode` entry with no `seed`
 * keeps today's pre-P3 behavior on a failed first draft: stay in drafting, ask the user to
 * rephrase — that path is an explicit, already-active choice to draft, not a guess the system
 * made on the user's behalf.
 */
export type PlanDraftOutcome = { fallThrough: true } | AssistantTurnResult

const { cancelVerbs, planningReferenceMarker } = getPlanModeCancelPatterns()

/** Both an explicit cancel-shaped verb AND a reference to planning/drafting must match — same both-markers-required discipline plan-store.ts's matchTaskCancelAttempt uses, so an unrelated "cancel my flight" said mid-draft doesn't spuriously exit plan mode. */
function isCancelPlanningPhrase(message: string): boolean {
  return testAny(cancelVerbs, message) && testAny(planningReferenceMarker, message)
}

/**
 * The free (no LLM call) starting point for a template-seeded draft: the template's own skeleton,
 * mapped onto `PlanTaskRecord`'s shape (title becomes the initial description; risk_level carries
 * over) exactly the way `createPlanRecord` always has. `draftPlanRevision`'s system prompt already
 * treats its `currentTasks` argument as freely revisable (add/remove/reorder/reword), so feeding
 * it this skeleton — rather than a separate strict `buildPlanFromTemplate` personalization call —
 * is what gives P3's seeded draft the freedom its Scope calls for, in the one call `draftTurn`
 * already makes for a fresh entry, not two.
 */
function seedFromTemplate(templateName: string): { tasks: PlanTaskRecord[]; successCriteria: string } {
  const template = loadTemplate(templateName)
  const tasks: PlanTaskRecord[] = template.tasks.map((t) => ({
    id: t.id,
    description: t.title,
    depends_on: t.depends_on,
    status: 'PENDING',
    riskLevel: t.risk_level,
  }))
  return { tasks, successCriteria: template.success_criteria }
}

/**
 * P3 of the internal plan — how `assistant.ts`'s auto-trigger tells
 * `draftTurn` what to seed a *fresh* draft with (ignored on every later revision of an
 * already-drafting plan). `templateName` set means a template matched — the draft starts from
 * that template's own skeleton (today's personalization behavior, reused, not discarded — see
 * `buildPlanFromTemplate`'s doc comment — except the drafting call itself, not a separate
 * personalization call, does the adapting, so it's free to add/remove/split/reorder relative to
 * the skeleton rather than preserving it 1:1). `grounded: true` (only meaningful when
 * `templateName` is null) means ground the from-scratch draft in real repo state via a bounded
 * read_file/list_directory walk before drafting.
 */
export interface PlanDraftSeed {
  templateName: string | null
  grounded: boolean
}

/**
 * P8 of the internal plan — everything `resolvePendingAsk` needs to fold
 * the user's answer back into the *next* drafting call. Deliberately thinner than
 * AskClarificationPendingState (Q2): there is no harness run to resume, so no
 * classification/activePlan/facts/draftReply to carry — the running `PlanRecord` itself (already
 * `mode: 'drafting'`) is the only other state that matters, and `draftTurn` already reloads it by
 * `sessionId`.
 */
interface PlanAskPendingState {
  questions: AskQuestion[]
}

/**
 * Owns plan mode's P1 exclusive drafting loop: while `AssistantSession.getPlanModeState(sessionId)`
 * is `active`, `assistant.ts`'s runTurn routes every message here instead of TurnInterpreter's
 * normal classify/tool-loop pipeline (INV-30 — no tool other than this call itself executes for
 * that session while drafting is active). Two designed exits: an explicit cancel/abort phrase
 * (handled entirely here), and P2's approval response once a draft is staged for
 * `awaiting_approval` (handed off to `PlanApprovalService.stageAndRespond` below the moment a
 * revision's `readyForApproval` is true — resolved via `turn(message, { planApprovalId,
 * planDecision })`, checked earlier in `assistant.ts`'s runTurn than this drafting path at all).
 *
 * The drafting call itself (plan-drafting.ts's draftPlanRevision) has no tool access of its own —
 * P3 grounds a from-scratch draft by running a separate, bounded read_file/list_directory
 * investigation walk first (see the `seed?.grounded` branch in `draftTurn` below) and feeding its
 * findings in as extra context, rather than giving the drafting call itself live tool-calling.
 * P3 also wired the automatic judgment-based trigger this class was previously waiting on:
 * `assistant.ts`'s runTurn now calls `session.enterPlanMode` and routes into `draftTurn` (with a
 * `PlanDraftSeed`) the moment `classifyTurnIntent` reports `matchedPlanTemplate !== null ||
 * needsMultiStepPlan` and no plan is already active — `PersonalAssistant.enterPlanMode` remains
 * available as a direct entry point too (tests, a future `/plan` command), unchanged.
 */
export class PlanDraftingService {
  constructor(
    private readonly planService: PlanService,
    private readonly session: AssistantSession,
    private readonly llmClient: ILLMClient,
    private readonly model: () => string | undefined,
    private readonly planApproval: PlanApprovalService,
    private readonly onTrace: ((event: TraceEvent) => void) | undefined,
    // Optional: only needed for P3's grounded from-scratch seeding (below). Undefined in any
    // caller that doesn't wire it (e.g. a unit test exercising template-seeded/manual entry
    // only) simply skips grounding — same "absent means skip" convention as groundingContext
    // itself.
    private readonly agentLoop?: Pick<AgentLoop, 'runSupervisorInvestigation'>,
    // P8 — only needed to stage/resolve a nested ask-question exchange mid-draft (below).
    // Undefined in any caller that never exercises P8 (e.g. an older unit test) simply means
    // draftPlanRevision can still set `question` but this service has nowhere to stage it —
    // callers that want P8 must supply this, same discipline agentLoop already follows above.
    private readonly memory?: MemoryAdapter,
  ) {}

  private planAskPendingKey(id: string): string {
    return `plan-ask-pending:${id}`
  }

  /** Peeked by `assistant.ts`'s runTurn before it decides whether a `pendingClarificationId` belongs to this nested-ask side channel (P8) or AskClarificationService's harness-resume path (Q2) — the two staging stores are otherwise independent, so an opaque ID has no other way to say which one it came from. */
  async isPendingAsk(id: string): Promise<boolean> {
    if (!this.memory) return false
    return (await this.memory.get(this.planAskPendingKey(id))) !== undefined
  }

  /**
   * Resolves a nested plan-drafting ask by ID (P8) — the drafting counterpart to
   * AskClarificationService.resolvePendingClarification, but folds the answer into the *next
   * drafting revision call* instead of resuming a paused harness run (there is none mid-draft).
   * Fail-closed (Protected Invariants) exactly like Q2: no answer, or one that doesn't validate
   * against exactly the staged questions (INV-28), leaves the turn in `needs_clarification`
   * rather than silently proceeding or discarding the batch.
   */
  async resolvePendingAsk(
    sessionId: string,
    transcriptKey: string,
    pendingAskId: string,
    response: AskResponse | undefined,
    onUsage: (usage: TokenUsage) => void,
  ): Promise<AssistantTurnResult> {
    const staged = this.memory ? ((await this.memory.get(this.planAskPendingKey(pendingAskId))) as PlanAskPendingState | undefined) : undefined
    if (!staged) {
      return { status: 'ok', reply: 'That question is no longer pending — nothing to resolve.' }
    }
    if (!response) {
      return { status: 'needs_clarification', reply: null, reason: 'No answer was provided.', pendingClarificationId: pendingAskId, questions: staged.questions, riskLevel: 'LOW' }
    }
    try {
      validateAskResponse(staged.questions, response)
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err)
      return { status: 'needs_clarification', reply: null, reason, pendingClarificationId: pendingAskId, questions: staged.questions, riskLevel: 'LOW' }
    }

    await this.memory!.delete(this.planAskPendingKey(pendingAskId))
    const answerText = formatAskResponse(staged.questions, response)
    // No `seed` — draftTurn reloads the running `PlanRecord` (still `mode: 'drafting'`, exactly
    // as it was when the question was staged) and revises it with the answer as `userMessage`,
    // same "fold the answer into the next call" pattern AskClarificationService's OneShotAnswerChannel
    // uses for a harness run, just via a plain follow-up call instead.
    const outcome = await this.draftTurn(sessionId, transcriptKey, answerText, onUsage)
    // `fallThrough` only comes from a fresh, seeded entry (see PlanDraftOutcome's doc comment) —
    // this call passes no seed, so it can't actually happen; the `in` check just keeps the return
    // type honest without asserting past PlanDraftOutcome's union.
    if ('fallThrough' in outcome) {
      return { status: 'ok', reply: null, riskLevel: 'LOW', harnessSkipped: true }
    }
    return outcome
  }

  async draftTurn(
    sessionId: string,
    transcriptKey: string,
    userMessage: string,
    onUsage: (usage: TokenUsage) => void,
    seed?: PlanDraftSeed,
  ): Promise<PlanDraftOutcome> {
    if (isCancelPlanningPhrase(userMessage)) {
      return this.cancelDrafting(sessionId, transcriptKey, userMessage)
    }

    const existing = await this.planService.loadPlanRecord(sessionId)
    // A plan already staged for approval isn't drafting input any more — the user is expected to
    // resolve it via `turn(message, { planApprovalId, planDecision })`, not by sending more plain
    // messages here (which, before this check existed, would silently start a brand-new draft and
    // overwrite the just-staged one at the single `plan:<sessionId>` slot).
    if (existing?.mode === 'awaiting_approval') {
      return this.stillAwaitingApproval(sessionId, transcriptKey, userMessage)
    }
    // `seed` only ever applies to a genuinely fresh draft (no existing 'drafting' record) —
    // once a draft exists, every later message is a plain revision of it, seed or not.
    const isFreshEntry = !existing || existing.mode !== 'drafting'
    const draft: PlanRecord =
      isFreshEntry && seed?.templateName
        ? { ...this.planService.createDraftPlanRecord(seed.templateName), ...seedFromTemplate(seed.templateName) }
        : existing && existing.mode === 'drafting'
          ? existing
          : this.planService.createDraftPlanRecord(null)

    // P3: ground a from-scratch (no template match) draft in real repo state via the same bounded
    // read_file/list_directory investigation walk the Trajectory Supervisor's GATHER_EVIDENCE
    // directive already uses (AgentLoop.runSupervisorInvestigation) — reusing that mechanism
    // rather than building a new search engine (Scope & non-goals). Best-effort: no fileTools
    // configured, or the walk finding nothing, just means the draft proceeds from conversation
    // text alone, same as before this phase.
    let groundingContext: string | undefined
    if (isFreshEntry && seed?.grounded && this.agentLoop) {
      const findings = await this.agentLoop.runSupervisorInvestigation(
        { question: userMessage, suggested_tools: ['read_file', 'list_directory'], budget: 8 },
        { riskHint: 'LOW' },
      )
      if (findings.length > 0) groundingContext = findings.map((f) => `[${f.tool}] ${f.content}`).join('\n\n')
    }

    const revision = await draftPlanRevision(
      this.llmClient,
      userMessage,
      draft.tasks,
      draft.successCriteria,
      draft.rationale,
      this.model(),
      onUsage,
      groundingContext,
    )

    if (!revision) {
      // A fresh, auto-triggered entry (seed set) whose very first draft failed falls back to not
      // entering plan mode at all, rather than staging a broken draft or trapping the user in a
      // drafting loop they never explicitly asked for (this phase's Validation) — nothing has been
      // appended to the transcript yet, so the ordinary pipeline picks up userMessage cleanly.
      if (isFreshEntry && seed) {
        await this.session.exitPlanMode(sessionId)
        return { fallThrough: true }
      }
      const reply = "I couldn't update the plan draft from that — could you rephrase, or say \"cancel plan\" to stop drafting?"
      await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'user', content: userMessage })
      await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'assistant', content: reply })
      return { status: 'ok', reply, riskLevel: 'LOW', harnessSkipped: true }
    }

    // P8 of the internal plan — the drafting call hit a genuine
    // ambiguity and wants to ask instead of guess. Deliberately doesn't persist `revision`'s
    // tasks/successCriteria/rationale here (the system prompt asks the model to echo the current
    // draft unchanged when it sets `question`, so `draft` — already on disk — already reflects
    // them): the *only* thing worth staging is the question itself. INV-30 stays satisfied by
    // construction — this never dispatches a tool call at all, just an extra field on the same
    // structured drafting call already permitted, so there is no separate call for a write/shell/
    // email side channel to hide behind.
    if (revision.question && this.memory) {
      return this.stageNestedAsk(sessionId, transcriptKey, userMessage, revision.question)
    }

    const tasks: PlanTaskRecord[] = revision.tasks.map((t) => ({ id: t.id, description: t.description, depends_on: t.depends_on, status: 'PENDING', riskLevel: t.riskLevel }))
    const updated: PlanRecord = {
      ...draft,
      tasks,
      successCriteria: revision.successCriteria,
      rationale: revision.rationale,
      updatedAt: new Date().toISOString(),
    }
    await this.planService.savePlan(sessionId, updated)

    // P2's mandatory whole-plan approval gate — every drafted plan passes through here exactly
    // once, regardless of risk (no risk-tiered skip). `stageAndRespond` owns appending
    // `userMessage` to the transcript itself (mirrors AskClarificationService.stageAndRespond),
    // so it isn't appended again below.
    if (revision.readyForApproval) {
      // P6's self-verification pass, run right before staging: a dependency-graph problem fails
      // fast (never silently staged), while an LLM-lens failure never blocks the plan — it just
      // proceeds to approval without reviewNotes.
      const verification = await verifyPlanDraft(this.llmClient, updated.tasks, updated.successCriteria, updated.rationale, this.model(), onUsage)
      if (verification.kind === 'graph_invalid') {
        const reply =
          `Before I can stage this for approval, the task list has a structural problem: ${verification.errors.join('; ')}. ` +
          'Could you clarify how these tasks should relate, or should I fix the dependencies myself?'
        await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'user', content: userMessage })
        await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'assistant', content: reply })
        this.onTrace?.({ kind: 'plan_updated', templateName: updated.templateName, completionPct: 0 })
        return {
          status: 'ok',
          reply,
          riskLevel: 'LOW',
          harnessSkipped: true,
          planStatus: {
            templateName: updated.templateName,
            successCriteria: updated.successCriteria,
            completionPct: 0,
            tasks: updated.tasks.map((t) => ({ id: t.id, description: t.description, status: t.status })),
          },
        }
      }
      const verified: PlanRecord = { ...updated, reviewNotes: verification.reviewNotes, verifiedAt: verification.verifiedAt }
      return this.planApproval.stageAndRespond(sessionId, transcriptKey, verified, userMessage)
    }

    await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'user', content: userMessage })
    await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'assistant', content: revision.reply })
    this.onTrace?.({ kind: 'plan_updated', templateName: updated.templateName, completionPct: 0 })

    return {
      status: 'ok',
      reply: revision.reply,
      riskLevel: 'LOW',
      harnessSkipped: true,
      planStatus: {
        templateName: updated.templateName,
        successCriteria: updated.successCriteria,
        completionPct: 0,
        tasks: updated.tasks.map((t) => ({ id: t.id, description: t.description, status: t.status })),
      },
    }
  }

  private async stillAwaitingApproval(sessionId: string, transcriptKey: string, userMessage: string): Promise<AssistantTurnResult> {
    const reply = 'This plan is already staged for approval — respond to the approval prompt, or say "cancel plan" to discard it, before drafting further.'
    await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'user', content: userMessage })
    await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'assistant', content: reply })
    return { status: 'ok', reply, riskLevel: 'LOW', harnessSkipped: true }
  }

  /** Stages a single nested question (P8) and returns the `needs_clarification` result — mirrors AskClarificationService.stageAndRespond's "append the user's message, return no reply yet" shape, but into `plan-ask-pending:` instead of `ask-pending:`, and resolved by `resolvePendingAsk` above instead of a harness resume. */
  private async stageNestedAsk(sessionId: string, transcriptKey: string, userMessage: string, question: AskQuestion): Promise<AssistantTurnResult> {
    const questions = makeQuestionsBatch([question])
    const id = crypto.randomUUID()
    await this.memory!.set(this.planAskPendingKey(id), { questions } satisfies PlanAskPendingState)
    await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'user', content: userMessage })
    this.onTrace?.({ kind: 'escalation', reason: `plan_ask: ${question.question}` })
    return { status: 'needs_clarification', reply: null, riskLevel: 'LOW', pendingClarificationId: id, questions }
  }

  private async cancelDrafting(sessionId: string, transcriptKey: string, userMessage: string): Promise<AssistantTurnResult> {
    const existing = await this.planService.loadPlanRecord(sessionId)
    // Covers a plan already staged for approval too (P2) — not just 'drafting' — so cancelling
    // out of plan mode never leaves a stale `awaiting_approval` record behind for a later
    // enterPlanMode/draftTurn call to trip over.
    if (existing && (existing.mode === 'drafting' || existing.mode === 'awaiting_approval')) {
      await this.planService.abandonPlan(sessionId, existing)
    }
    await this.session.exitPlanMode(sessionId)
    const reply = 'Stopped drafting — the plan was discarded. Nothing was run.'
    await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'user', content: userMessage })
    await this.session.appendTranscriptMessage(sessionId, transcriptKey, { role: 'assistant', content: reply })
    return { status: 'ok', reply, riskLevel: 'LOW', harnessSkipped: true }
  }
}
