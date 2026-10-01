import type { ExperienceStore, StrategyWeightKey, DecompositionEntry, RecoverySequenceEntry, ExperienceStoreData, ExternalContradictionInput } from '@buildaharness/harness'
import type { MemoryAdapter, ReminderStore, ReminderRecord, ILLMClient, TokenUsage } from '@buildaharness/runtime'
import { explicitEnvOverride } from './layer-policy-wiring.js'
import { extractFactsFromTurn, migrateFact, tierForFact, isKnowledgeTier, type UserFact } from './fact-extraction.js'
import { checkForContradictions, semanticContradictionEnabled, type BeliefCandidate, type Corroboration } from './contradiction-checker.js'
import type { StatedFact, FactCategory, FactConfidence } from './turn-intent-classifier.js'

// Most-recent facts (and, separately, active reminders) injected into the system prompt each
// turn — a hard cap, not a summary, so this stays cheap even as the fact/reminder store grows.
export const FACT_CAP = 20

/** Default character budget for the rendered facts block under `AUDIT_MEMORY_BUDGETED_RENDER` (M0 measured ~195 tokens ≈ 800 chars for 20 facts; this leaves room for roughly 5x that). */
export const DEFAULT_MEMORY_BUDGET_CHARS = 4000

/** Append-only store of entries a keyed fact replaced (M1); the M2 audit log will subsume it. */
export const RETIRED_FACTS_KEY = 'facts:retired'

// Deliberately NOT suffixed with a sessionId — clearSession() only deletes `facts:${sessionId}`,
// so a fact stored here (see recordFacts()) survives /new the same way reminderStore/
// experienceStore already do (see AssistantSession.clearSession's doc comment on why those stay
// untouched). This personal-assistant is single-user/single-install, so one global durable-fact
// list (not per-session) is the right shape — matching reminderStore/experienceStore's own
// precedent.
export const DURABLE_FACTS_KEY = 'facts:durable'

/**
 * Global, never cleared by `/new` — same retention shape as DURABLE_FACTS_KEY (a pending fact
 * shouldn't vanish just because the session changed). Phase 3 of
 * the internal plan: a `model_inferred` fact
 * that reached `durable: true, confidence: 'medium'` lands here instead of being silently
 * promoted or silently dropped — see `recordFacts()`'s promotion policy and
 * `confirmPendingFact()`/`rejectPendingFact()` below.
 */
export const PENDING_CONFIRMATION_KEY = 'facts:pending-confirmation'

/**
 * Global, never cleared by `/new`. Holds facts removed from `facts:${sessionId}`/
 * PENDING_CONFIRMATION_KEY either by an entry-time retraction (a later statement contradicts an
 * unconfirmed guess — see `recordFacts()`) or by an explicit `/memory reject`. Rejected facts are
 * remembered, not blacklisted: the entry-time check compares new statements against this pool
 * too, so a matching restatement can re-enter PENDING_CONFIRMATION_KEY tagged
 * `previouslyRejected` instead of being silently re-asked forever or silently refused forever.
 */
export const REJECTED_FACTS_KEY = 'facts:rejected'

/** Bound on how many learned decompositions/recovery sequences `getMemorySummary()` includes — see MemorySummary's doc comment. */
export const MEMORY_SUMMARY_PREVIEW_LIMIT = 20

/** A `model_inferred` fact sitting in PENDING_CONFIRMATION_KEY, awaiting `/memory confirm`/`/memory reject`. */
export interface PendingFact extends UserFact {
  category: FactCategory
  /** True when this exact fact previously lived in REJECTED_FACTS_KEY and was corroborated back in by a later, differently-phrased restatement — see `recordFacts()`'s corroboration handling. `/memory` surfaces this so the user sees the prior rejection instead of the fact looking brand new. */
  previouslyRejected?: boolean
}

/** An entry in REJECTED_FACTS_KEY — see that constant's doc comment. */
export interface RejectedFact {
  text: string
  rejectedAt: string
  rejectionSource: 'auto_retracted' | 'user_explicit'
}

/**
 * Read-only snapshot returned by `getMemorySummary()` — see that method's doc comment.
 * `decompositions`/`recoverySequences` are capped at the 20 most recently learned entries
 * (newest first) so `/memory` stays scannable after months of accumulated learning; `/memory
 * export` (see `exportMemory()`) returns every category unbounded, since a file on disk doesn't
 * have the same terminal-scrollback concern a REPL print does. `pending`/`rejected` are their
 * stores' full, unbounded contents — neither is expected to grow anywhere near
 * MEMORY_SUMMARY_PREVIEW_LIMIT in practice, unlike decompositions/recoverySequences.
 */
export interface MemorySummary {
  facts: UserFact[]
  reminders: ReminderRecord[]
  pending: PendingFact[]
  experience: {
    strategyWeights: Record<StrategyWeightKey, number>
    decompositions: DecompositionEntry[]
    recoverySequences: RecoverySequenceEntry[]
  }
}

/** Full, unbounded snapshot written by `/memory export` — every ExperienceStore category plus facts/reminders/pending-confirmation, as plain JSON. */
export interface MemoryExport {
  exportedAt: string
  facts: UserFact[]
  reminders: ReminderRecord[]
  pending: PendingFact[]
  experience: ExperienceStoreData
}

/** Result of a single fact's promotion-time (`/memory confirm`) or corroboration-driven (medium→high) admission into DURABLE_FACTS_KEY — see `confirmPendingFact()`. */
export interface PendingConfirmationOutcome {
  fact: UserFact
  /** Set when the promotion-time check (checkForContradictions against current Knowledge) found a conflict — advisory only, matching every other contradiction check in this codebase: the promotion still succeeds regardless. */
  conflictNotice?: string
}

/** `recordFacts()`'s return — see its doc comment's "Ordering constraint" note on why callers must read this before building any contradiction notice for the turn. */
export interface RecordFactsResult {
  contradictions: ExternalContradictionInput[]
  corroborations: Corroboration[]
}

/**
 * `AUDIT_MEMORY_BUDGETED_RENDER` gate (M1 of the agent memory framework plan). Gates budgeted/
 * priority rendering, keyed supersession and usage fields. `=0`/`off` restores `slice(-FACT_CAP)`
 * and append-only writes. Shipped default **OFF**: the M1 real-model pilot has not run (see the plan's
 * defaults rule), so only `1`/`true`/`on`/`yes`/`enabled` turns it on. Read fresh each call.
 */
export function memoryBudgetedRenderEnabled(env?: Record<string, string | undefined>): boolean {
  const source = env ?? (typeof process !== 'undefined' ? process.env : {})
  const raw = String(source.AUDIT_MEMORY_BUDGETED_RENDER ?? '').trim().toLowerCase()
  return ['1', 'true', 'on', 'yes', 'enabled'].includes(raw)
}

const TIER_PRIORITY: Record<string, number> = { identity: 0, preference: 0, semantic: 1, episodic: 2 }

export interface RenderedFacts {
  block: string
  /** Facts actually placed in the block, in render order. */
  shown: UserFact[]
  /** In-scope live facts that did not fit the budget. */
  droppedCount: number
}

/**
 * Renders facts by priority and character budget, not by position: identity/preference first, then
 * semantic, then episodic/session facts; within a tier newest statement first, then most recently
 * injected. A fact is dropped only when the budget is spent, and the drop is counted. No
 * query-relevance ranking (D2: no lexical scoring). Pure.
 */
export function renderFactsBlock(inScope: UserFact[], budgetChars: number): RenderedFacts {
  const live = inScope.filter((f) => !f.retiredAt)
  const ranked = live
    .map((f, i) => ({ f, i, p: f.durable ? (TIER_PRIORITY[tierForFact(f)] ?? 1) : 2 }))
    .sort((a, b) =>
      a.p - b.p
      || b.f.extractedAt.localeCompare(a.f.extractedAt)
      || (b.f.lastInjectedAt ?? '').localeCompare(a.f.lastInjectedAt ?? '')
      || b.i - a.i)
  const header = '\nKnown facts about the user:\n'
  const shown: UserFact[] = []
  const lines: string[] = []
  let used = header.length
  for (const { f } of ranked) {
    const line = factLine(f)
    const cost = line.length + (lines.length > 0 ? 1 : 0)
    if (used + cost > budgetChars) continue // a shorter later fact may still fit
    lines.push(line)
    shown.push(f)
    used += cost
  }
  return { block: lines.length > 0 ? `${header}${lines.join('\n')}` : '', shown, droppedCount: live.length - shown.length }
}

/** Durable facts first, then session facts whose text isn't already present among them — so a
 * fact recorded as durable (an allergy, a name) doesn't show up twice within the same session it
 * was stated in, but does reappear on its own once /new clears the session list. */
function mergeFacts(durableFacts: UserFact[], sessionFacts: UserFact[]): UserFact[] {
  const durableTexts = new Set(durableFacts.map(f => f.text))
  return [...durableFacts, ...sessionFacts.filter(f => !durableTexts.has(f.text))]
}

/**
 * Case-insensitive substring containment, not fuzzy matching — deliberately narrow so a genuinely
 * distinct fact is never dropped for merely sharing a few words with another. Used by
 * `recordFacts()` (Phase 2 of the internal plan)
 * to recognize when the lexical pass and the LLM caught the same underlying statement in different
 * phrasing ("My name is Priya" / "the user's name is Priya").
 */
function isNearDuplicateText(a: string, b: string): boolean {
  const la = a.toLowerCase()
  const lb = b.toLowerCase()
  return la.includes(lb) || lb.includes(la)
}

/**
 * `AUDIT_MODEL_INFERRED_FACTS` gate — feature-value audit (Phase C3 of the internal plan).
 * Default **ON**: `classifyTurnIntent`'s `statesDurableFacts` (source `model_inferred`) reach
 * memory today, so an unset / empty / truthy value keeps that behaviour. Set to a falsy value
 * (`0` / `false` / `off` / `no` / `disabled`) to drop them, leaving only the lexical
 * `user_asserted` pass. Gates the *consumption* of the classifier's facts, not the classifier call
 * (which also produces the intent/risk fields every arm needs). Read at exactly one call site —
 * `buildTurnFacts()` below. Same shape as `semanticContradictionEnabled()` (contradiction-checker.ts).
 */
export function modelInferredFactsEnabled(env?: Record<string, string | undefined>): boolean {
  const source = env ?? (typeof process !== 'undefined' ? process.env : {})
  const raw = String(source.AUDIT_MODEL_INFERRED_FACTS ?? '').trim().toLowerCase()
  if (raw === '') return true
  return !['0', 'false', 'off', 'no', 'disabled'].includes(raw)
}

/**
 * Combines this turn's two fact-capture passes into one ordered list: the free lexical pass
 * first, then any LLM-derived fact whose text isn't a near-duplicate of something the lexical pass
 * already caught (see isNearDuplicateText). Both passes are always considered now (Phase 2) —
 * neither gates the other the way the old "LLM only when lexical found nothing" fallback did.
 */
function mergeTurnFacts(lexicalFacts: UserFact[], llmFacts: UserFact[]): UserFact[] {
  const novelLlmFacts = llmFacts.filter((llmFact) => !lexicalFacts.some((lexFact) => isNearDuplicateText(lexFact.text, llmFact.text)))
  return [...lexicalFacts, ...novelLlmFacts]
}

/**
 * The exact lexical+LLM merge `recordFacts()` uses to decide what to write to the fact stores,
 * exposed (Phase 4 of the internal plan) so a
 * caller can seed `HarnessRunParams.currentTurnFacts` (harness-bridge.ts's `factExtractor`) with
 * the identical merged, deduplicated list — instead of harness-bridge.ts recomputing only the free
 * lexical half and never seeing an LLM-caught fact at all, which left a same-turn LLM-caught fact
 * invisible to contradiction detection. Two independent calls with the same arguments (one here to
 * build a harness run's currentTurnFacts before the run, one inside `recordFacts()` itself after
 * it) each stamp their own `extractedAt` — harmless, since neither call's result is compared
 * against the other's by identity.
 */
export function buildTurnFacts(sessionId: string, userMessage: string, statedFacts: StatedFact[], policyEnabled: boolean = true): UserFact[] {
  const lexicalFacts = extractFactsFromTurn(userMessage, `turn:${sessionId}`)
  // The single AUDIT_MODEL_INFERRED_FACTS read: every path a `model_inferred` fact takes into the
  // session store, durable store, pending-confirmation queue, prompt or the harness's
  // currentTurnFacts goes through this function, so dropping them here (and only here) leaves the
  // classifier call itself and the lexical `user_asserted` pass untouched.
  // AL8a: `policyEnabled` is the layer policy's verdict for model_inferred_facts (default true =
  // today's behaviour); an explicit AUDIT_MODEL_INFERRED_FACTS value still wins over it.
  const llmFacts: UserFact[] = (explicitEnvOverride('AUDIT_MODEL_INFERRED_FACTS') ?? policyEnabled) && modelInferredFactsEnabled()
    ? statedFacts.map((fact) => ({
        text: fact.text,
        extractedAt: new Date().toISOString(),
        sourceTurn: `turn:${sessionId}`,
        source: 'model_inferred',
        durable: fact.durable,
        confidence: fact.confidence,
        category: fact.category,
        ...(fact.key ? { key: fact.key } : {}),
      }))
    : []
  return mergeTurnFacts(lexicalFacts, llmFacts)
}

/**
 * Three-way promotion split (Phase 2's table, extended by Phase 3): a `user_asserted` fact
 * promotes on its own `durable` bit, unchanged since before Phase 2. A `model_inferred` fact only
 * auto-promotes straight to DURABLE_FACTS_KEY at `confidence: 'high'`; `recordFacts()` handles the
 * medium/low split on top of this (queue medium to PENDING_CONFIRMATION_KEY, leave low
 * session-scoped-only) separately, since that's a queuing decision, not a promotion one.
 */
function shouldAutoPromote(fact: UserFact): boolean {
  if (fact.source === 'model_inferred') return fact.durable && fact.confidence === 'high'
  return fact.durable
}

/** Text-and-timestamp identity match — the same (text, extractedAt) pair a fact was captured with, used to find-and-remove/find-and-update one specific entry in a UserFact[] without a dedicated id field. */
function sameFact(a: UserFact, b: UserFact): boolean {
  return a.text === b.text && a.extractedAt === b.extractedAt
}

function toBeliefCandidates(facts: UserFact[], prefix: string): BeliefCandidate[] {
  return facts.map((f, i) => ({ id: `${prefix}-${i}`, statement: f.text }))
}

/**
 * Phase 4 of the internal plan: confidence must
 * reach the model's own reasoning, not just the promotion logic — an unconfirmed guess spliced
 * into the system prompt unqualified would read exactly as certain as a confirmed fact. Only
 * medium/low-confidence `model_inferred` facts get the "(unconfirmed)" suffix; a high-confidence
 * `model_inferred` fact, anything `user_asserted`, and anything already promoted/confirmed (which
 * `promoteConfirmedFact()` re-sources to `externally_verified`, clearing `confidence`) render
 * unqualified.
 */
function factLine(f: UserFact): string {
  const unconfirmed = f.source === 'model_inferred' && (f.confidence === 'medium' || f.confidence === 'low')
  return `- ${f.text}${unconfirmed ? ' (unconfirmed)' : ''}`
}

/**
 * Owns fact/reminder/experience reads that feed each turn's system prompt, fact capture, and the
 * `/memory`/`/memory export` read-only snapshots — the "what has this assistant learned" surface
 * of PersonalAssistant, split out in Phase 4d of the architecture remediation plan. `llmClient`/
 * `model` were added in Phase 3 of the fact-extraction-confidence plan — `recordFacts()`'s
 * entry-time consistency check and the promotion-time check in `confirmPendingFact()` both run
 * the same `checkForContradictions` the harness's own per-turn contradiction hook already uses,
 * rather than building a second mechanism.
 */
export class MemoryService {
  constructor(
    private readonly memory: MemoryAdapter,
    private readonly reminderStore: ReminderStore,
    private readonly experienceStore: ExperienceStore,
    private readonly llmClient: ILLMClient,
    private readonly model: () => string | undefined,
    /** Resolves to `config.activeProject` if the user set one via `/project <name>`, else the workspace root — read through a getter (same convention as `model` above) so a mid-session `/project`/`/config set activeProject` change takes effect on the very next turn. See UserFact.project's doc comment for how this is used. */
    private readonly currentProject: () => string = () => '',
    /** M1: character budget for the facts block under `AUDIT_MEMORY_BUDGETED_RENDER` (config `memoryBudgetChars`). */
    private readonly memoryBudgetChars: () => number = () => DEFAULT_MEMORY_BUDGET_CHARS,
  ) {}

  /** Facts rendered since the last flush, keyed by `text|extractedAt`; written lazily so loadFacts() stays read-only (M1). */
  private pendingInjections = new Map<string, number>()
  /** Number of in-scope facts the last budgeted render could not show — `/memory` says "N facts not shown this turn". */
  lastDroppedCount = 0

  /**
   * Durable + session facts for `sessionId`, plus the ready-to-splice system-prompt block — see
   * runTurn's former factsBlock. `facts` is the full inventory, unfiltered by project — `/memory`
   * (getMemorySummary) needs to show and let the user forget a fact regardless of which project is
   * currently active. `factsBlock` — what the model actually sees this turn — filters to
   * global-or-current-project only, so an unrelated project's facts don't leak into context (see
   * UserFact.project's doc comment).
   */
  async loadFacts(sessionId: string): Promise<{ facts: UserFact[]; factsBlock: string }> {
    const sessionFacts = (((await this.memory.get(`facts:${sessionId}`)) as UserFact[] | undefined) ?? []).map(migrateFact)
    const durableFacts = (((await this.memory.get(DURABLE_FACTS_KEY)) as UserFact[] | undefined) ?? []).map(migrateFact)
    const facts = mergeFacts(durableFacts, sessionFacts)
    const project = this.currentProject()
    const inScope = facts.filter((f) => f.project === undefined || f.project === project)
    if (memoryBudgetedRenderEnabled()) {
      const rendered = renderFactsBlock(inScope, this.memoryBudgetChars())
      this.lastDroppedCount = rendered.droppedCount
      for (const f of rendered.shown) {
        const id = `${f.text}|${f.extractedAt}`
        this.pendingInjections.set(id, (this.pendingInjections.get(id) ?? 0) + 1)
      }
      return { facts, factsBlock: rendered.block }
    }
    const factsBlock = inScope.length > 0
      ? `\nKnown facts about the user:\n${inScope.slice(-FACT_CAP).map(factLine).join('\n')}`
      : ''
    return { facts, factsBlock }
  }

  /**
   * `/memory forget <n>` — removes the nth entry (1-based in `/memory`'s "Facts I know" display,
   * 0-based here) from whichever store(s) it actually lives in. `index` is over the same merged,
   * durable-first ordering `loadFacts()`/`getMemorySummary()` already produce, so the number a user
   * sees in `/memory` is the number they pass here — no separate "durable index" vs "session index"
   * to track. A fact that's both durable and session-scoped under an identical restated text (see
   * mergeFacts's dedup) is removed from both stores by `sameFact` identity, not just the copy that
   * happened to win the display dedup. Returns undefined for an out-of-range index (the caller's
   * `/memory` view is stale — nothing to forget).
   */
  async forgetFact(index: number, sessionId: string): Promise<UserFact | undefined> {
    const sessionFacts = (((await this.memory.get(`facts:${sessionId}`)) as UserFact[] | undefined) ?? []).map(migrateFact)
    const durableFacts = (((await this.memory.get(DURABLE_FACTS_KEY)) as UserFact[] | undefined) ?? []).map(migrateFact)
    const merged = mergeFacts(durableFacts, sessionFacts)
    if (index < 0 || index >= merged.length) return undefined
    const fact = merged[index]
    const remainingDurable = durableFacts.filter((f) => !sameFact(f, fact))
    const remainingSession = sessionFacts.filter((f) => !sameFact(f, fact))
    if (remainingDurable.length !== durableFacts.length) await this.memory.set(DURABLE_FACTS_KEY, remainingDurable)
    if (remainingSession.length !== sessionFacts.length) await this.memory.set(`facts:${sessionId}`, remainingSession)
    return fact
  }

  /**
   * reminderStore is cross-session durable (clearSession() never touches it, same tier as
   * DURABLE_FACTS_KEY) but, unlike facts, was never actually surfaced into context: a plain
   * conversational question about a previously-created reminder ("did I mention X earlier?") got
   * no grounding unless the model happened to call list_reminders itself — found via live
   * testing (a fresh /new session flatly denied any record of a reminder created in the prior
   * session, and separately claimed "I don't have access to other conversations" in the same
   * reply that a durable *fact* from that same prior session correctly informed). Only undone
   * reminders: a completed one is no longer something the user would expect the assistant to
   * "remember" as pending.
   */
  async loadActiveReminders(): Promise<{ activeReminders: ReminderRecord[]; remindersBlock: string }> {
    const activeReminders = (await this.reminderStore.list()).filter(r => !r.done)
    const remindersBlock = activeReminders.length > 0
      ? `\nExisting reminders:\n${activeReminders.slice(-FACT_CAP).map(r => `- ${r.rawText}`).join('\n')}`
      : ''
    return { activeReminders, remindersBlock }
  }

  /**
   * Captures this turn's durable/session facts into the session's fact store. A no-op when
   * neither pass finds anything. Facts that clear `shouldAutoPromote()` (see that function's doc
   * comment for the current three-way policy) are ALSO appended to DURABLE_FACTS_KEY, a store
   * clearSession() never touches, so they survive /new instead of vanishing with the rest of the
   * session's facts. A `model_inferred` fact at `durable: true, confidence: 'medium'` is queued
   * to PENDING_CONFIRMATION_KEY instead (Phase 3) — never auto-promoted, never dropped.
   *
   * Phase 2: the free lexical pass (`extractFactsFromTurn`) and `classifyTurnIntent`'s
   * `statesDurableFacts` (the `StatedFact[]` list this method's `statedFacts` param carries) are
   * **both always considered**, merged via `mergeTurnFacts()`. The lexical pass keeps running
   * unconditionally so a classifier outage (an empty `statedFacts` list, per
   * `failSafeClassification`) still degrades to "regex only," never to "no facts at all."
   *
   * Phase 3: every write this function performs passes through the entry-time consistency check
   * first — this turn's new facts are checked, in one batched `checkForContradictions` call, both
   * against Knowledge (durable + session facts already in the Knowledge tier — see
   * `tierForFact`/`isKnowledgeTier`) and against the session's current medium/low-confidence
   * `model_inferred` facts (the "uncertain pool"), plus REJECTED_FACTS_KEY (so a restated,
   * previously-rejected guess is recognized rather than treated as brand new). A contradiction
   * against the uncertain pool is a retraction: the retracted fact is removed from the session
   * store and PENDING_CONFIRMATION_KEY and recorded into REJECTED_FACTS_KEY instead. A
   * corroboration against the uncertain pool upgrades that fact's confidence in place
   * (low→medium queues it to PENDING_CONFIRMATION_KEY; medium→high promotes it to
   * DURABLE_FACTS_KEY) — corroboration is deliberately the one read-modify-write path in this
   * function; every other write is append-only. A corroboration against REJECTED_FACTS_KEY
   * re-queues the fact to PENDING_CONFIRMATION_KEY tagged `previouslyRejected`.
   *
   * **Ordering constraint on callers**: this must run, and its `contradictions` must be folded
   * into whatever contradiction notice the turn returns, BEFORE that notice is finalized — see
   * response-service.ts's three result-builders and assistant-session.ts's
   * `dedupedContradictionNotice`. Left uncalled, this phase's entry-time findings would be
   * computed but never surfaced in the turn's own reply.
   */
  async recordFacts(
    sessionId: string,
    userMessage: string,
    statedFacts: StatedFact[],
    onUsage?: (usage: TokenUsage) => void,
  ): Promise<RecordFactsResult> {
    // Only a fact classified `category: 'project'` gets scoped — everything else (identity,
    // health, preference, ...) is inherently about the user, not a codebase, and stays global
    // regardless of which project is active. An empty currentProject() (no workspace/override
    // resolved — see the constructor's default) leaves the fact unscoped rather than tagging it
    // with a meaningless empty string.
    const project = this.currentProject()
    const newFacts = buildTurnFacts(sessionId, userMessage, statedFacts).map((f) =>
      f.category === 'project' && project ? { ...f, project } : f,
    )
    // A no-op turn (neither pass found anything) must stay a true no-op — no store touched at
    // all, not even an empty-array write — matching every reader that treats an absent key the
    // same as an empty one, and the "records nothing" test's expectation that the key itself
    // stays unset until a fact is actually captured.
    if (memoryBudgetedRenderEnabled()) await this.flushInjectionUsage(sessionId)
    if (newFacts.length === 0) return { contradictions: [], corroborations: [] }

    let sessionFacts = (((await this.memory.get(`facts:${sessionId}`)) as UserFact[] | undefined) ?? []).map(migrateFact)
    let durableFacts = (((await this.memory.get(DURABLE_FACTS_KEY)) as UserFact[] | undefined) ?? []).map(migrateFact)
    let pendingFacts = ((await this.memory.get(PENDING_CONFIRMATION_KEY)) as PendingFact[] | undefined) ?? []
    let rejectedFacts = ((await this.memory.get(REJECTED_FACTS_KEY)) as RejectedFact[] | undefined) ?? []
    // newFacts.length > 0 (guaranteed above) always changes sessionFacts; the other three stores
    // only get an actual write when something below touches them — an untouched store must stay
    // untouched (not overwritten with an equivalent-but-freshly-serialized empty/unchanged array),
    // same "absent key stays absent" contract the no-op early-return above already establishes.
    let durableChanged = false
    let pendingChanged = false
    let rejectedChanged = false

    const uncertainPool = sessionFacts
      .filter((f) => f.source === 'model_inferred' && (f.confidence === 'medium' || f.confidence === 'low'))
      .slice(-FACT_CAP)
    const knowledgePool = mergeFacts(durableFacts, sessionFacts).filter((f) => isKnowledgeTier(tierForFact(f))).slice(-FACT_CAP)
    const rejectedPool = rejectedFacts.slice(-FACT_CAP)

    const newBeliefs = toBeliefCandidates(newFacts, 'new')
    const existingBeliefs = toBeliefCandidates(knowledgePool, 'existing')
    const uncertainBeliefs = toBeliefCandidates(uncertainPool, 'uncertain')
    const rejectedBeliefs = rejectedPool.map((f, i) => ({ id: `rejected-${i}`, statement: f.text }))

    // AUDIT_SEMANTIC_CONTRADICTION gates this call site too (it used to gate only the harness-bridge
    // hook, so the `contradictionOff` arm still made this same LLM call every turn). Unset ⇒ enabled.
    const { contradictions, corroborations } = semanticContradictionEnabled()
      ? await checkForContradictions(newBeliefs, existingBeliefs, this.llmClient, this.model(), onUsage, uncertainBeliefs, rejectedBeliefs)
      : { contradictions: [], corroborations: [] }

    const uncertainIdIndex = new Map(uncertainBeliefs.map((b, i) => [b.id, i]))
    const rejectedIdIndex = new Map(rejectedBeliefs.map((b, i) => [b.id, i]))

    // Retraction: a contradiction naming an uncertain-pool id retracts that fact — same output
    // shape as any other contradiction, distinguished only by which pool the matched id came
    // from (resolved here via uncertainIdIndex, not by the checker itself).
    const retracted = new Set<UserFact>()
    for (const c of contradictions) {
      for (const id of c.beliefIds) {
        const idx = uncertainIdIndex.get(id)
        if (idx !== undefined) retracted.add(uncertainPool[idx])
      }
    }
    for (const fact of retracted) {
      sessionFacts = sessionFacts.filter((f) => !sameFact(f, fact))
      pendingFacts = pendingFacts.filter((f) => !sameFact(f, fact))
      rejectedFacts = [...rejectedFacts, { text: fact.text, rejectedAt: new Date().toISOString(), rejectionSource: 'auto_retracted' }]
      pendingChanged = true
      rejectedChanged = true
    }

    // Corroboration: upgrade an uncertain-pool fact's confidence in place (low→medium queues
    // it; medium→high promotes it), or re-queue a REJECTED_FACTS_KEY match as previouslyRejected.
    for (const cor of corroborations) {
      const uIdx = uncertainIdIndex.get(cor.existingId)
      if (uIdx !== undefined) {
        const target = uncertainPool[uIdx]
        if (retracted.has(target)) continue // same turn can't both retract and corroborate the same fact
        const next: FactConfidence | undefined = target.confidence === 'low' ? 'medium' : target.confidence === 'medium' ? 'high' : undefined
        if (!next) continue
        const upgraded: UserFact = { ...target, confidence: next }
        sessionFacts = sessionFacts.map((f) => (sameFact(f, target) ? upgraded : f))
        pendingFacts = pendingFacts.filter((f) => !sameFact(f, target))
        if (next === 'medium') {
          pendingFacts = [...pendingFacts, { ...upgraded, category: upgraded.category ?? 'other' }]
          pendingChanged = true
        } else if (next === 'high' && shouldAutoPromote(upgraded)) {
          durableFacts = [...durableFacts, upgraded]
          durableChanged = true
          pendingChanged = true
        }
        continue
      }
      const rIdx = rejectedIdIndex.get(cor.existingId)
      if (rIdx !== undefined) {
        const restated = rejectedPool[rIdx]
        rejectedFacts = rejectedFacts.filter((f) => f !== restated)
        pendingFacts = [
          ...pendingFacts,
          {
            text: restated.text,
            extractedAt: new Date().toISOString(),
            sourceTurn: `turn:${sessionId}`,
            source: 'model_inferred',
            durable: true,
            confidence: 'medium',
            category: 'other',
            previouslyRejected: true,
          },
        ]
        rejectedChanged = true
        pendingChanged = true
      }
    }

    const retiredNow: UserFact[] = []
    for (let fact of newFacts) {
      if (memoryBudgetedRenderEnabled() && fact.key) {
        const key = fact.key
        const sameKey = (f: UserFact): boolean => f.key === key && (f.project ?? '') === (fact.project ?? '')
        const priorLive = [...durableFacts, ...sessionFacts].filter(sameKey)
        // Restating the same value is a no-op, not a new entry.
        if (priorLive.some((f) => f.text === fact.text)) continue
        if (priorLive.length > 0) {
          const retiredAt = new Date().toISOString()
          const seen = new Set<string>()
          for (const old of priorLive) {
            const id = `${old.text}|${old.extractedAt}`
            if (seen.has(id)) continue
            seen.add(id)
            retiredNow.push({ ...old, retiredAt })
          }
          if (durableFacts.some(sameKey)) { durableFacts = durableFacts.filter((f) => !sameKey(f)); durableChanged = true }
          sessionFacts = sessionFacts.filter((f) => !sameKey(f))
          fact = { ...fact, supersedes: priorLive[priorLive.length - 1].text }
        }
      }
      sessionFacts = [...sessionFacts, fact]
      if (shouldAutoPromote(fact)) {
        durableFacts = [...durableFacts, fact]
        durableChanged = true
      } else if (fact.source === 'model_inferred' && fact.durable && fact.confidence === 'medium') {
        pendingFacts = [...pendingFacts, { ...fact, category: fact.category ?? 'other' }]
        pendingChanged = true
      }
    }

    if (retiredNow.length > 0) {
      const retired = ((await this.memory.get(RETIRED_FACTS_KEY)) as UserFact[] | undefined) ?? []
      await this.memory.set(RETIRED_FACTS_KEY, [...retired, ...retiredNow])
    }
    await this.memory.set(`facts:${sessionId}`, sessionFacts)
    if (durableChanged) await this.memory.set(DURABLE_FACTS_KEY, durableFacts)
    if (pendingChanged) await this.memory.set(PENDING_CONFIRMATION_KEY, pendingFacts)
    if (rejectedChanged) await this.memory.set(REJECTED_FACTS_KEY, rejectedFacts)

    return { contradictions, corroborations }
  }

  /** Writes the batched `injectedCount`/`lastInjectedAt` updates collected by budgeted renders, to whichever store(s) hold each fact. A no-op (no writes) when nothing was rendered. */
  private async flushInjectionUsage(sessionId: string): Promise<void> {
    if (this.pendingInjections.size === 0) return
    const pending = this.pendingInjections
    this.pendingInjections = new Map()
    const now = new Date().toISOString()
    const apply = (facts: UserFact[]): { facts: UserFact[]; changed: boolean } => {
      let changed = false
      const out = facts.map((f) => {
        const n = pending.get(`${f.text}|${f.extractedAt}`)
        if (!n) return f
        changed = true
        return { ...f, injectedCount: (f.injectedCount ?? 0) + n, lastInjectedAt: now }
      })
      return { facts: out, changed }
    }
    const session = apply((((await this.memory.get(`facts:${sessionId}`)) as UserFact[] | undefined) ?? []).map(migrateFact))
    if (session.changed) await this.memory.set(`facts:${sessionId}`, session.facts)
    const durable = apply((((await this.memory.get(DURABLE_FACTS_KEY)) as UserFact[] | undefined) ?? []).map(migrateFact))
    if (durable.changed) await this.memory.set(DURABLE_FACTS_KEY, durable.facts)
  }

  /**
   * `/memory confirm <n>` — promotes the nth (1-based in `/memory`'s display, 0-based here) entry
   * in PENDING_CONFIRMATION_KEY to DURABLE_FACTS_KEY. Runs the same promotion-time check as
   * corroboration's medium→high path: entering DURABLE_FACTS_KEY is itself a store-write, checked
   * against current Knowledge at the moment of promotion rather than deferred to the next turn's
   * re-seed. A conflict is advisory only — the confirm still succeeds regardless, matching every
   * other contradiction check in this codebase (never gates belief admission); the conflict is
   * returned as `conflictNotice` for the caller to surface. Returns undefined for an out-of-range
   * index (the caller's `/memory` view is stale — nothing to confirm).
   */
  async confirmPendingFact(index: number, onUsage?: (usage: TokenUsage) => void): Promise<PendingConfirmationOutcome | undefined> {
    const pending = ((await this.memory.get(PENDING_CONFIRMATION_KEY)) as PendingFact[] | undefined) ?? []
    if (index < 0 || index >= pending.length) return undefined
    const fact = pending[index]
    await this.memory.set(PENDING_CONFIRMATION_KEY, pending.filter((_, i) => i !== index))
    return this.promoteConfirmedFact(fact, onUsage)
  }

  /** `/memory reject <n>` — removes the nth pending entry and records it into REJECTED_FACTS_KEY with `rejectionSource: 'user_explicit'`. Returns undefined for an out-of-range index. */
  async rejectPendingFact(index: number): Promise<PendingFact | undefined> {
    const pending = ((await this.memory.get(PENDING_CONFIRMATION_KEY)) as PendingFact[] | undefined) ?? []
    if (index < 0 || index >= pending.length) return undefined
    const fact = pending[index]
    await this.memory.set(PENDING_CONFIRMATION_KEY, pending.filter((_, i) => i !== index))
    await this.rejectFacts([fact], 'user_explicit')
    return fact
  }

  /** `/memory confirm <category>` — bulk-confirms every pending entry in one category, useful once a topic accumulates several related guesses the user would naturally want to resolve together. Runs the promotion-time check per fact (still one call per fact — matches confirmPendingFact's own guarantee, not batched across facts since each is an independent store-write with its own conflict outcome). */
  async confirmPendingCategory(category: FactCategory, onUsage?: (usage: TokenUsage) => void): Promise<PendingConfirmationOutcome[]> {
    const pending = ((await this.memory.get(PENDING_CONFIRMATION_KEY)) as PendingFact[] | undefined) ?? []
    const toConfirm = pending.filter((f) => f.category === category)
    await this.memory.set(PENDING_CONFIRMATION_KEY, pending.filter((f) => f.category !== category))
    const outcomes: PendingConfirmationOutcome[] = []
    for (const fact of toConfirm) {
      outcomes.push(await this.promoteConfirmedFact(fact, onUsage))
    }
    return outcomes
  }

  /** `/memory reject <category>` — bulk-rejects every pending entry in one category. */
  async rejectPendingCategory(category: FactCategory): Promise<PendingFact[]> {
    const pending = ((await this.memory.get(PENDING_CONFIRMATION_KEY)) as PendingFact[] | undefined) ?? []
    const toReject = pending.filter((f) => f.category === category)
    await this.memory.set(PENDING_CONFIRMATION_KEY, pending.filter((f) => f.category !== category))
    await this.rejectFacts(toReject, 'user_explicit')
    return toReject
  }

  private async rejectFacts(facts: PendingFact[], rejectionSource: RejectedFact['rejectionSource']): Promise<void> {
    if (facts.length === 0) return
    const rejected = ((await this.memory.get(REJECTED_FACTS_KEY)) as RejectedFact[] | undefined) ?? []
    const rejectedAt = new Date().toISOString()
    await this.memory.set(REJECTED_FACTS_KEY, [...rejected, ...facts.map((f) => ({ text: f.text, rejectedAt, rejectionSource }))])
  }

  private async promoteConfirmedFact(fact: PendingFact, onUsage?: (usage: TokenUsage) => void): Promise<PendingConfirmationOutcome> {
    const durableFacts = (((await this.memory.get(DURABLE_FACTS_KEY)) as UserFact[] | undefined) ?? []).map(migrateFact)
    const knowledgePool = durableFacts.filter((f) => isKnowledgeTier(tierForFact(f))).slice(-FACT_CAP)
    const { contradictions } = semanticContradictionEnabled()
      ? await checkForContradictions(
          [{ id: 'confirm-0', statement: fact.text }],
          toBeliefCandidates(knowledgePool, 'existing'),
          this.llmClient,
          this.model(),
          onUsage,
        )
      : { contradictions: [] }
    // Phase 4: re-sourced to `externally_verified` (a user confirmation is exactly that source's
    // definition) rather than just bumping confidence to 'high' — tierForFact()'s model_inferred
    // branch additionally requires `durable: true`, which a fact queued via the low-confidence
    // corroboration path (see the `for (const cor of corroborations)` loop above) isn't guaranteed
    // to carry. Re-sourcing guarantees Knowledge-tier membership on the next turn's re-seed
    // regardless of that bit, with no special case needed in tierForFact() itself. `confidence` is
    // cleared to `undefined` to match that field's own contract (no gradient for
    // `externally_verified`/`user_asserted`/`observed`).
    const confirmed: UserFact = { ...fact, source: 'externally_verified', confidence: undefined }
    await this.memory.set(DURABLE_FACTS_KEY, [...durableFacts, confirmed])
    return { fact: confirmed, conflictNotice: contradictions[0]?.description }
  }

  /**
   * Read-only snapshot of what this session/assistant has learned: durable facts extracted
   * from the user's own messages, reminders created so far, pending-confirmation guesses, and the
   * real content (not just counts) of the learning-layer `ExperienceStore` — strategy weights in
   * full, and the 20 most recently learned decompositions/recovery sequences (see
   * MEMORY_SUMMARY_PREVIEW_LIMIT). Use `exportMemory()` for the full, unbounded contents. Used by
   * `/memory`.
   */
  async getMemorySummary(sessionId: string): Promise<MemorySummary> {
    const { facts } = await this.loadFacts(sessionId)
    const reminders = await this.reminderStore.list()
    const pending = ((await this.memory.get(PENDING_CONFIRMATION_KEY)) as PendingFact[] | undefined) ?? []
    const experienceData = this.experienceStore.toJSON()
    return {
      facts,
      reminders,
      pending,
      experience: {
        strategyWeights: experienceData.strategy_weights,
        decompositions: experienceData.decompositions.slice(-MEMORY_SUMMARY_PREVIEW_LIMIT).reverse(),
        recoverySequences: experienceData.recovery_sequences.slice(-MEMORY_SUMMARY_PREVIEW_LIMIT).reverse(),
      },
    }
  }

  /**
   * Full, unbounded snapshot of everything learned so far — every ExperienceStore category
   * (not just the 20-entry preview `getMemorySummary()` bounds for terminal display) plus
   * facts/reminders/pending-confirmation, as plain JSON. Read-only: this adds no corresponding
   * import path, so a user cannot hand-edit the result and load it back in. Used by `/memory
   * export`.
   */
  async exportMemory(sessionId: string): Promise<MemoryExport> {
    const summary = await this.getMemorySummary(sessionId)
    return {
      exportedAt: new Date().toISOString(),
      facts: summary.facts,
      reminders: summary.reminders,
      pending: summary.pending,
      experience: this.experienceStore.toJSON(),
    }
  }
}
