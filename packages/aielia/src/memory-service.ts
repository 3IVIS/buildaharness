import type { ExperienceStore, StrategyWeightKey, DecompositionEntry, RecoverySequenceEntry, ExperienceStoreData, ExternalContradictionInput } from '@buildaharness/harness'
import type { MemoryAdapter, ReminderStore, ReminderRecord, ILLMClient, TokenUsage, ChatMessage } from '@buildaharness/runtime'
import { explicitEnvOverride } from './layer-policy-wiring.js'
import { extractFactsFromTurn, migrateFact, tierForFact, isKnowledgeTier, type UserFact, type CandidateJudgement } from './fact-extraction.js'
import { checkForContradictions, semanticContradictionEnabled, type BeliefCandidate, type Corroboration } from './contradiction-checker.js'
import { DigestStore, writeDigest, endConversation, type SessionDigest } from './episodic-digest.js'
import { SUMMARY_HEADER } from './transcript-compaction.js'
import type { StatedFact, FactCategory, FactConfidence } from './turn-intent-classifier.js'
import { DEFAULT_MEMORY_WRITE_MODE, resolveWriteRoute, type MemoryWriteMode, type CrossTurnWriter } from './memory-governance.js'
import {
  memoryConsolidationEnabled, memoryRetentionDays, proposeConsolidationOps, findArchiveCandidates,
  type ConsolidationProposal, type ConsolidationState, type ConsolidationInput,
} from './memory-consolidation.js'
import type { VerifiedReviewOp } from './memory-reviewer.js'
import {
  DEFAULT_MEMORY_BUDGET_CHARS as CONTRACT_BUDGET_CHARS, AUDIT_LOG_KEEP as CONTRACT_AUDIT_LOG_KEEP, STORE_KEYS,
  TIER_PRIORITY as CONTRACT_TIER_PRIORITY,
} from './_memory-core-generated.js'

// Most-recent facts (and, separately, active reminders) injected into the system prompt each
// turn — a hard cap, not a summary, so this stays cheap even as the fact/reminder store grows.
export const FACT_CAP = 20

/** Default character budget for the rendered facts block under `AUDIT_MEMORY_BUDGETED_RENDER` (M0 measured ~195 tokens ≈ 800 chars for 20 facts; this leaves room for roughly 5x that). */
export const DEFAULT_MEMORY_BUDGET_CHARS: number = CONTRACT_BUDGET_CHARS

/** Append-only store of entries a keyed fact replaced (M1); the M2 audit log will subsume it. */
export const RETIRED_FACTS_KEY: string = STORE_KEYS.retired

/** M2: append-only change log with pre-images. Global, never cleared by `/new` (same convention as DURABLE_FACTS_KEY). */
export const AUDIT_LOG_KEY: string = STORE_KEYS.audit
/** M2/M5: highest audit `seq` already consolidated; the audit log never rotates away an entry newer than this. Absent until M5 writes it. */
export const CONSOLIDATION_STATE_KEY: string = STORE_KEYS.consolidationState
/** M2: how many audit entries rotation keeps (plus any newer than the consolidation watermark). */
export const AUDIT_LOG_KEEP: number = CONTRACT_AUDIT_LOG_KEEP
/**
 * M6: `/memory off` — when `{ off: true }`, nothing writes memory for this install (facts, pending
 * queue, and every later writer: M3 digests, M4 reviewer, M5 consolidation must check
 * `MemoryService.isMemoryOff()` first). Reads, forget, reject and undo still work: switching writes
 * off never traps the user's existing data. Global, never cleared by `/new`.
 */
export const MEMORY_OFF_KEY: string = STORE_KEYS.off

/** M5: staged proposals awaiting the user (`/memory consolidate`). Global, never cleared by `/new`. */
export const CONSOLIDATION_PROPOSALS_KEY: string = STORE_KEYS.proposals
/** M5: entries the user accepted an archive proposal for. Recoverable (`/memory archive restore`), never deleted by this phase. */
export const ARCHIVED_FACTS_KEY: string = STORE_KEYS.archive

export type AuditOp = 'add' | 'replace' | 'retire' | 'remove' | 'confirm' | 'reject' | 'undo' | 'archive' | 'restore'

export interface AuditEntry {
  seq: number
  at: string
  op: AuditOp
  /** `text|extractedAt` of the fact the entry concerns (M1's id convention). */
  factId: string
  /** Pre-image (redacted text only — the gate redacts before anything reaches the log). */
  before?: UserFact
  after?: UserFact
  /** Which store the change was made to. */
  store: 'durable' | 'pending' | 'rejected'
  writer: string
  turn: string
  /** Set on an `undo` entry: the seq it reverted. */
  undoes?: number
  /** M6: the user erased this fact from history (`/memory archive forget`); before/after were removed and the entry can no longer be undone. */
  erased?: boolean
  /** M5: entries applied together (one consolidation proposal) share a group; undoing one undoes the group. */
  group?: string
  /** M5: position the pre-image held in the durable list, so undo restores order exactly. */
  index?: number
}

type AuditDraft = Omit<AuditEntry, 'seq' | 'at'>

// Deliberately NOT suffixed with a sessionId — clearSession() only deletes `facts:${sessionId}`,
// so a fact stored here (see recordFacts()) survives /new the same way reminderStore/
// experienceStore already do (see AssistantSession.clearSession's doc comment on why those stay
// untouched). This personal-assistant is single-user/single-install, so one global durable-fact
// list (not per-session) is the right shape — matching reminderStore/experienceStore's own
// precedent.
export const DURABLE_FACTS_KEY: string = STORE_KEYS.durable

/**
 * Global, never cleared by `/new` — same retention shape as DURABLE_FACTS_KEY (a pending fact
 * shouldn't vanish just because the session changed). Phase 3 of
 * the internal plan: a `model_inferred` fact
 * that reached `durable: true, confidence: 'medium'` lands here instead of being silently
 * promoted or silently dropped — see `recordFacts()`'s promotion policy and
 * `confirmPendingFact()`/`rejectPendingFact()` below.
 */
export const PENDING_CONFIRMATION_KEY: string = STORE_KEYS.pending

/**
 * Global, never cleared by `/new`. Holds facts removed from `facts:${sessionId}`/
 * PENDING_CONFIRMATION_KEY either by an entry-time retraction (a later statement contradicts an
 * unconfirmed guess — see `recordFacts()`) or by an explicit `/memory reject`. Rejected facts are
 * remembered, not blacklisted: the entry-time check compares new statements against this pool
 * too, so a matching restatement can re-enter PENDING_CONFIRMATION_KEY tagged
 * `previouslyRejected` instead of being silently re-asked forever or silently refused forever.
 */
export const REJECTED_FACTS_KEY: string = STORE_KEYS.rejected

/** Bound on how many learned decompositions/recovery sequences `getMemorySummary()` includes — see MemorySummary's doc comment. */
export const MEMORY_SUMMARY_PREVIEW_LIMIT = 20

/** A `model_inferred` fact sitting in PENDING_CONFIRMATION_KEY, awaiting `/memory confirm`/`/memory reject`. */
export interface PendingFact extends UserFact {
  category: FactCategory
  /** True when this exact fact previously lived in REJECTED_FACTS_KEY and was corroborated back in by a later, differently-phrased restatement — see `recordFacts()`'s corroboration handling. `/memory` surfaces this so the user sees the prior rejection instead of the fact looking brand new. */
  previouslyRejected?: boolean
  /** M4: `retire` marks a reviewer proposal to retire an existing durable fact (`retireTargetId` = its `text|extractedAt`) rather than add one; confirming it retires, never adds. */
  proposedOp?: 'retire'
  retireTargetId?: string
  /** M4: who staged this entry and what the semantic verifier said, shown in `/memory`. */
  stagedBy?: 'reviewer'
  verification?: 'supported' | 'unsupported' | 'not_checked'
}

/** What `stageReviewerOps()` did with a batch, for tests and `/memory` diagnostics. */
export interface StageReviewerResult {
  staged: number
  /** Unsupported by the verifier, kept session-scoped only. */
  sessionScoped: number
  /** Refused by a plain-code gate (retire of a user_asserted fact, unknown target) or dropped by the write gate. */
  refused: number
  /** The signal fired before the write: nothing was written. */
  aborted: boolean
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
  /** M3: every stored episodic digest, unbounded and regardless of retention. */
  digests?: SessionDigest[]
  /** M6: facts a keyed update replaced (and, after M5, archived) — covered by export so nothing the assistant holds about the user is missing from it. */
  retired?: UserFact[]
  /** M6: the audit log (redacted text only, by the M2 gate). Empty when the audit-log flag is off. */
  audit?: AuditEntry[]
  /** M6: governance state at export time. */
  governance?: { mode: MemoryWriteMode; off: boolean }
}

/** M6: what the facts block of the most recent turn actually contained ("Why?" panel, `/why`). */
export interface MemoryInjection {
  /** Facts placed in the prompt, in render order. */
  facts: { text: string; unconfirmed: boolean }[]
  /** In-scope live facts that did NOT make it into the prompt (budget or the legacy 20-fact cap). */
  notShown: number
}

/** M6: store-health snapshot for `/doctor` and the memory panel. Read-only; never touches usage counters. */
export interface MemoryStatus {
  mode: MemoryWriteMode
  off: boolean
  budgetedRender: boolean
  budgetChars: number
  /** Characters the in-scope live facts would need if all were rendered. */
  storeChars: number
  liveFacts: number
  pending: number
  flaggedPending: number
  retired: number
  auditEnabled: boolean
  auditEntries: number
  /** Highest audit seq already consolidated (M5 writes `memory:consolidation-state`); undefined until then. */
  lastConsolidatedSeq?: number
  lastConsolidationAt?: string
  lastInjection?: MemoryInjection
}

/** M6 extension point for M5: what a consolidation run reports back to `/memory consolidate`. */
export type ConsolidationOutcome = { status: 'done'; message: string } | { status: 'nothing_to_do'; message: string }
/** M5 registers one of these via `MemoryService.registerConsolidator()`; it proposes through `submit` so governance, the gate and the audit log apply. */
export type MemoryConsolidator = (ctx: { submit: MemoryService['submitCandidate']; sessionId: string }) => Promise<ConsolidationOutcome>

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

/** Live keyed durable facts as `{key, text}`, newest first, one per key, capped; empty when keyed supersession is off. */
function knownKeysOf(durable: UserFact[], limit = 30): { key: string; text: string }[] {
  if (!memoryBudgetedRenderEnabled()) return []
  const seen = new Set<string>()
  const out: { key: string; text: string }[] = []
  for (const f of [...durable].reverse()) {
    if (!f.key || f.retiredAt || seen.has(f.key)) continue
    seen.add(f.key)
    out.push({ key: f.key, text: f.text })
    if (out.length >= limit) break
  }
  return out
}

/**
 * `AUDIT_MEMORY_BUDGETED_RENDER` gate (M1 of the agent memory framework plan). Gates budgeted/
 * priority rendering, keyed supersession and usage fields. `=0`/`off` restores `slice(-FACT_CAP)`
 * and append-only writes. Default **ON** (M7 corrections scenario, 2 of 2 seeds: lexicalOff FAIL, memoryM12On PASS);
 * `0`/`false`/`off`/`no`/`disabled` restores the legacy path. Read fresh each call; this is the one read point.
 */
export function memoryBudgetedRenderEnabled(env?: Record<string, string | undefined>): boolean {
  const source = env ?? (typeof process !== 'undefined' ? process.env : {})
  const raw = String(source.AUDIT_MEMORY_BUDGETED_RENDER ?? '').trim().toLowerCase()
  return !['0', 'false', 'off', 'no', 'disabled'].includes(raw)
}

/** `AUDIT_MEMORY_WRITE_GATE`: semantic secret redaction + injection judgement before promotion, failing closed. Default OFF until the real-model pilot (plan defaults rule); `1/true/on/yes/enabled` enables. */
export function memoryWriteGateEnabled(env?: Record<string, string | undefined>): boolean {
  const source = env ?? (typeof process !== 'undefined' ? process.env : {})
  return ['1', 'true', 'on', 'yes', 'enabled'].includes(String(source.AUDIT_MEMORY_WRITE_GATE ?? '').trim().toLowerCase())
}

/** `AUDIT_MEMORY_AUDIT_LOG`: append-only `memory:audit`. Default OFF until the pilot; `=0` restores the unlogged path. */
export function memoryAuditLogEnabled(env?: Record<string, string | undefined>): boolean {
  const source = env ?? (typeof process !== 'undefined' ? process.env : {})
  return ['1', 'true', 'on', 'yes', 'enabled'].includes(String(source.AUDIT_MEMORY_AUDIT_LOG ?? '').trim().toLowerCase())
}

/** Outcome of `admitCandidate()` for one candidate. `session` = kept session-scoped only, never durable or pending. */
export interface AdmitDecision {
  action: 'admit' | 'session' | 'flag' | 'drop'
  fact: UserFact
}

/**
 * The single judgement step every writer's candidate passes through before it can be promoted (M2).
 * Pure: the judgements were produced by the same LLM call that produced the fact. Always strips the
 * transient `judgement`. With the gate off the candidate is returned unchanged (`admit`). With it on,
 * for a `model_inferred` candidate: a missing judgement fails closed (`session`, durable bit cleared);
 * a secret is replaced by the model's secret-free text, or dropped when the claim is the secret; an
 * instruction-shaped claim is `flag`ged for the pending queue. A non-`user` origin never promotes.
 */
export function admitCandidate(candidate: UserFact, gateOn: boolean): AdmitDecision {
  const { judgement, ...bare } = candidate
  let fact: UserFact = { origin: 'user', ...bare }
  if (!gateOn) return { action: 'admit', fact: bare }
  // M3: a non-user origin (the session digest) is judged too, so a secret is redacted before it is
  // stored, but it can never be promoted: a clean result is `session`, not `admit`.
  const nonUser = fact.origin !== 'user'
  if (!nonUser && fact.source !== 'model_inferred') return { action: 'admit', fact }
  const j: CandidateJudgement = judgement ?? {}
  if (typeof j.containsSecret !== 'boolean' || typeof j.looksLikeInstruction !== 'boolean') {
    return { action: 'session', fact: { ...fact, durable: false } }
  }
  if (j.containsSecret) {
    const redacted = (j.redactedText ?? '').trim()
    if (!redacted) return { action: 'drop', fact }
    fact = { ...fact, text: redacted, evidence: undefined }
  }
  if (j.looksLikeInstruction) return { action: 'flag', fact: { ...fact, flagged: true } }
  return nonUser ? { action: 'session', fact: { ...fact, durable: false } } : { action: 'admit', fact }
}

/** Removes verbatim copies of the injected memory block from text bound for candidate extraction (feedback-loop prevention). Structural: it removes the exact block this service rendered, not a pattern. */
export function excludeInjectedBlock(text: string, injectedBlock: string): string {
  const block = injectedBlock.trim()
  return block ? text.split(block).join('') : text
}

const TIER_PRIORITY: Record<string, number> = CONTRACT_TIER_PRIORITY

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
export function buildTurnFacts(sessionId: string, userMessage: string, statedFacts: StatedFact[], policyEnabled: boolean = true, now: () => string = () => new Date().toISOString()): UserFact[] {
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
        extractedAt: now(),
        sourceTurn: `turn:${sessionId}`,
        source: 'model_inferred',
        durable: fact.durable,
        confidence: fact.confidence,
        category: fact.category,
        ...(fact.key ? { key: fact.key } : {}),
        origin: 'user' as const,
        ...(fact.evidence ? { evidence: fact.evidence } : {}),
        judgement: { containsSecret: fact.containsSecret, redactedText: fact.redactedText, looksLikeInstruction: fact.looksLikeInstruction },
      }))
    : []
  return mergeTurnFacts(lexicalFacts, llmFacts)
}

/** Text-and-timestamp identity match — the same (text, extractedAt) pair a fact was captured with, used to find-and-remove/find-and-update one specific entry in a UserFact[] without a dedicated id field. */
function sameFact(a: UserFact, b: UserFact): boolean {
  return a.text === b.text && a.extractedAt === b.extractedAt
}

function proposalSignature(kind: string, ids: string[], text?: string): string {
  return `${kind}|${[...ids].sort().join('||')}|${text ?? ''}`
}

function factId(f: UserFact): string {
  return `${f.text}|${f.extractedAt}`
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
function isUnconfirmed(f: UserFact): boolean {
  return f.source === 'model_inferred' && (f.confidence === 'medium' || f.confidence === 'low')
}

function factLine(f: UserFact): string {
  return `- ${f.text}${isUnconfirmed(f) ? ' (unconfirmed)' : ''}`
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
    /** M6: governance mode (config `memoryWriteMode`), read through a getter like the others so a live change applies on the next write. Resolved here and nowhere else. */
    private readonly writeMode: () => MemoryWriteMode = () => DEFAULT_MEMORY_WRITE_MODE,
    /** Time source for every timestamp this service writes (extractedAt of stated facts, audit `at`, retiredAt, usage flush). Injectable so the cross-runtime conformance fixtures are byte-reproducible; default is wall-clock, i.e. no behaviour change. */
    private readonly clock: () => string = () => new Date().toISOString(),
  ) {}

  private consolidator?: MemoryConsolidator
  private lastInjection?: MemoryInjection

  /** `/memory off` state — M3/M4/M5 writers must call this before any write or LLM spend. */
  async isMemoryOff(): Promise<boolean> {
    return ((await this.memory.get(MEMORY_OFF_KEY)) as { off?: boolean } | undefined)?.off === true
  }

  async setMemoryOff(off: boolean): Promise<void> {
    await this.memory.set(MEMORY_OFF_KEY, { off, at: this.clock() })
  }

  /** M5 extension point (not built here): until a consolidator is registered `/memory consolidate` says so instead of pretending. */
  registerConsolidator(fn: MemoryConsolidator | undefined): void {
    this.consolidator = fn
  }

  async consolidate(sessionId: string): Promise<ConsolidationOutcome | { status: 'unavailable' | 'blocked'; message: string }> {
    if (await this.isMemoryOff()) return { status: 'blocked', message: 'Memory writes are off (/memory on to resume).' }
    if (!this.consolidator) return { status: 'unavailable', message: 'Consolidation is not available in this build.' }
    return this.consolidator({ submit: (w, f, s) => this.submitCandidate(w, f, s), sessionId })
  }

  /**
   * M6 extension point for M3 (digest), M4 (reviewer) and M5 (consolidation) writers: the ONE way a
   * cross-turn candidate enters memory. It applies, in order: `/memory off`, the M2 gate
   * (`admitCandidate`: redaction, injection flag, fail-closed judgement, non-user origin), then the
   * governance route for `memoryWriteMode` (`resolveWriteRoute`), and writes through the same
   * single durable commit point / pending queue / audit log as every other writer. Add-only: removal
   * and retirement stay with the user or a staged proposal.
   */
  async submitCandidate(writer: CrossTurnWriter, candidate: UserFact, sessionId: string, opts: { pendingExtras?: Partial<PendingFact>; forceGate?: boolean } = {}): Promise<{ route: 'durable' | 'pending' | 'session' | 'dropped' | 'blocked'; fact?: UserFact }> {
    if (await this.isMemoryOff()) return { route: 'blocked' }
    const decision = admitCandidate(candidate, opts.forceGate === true || memoryWriteGateEnabled())
    if (decision.action === 'drop') return { route: 'dropped' }
    const fact = decision.fact
    const route = decision.action === 'flag' ? 'pending' : decision.action === 'session' ? 'session' : resolveWriteRoute(this.writeMode(), writer, fact)
    if (route === 'durable') {
      const durable = (((await this.memory.get(DURABLE_FACTS_KEY)) as UserFact[] | undefined) ?? []).map(migrateFact)
      await this.commitDurable([...durable, fact], [{ op: 'add', factId: factId(fact), after: fact, store: 'durable', writer, turn: sessionId }])
    } else if (route === 'pending') {
      const pending = ((await this.memory.get(PENDING_CONFIRMATION_KEY)) as PendingFact[] | undefined) ?? []
      const queued: PendingFact = { ...fact, category: fact.category ?? 'other', ...opts.pendingExtras }
      await this.memory.set(PENDING_CONFIRMATION_KEY, [...pending, queued])
      await this.appendAudit([{ op: 'add', factId: factId(fact), after: queued, store: 'pending', writer, turn: sessionId }])
    } else {
      const session = (((await this.memory.get(`facts:${sessionId}`)) as UserFact[] | undefined) ?? []).map(migrateFact)
      await this.memory.set(`facts:${sessionId}`, [...session, { ...fact, durable: false }])
    }
    return { route, fact }
  }

  /** Facts rendered since the last flush, keyed by `text|extractedAt`; written lazily so loadFacts() stays read-only (M1). */
  private pendingInjections = new Map<string, number>()
  /** Number of in-scope facts the last budgeted render could not show — `/memory` says "N facts not shown this turn". */
  lastDroppedCount = 0
  /** The facts block most recently rendered into a prompt; excluded verbatim from candidate extraction (M2 feedback-loop prevention). */
  private lastInjectedBlock = ''
  private digestStoreInstance?: DigestStore
  /** Incremented whenever recordFacts() or stageReviewerOps() changes any memory store; the M4 trigger compares it before and after a turn. */
  writeCount = 0

  /** The facts block most recently injected into a prompt (what the M4 reviewer must strip from its input). */
  getInjectedBlock(): string { return this.lastInjectedBlock }

  /**
   * Keys of the live durable facts, with their text, for the classifier prompt (M1 key stability:
   * the model reuses a stored key for a new value of the same attribute instead of inventing a
   * variant that would miss supersession). Newest first, capped so the prompt stays small. Empty
   * when keyed supersession is off.
   */
  async getKnownFactKeys(limit = 30): Promise<{ key: string; text: string }[]> {
    return knownKeysOf(await this.getDurableFacts(), limit)
  }

  /** Durable facts in stored order — the list a reviewer `retire` op's `targetId` indexes into. */
  async getDurableFacts(): Promise<UserFact[]> {
    return (((await this.memory.get(DURABLE_FACTS_KEY)) as UserFact[] | undefined) ?? []).map(migrateFact)
  }

  /**
   * M4: stages the post-turn reviewer's operations. Per decision D1 nothing here reaches durable memory: surviving ops
   * wait in the pending queue with their evidence (shown by `/memory`). Plain-code gates, no language judgement:
   * a `retire` of a `user_asserted` fact (or of an unknown target) is refused; every op passes `admitCandidate()`;
   * an op the verifier called unsupported is kept session-scoped only. All writes happen after the abort check, in one
   * batch per store, so an abort leaves no partial write. `durableSnapshot` is the list the reviewer's `targetId`s index.
   */
  async stageReviewerOps(sessionId: string, ops: readonly VerifiedReviewOp[], durableSnapshot: readonly UserFact[], signal?: AbortSignal): Promise<StageReviewerResult> {
    const result: StageReviewerResult = { staged: 0, sessionScoped: 0, refused: 0, aborted: false }
    // M6: `/memory off` stops every writer, including this one.
    if (await this.isMemoryOff()) return { ...result, refused: ops.length }
    const gateOn = memoryWriteGateEnabled()
    const project = this.currentProject()
    const turn = `reviewer:${sessionId}`
    const now = this.clock()
    const toStage: PendingFact[] = []
    const toSession: UserFact[] = []
    // submitCandidate re-runs the (pure) gate itself, so it is handed the raw candidate with its judgement still attached, not the already-admitted fact.
    const raw = new Map<PendingFact | UserFact, UserFact>()
    const base = { extractedAt: now, sourceTurn: turn, source: 'model_inferred' as const, origin: 'user' as const }
    for (const op of ops) {
      if (op.kind === 'retire') {
        const target = typeof op.targetId === 'number' ? durableSnapshot[op.targetId] : undefined
        // Plain structure, not language: the user's own words are never retired by a model's say-so.
        if (!target || target.source === 'user_asserted') { result.refused++; continue }
        if (op.verification === 'unsupported') { result.refused++; continue }
        const proposal: UserFact = { ...base, text: target.text, durable: true, confidence: 'medium', category: target.category ?? 'other', project: target.project, evidence: op.evidence, judgement: { containsSecret: false, looksLikeInstruction: false } }
        const decision = admitCandidate(proposal, gateOn)
        if (decision.action !== 'admit') { result.refused++; continue }
        toStage.push({ ...decision.fact, category: decision.fact.category ?? 'other', proposedOp: 'retire', retireTargetId: factId(target), stagedBy: 'reviewer', verification: op.verification })
        continue
      }
      if (op.kind !== 'upsert' || !op.text) continue
      const candidate: UserFact = { ...base, text: op.text, durable: true, confidence: 'medium', category: op.category ?? 'other', key: op.key, evidence: op.evidence, judgement: op.judgement }
      const decision = admitCandidate(candidate, gateOn)
      if (decision.action === 'drop') { result.refused++; continue }
      const withProject = (f: UserFact): UserFact => (f.category === 'project' && project ? { ...f, project } : f)
      const fact: UserFact = withProject(decision.fact)
      // Unsupported (or flagged-then-unsupported) never enters the queue; a flagged one is queued marked so the user sees it.
      if (op.verification === 'unsupported' && decision.action !== 'flag') {
        const lowFact = { ...fact, durable: false, confidence: 'low' as const }
        toSession.push(lowFact)
        raw.set(lowFact, withProject({ ...candidate, durable: false, confidence: 'low' }))
        continue
      }
      if (op.verification === 'unsupported') { result.refused++; continue }
      if (decision.action === 'session') { const sf = { ...fact, durable: false }; toSession.push(sf); raw.set(sf, withProject({ ...candidate, durable: false })); continue }
      const staged: PendingFact = { ...fact, category: fact.category ?? 'other', stagedBy: 'reviewer', verification: op.verification }
      toStage.push(staged)
      raw.set(staged, withProject(candidate))
    }
    if (signal?.aborted) return { ...result, aborted: true }

    if (toStage.length > 0) {
      const pending = ((await this.memory.get(PENDING_CONFIRMATION_KEY)) as PendingFact[] | undefined) ?? []
      const durable = durableSnapshot
      const fresh = toStage.filter((f) => !pending.some((p) => p.text === f.text && p.proposedOp === f.proposedOp) && (f.proposedOp === 'retire' || !durable.some((d) => d.text === f.text)))
      result.refused += toStage.length - fresh.length
      // A retire proposal is never an add: it is always queued for the user (nothing is auto-deleted), whatever the write mode.
      const retires = fresh.filter((f) => f.proposedOp === 'retire')
      if (retires.length > 0 && !signal?.aborted) {
        await this.memory.set(PENDING_CONFIRMATION_KEY, [...pending, ...retires])
        await this.appendAudit(retires.map((f) => ({ op: 'add' as const, factId: factId(f), after: f, store: 'pending' as const, writer: 'reviewer', turn })))
        result.staged += retires.length
      }
      // M6: upserts enter through submitCandidate, so `memoryWriteMode` and the gate decide the route (staged/user_only: pending queue).
      for (const f of fresh.filter((x) => x.proposedOp !== 'retire')) {
        if (signal?.aborted) return { ...result, aborted: true }
        const { stagedBy, verification } = f
        const out = await this.submitCandidate('reviewer', raw.get(f) ?? f, sessionId, { pendingExtras: { stagedBy, verification } })
        if (out.route === 'pending' || out.route === 'durable') result.staged++
        else if (out.route === 'session') result.sessionScoped++
        else result.refused++
      }
    }
    if (toSession.length > 0) {
      for (const f of toSession) {
        if (signal?.aborted) break
        const out = await this.submitCandidate('reviewer', raw.get(f) ?? f, sessionId)
        if (out.route === 'session') result.sessionScoped++
        else if (out.route === 'blocked' || out.route === 'dropped') result.refused++
        else result.staged++
      }
    }
    if (result.staged + result.sessionScoped > 0) this.writeCount++
    return result
  }

  /**
   * M2: the ONLY place `DURABLE_FACTS_KEY` is written. Every add, replace, retire, remove, confirm
   * and usage-flush goes through here, so a new writer cannot skip the audit log. A structural test
   * (memory-write-gate.test.ts) asserts this is the only call in the file that writes the durable key.
   */
  private async commitDurable(next: UserFact[], drafts: AuditDraft[] = []): Promise<void> {
    await this.memory.set(DURABLE_FACTS_KEY, next)
    await this.appendAudit(drafts)
  }

  private async appendAudit(drafts: AuditDraft[]): Promise<void> {
    if (drafts.length === 0 || !memoryAuditLogEnabled()) return
    const log = ((await this.memory.get(AUDIT_LOG_KEY)) as AuditEntry[] | undefined) ?? []
    let seq = log.length > 0 ? log[log.length - 1].seq : 0
    const at = this.clock()
    let next = [...log, ...drafts.map((d) => ({ ...d, seq: ++seq, at }))]
    if (next.length > AUDIT_LOG_KEEP) {
      const watermark = ((await this.memory.get(CONSOLIDATION_STATE_KEY)) as { lastSeq?: number } | undefined)?.lastSeq ?? 0
      const cutoff = next.length - AUDIT_LOG_KEEP
      next = next.filter((e, i) => i >= cutoff || e.seq > watermark)
    }
    await this.memory.set(AUDIT_LOG_KEY, next)
  }

  /** `/memory history` — newest last; the last `limit` entries. */
  async getAuditLog(limit = 20): Promise<AuditEntry[]> {
    const log = ((await this.memory.get(AUDIT_LOG_KEY)) as AuditEntry[] | undefined) ?? []
    return log.slice(-limit)
  }

  /**
   * `/memory undo <seq>` — restores the pre-image of one audit entry exactly (and removes what that
   * entry added), then appends an `undo` entry. An entry can be undone once. Returns a message for
   * the caller, or undefined when the seq is unknown.
   */
  async undoAudit(seq: number, sessionId = 'undo'): Promise<{ ok: boolean; message: string }> {
    const log = ((await this.memory.get(AUDIT_LOG_KEY)) as AuditEntry[] | undefined) ?? []
    const entry = log.find((e) => e.seq === seq)
    if (!entry) return { ok: false, message: `No audit entry #${seq}.` }
    if (entry.op === 'undo') return { ok: false, message: `Entry #${seq} is itself an undo.` }
    if (log.some((e) => e.undoes === seq)) return { ok: false, message: `Entry #${seq} was already undone.` }
    if (entry.erased) return { ok: false, message: `Entry #${seq} was erased from history and cannot be restored.` }
    if (!entry.group) {
      await this.undoEntry(entry, sessionId)
      return { ok: true, message: `Undid #${seq} (${entry.op}): ${(entry.before ?? entry.after)?.text ?? entry.factId}` }
    }
    // M5: a consolidation change is several entries; undo reverts all of them, newest first, so the store comes back exactly.
    const members = log.filter((e) => e.group === entry.group && e.op !== 'undo' && !log.some((u) => u.undoes === e.seq)).sort((x, y) => y.seq - x.seq)
    for (const m of members) await this.undoEntry(m, sessionId)
    return { ok: true, message: `Undid #${seq} and ${members.length - 1} related change(s) (${entry.group}).` }
  }

  /** Undo of the change that created a side store must leave it absent again, not an empty array (exact restoration). */
  private async setOrClear(key: string, list: UserFact[]): Promise<void> {
    if (list.length === 0) await this.memory.delete(key)
    else await this.memory.set(key, list)
  }

  private async undoEntry(entry: AuditEntry, sessionId: string): Promise<void> {
    const strip = (f: UserFact): UserFact => { const { retiredAt: _r, ...rest } = f; return rest }
    const withoutFact = <T extends UserFact>(list: T[], f?: UserFact): T[] => (f ? list.filter((x) => !sameFact(x, f)) : list)
    const insertAt = (list: UserFact[], f: UserFact, index?: number): UserFact[] => {
      if (index === undefined || index < 0 || index > list.length) return [...list, f]
      return [...list.slice(0, index), f, ...list.slice(index)]
    }
    const durable = (((await this.memory.get(DURABLE_FACTS_KEY)) as UserFact[] | undefined) ?? []).map(migrateFact)
    const pending = ((await this.memory.get(PENDING_CONFIRMATION_KEY)) as PendingFact[] | undefined) ?? []
    let nextDurable = durable
    if (entry.store === 'durable') {
      nextDurable = withoutFact(durable, entry.after)
      if (entry.op === 'restore') {
        // Undoing a restore puts the entry back in the archive.
        const archive = ((await this.memory.get(ARCHIVED_FACTS_KEY)) as UserFact[] | undefined) ?? []
        if (entry.before) await this.memory.set(ARCHIVED_FACTS_KEY, [...withoutFact(archive, entry.before), entry.before])
      } else if (entry.before && entry.op !== 'confirm') {
        nextDurable = insertAt(withoutFact(nextDurable, entry.before), strip(entry.before), entry.index)
      }
      if (entry.op === 'replace' || entry.op === 'retire') {
        const retired = ((await this.memory.get(RETIRED_FACTS_KEY)) as UserFact[] | undefined) ?? []
        await this.setOrClear(RETIRED_FACTS_KEY, withoutFact(retired, entry.before))
      }
      if (entry.op === 'archive') {
        const archive = ((await this.memory.get(ARCHIVED_FACTS_KEY)) as UserFact[] | undefined) ?? []
        await this.setOrClear(ARCHIVED_FACTS_KEY, withoutFact(archive, entry.before))
      }
      if (entry.op === 'confirm' && entry.before) await this.memory.set(PENDING_CONFIRMATION_KEY, [...withoutFact(pending, entry.before), entry.before])
    } else if (entry.store === 'pending') {
      const restored = entry.before ? [...withoutFact(pending, entry.before), entry.before as PendingFact] : withoutFact(pending, entry.after)
      await this.memory.set(PENDING_CONFIRMATION_KEY, restored)
      if (entry.op === 'reject' && entry.before) {
        const rejected = ((await this.memory.get(REJECTED_FACTS_KEY)) as RejectedFact[] | undefined) ?? []
        await this.memory.set(REJECTED_FACTS_KEY, rejected.filter((r) => r.text !== entry.before!.text))
      }
    }
    const draft: AuditDraft = { op: 'undo', factId: entry.factId, before: entry.after, after: entry.before, store: entry.store, writer: 'undo', turn: sessionId, undoes: entry.seq }
    if (entry.store === 'durable') await this.commitDurable(nextDurable, [draft])
    else await this.appendAudit([draft])
  }

  /**
   * Durable + session facts for `sessionId`, plus the ready-to-splice system-prompt block — see
   * runTurn's former factsBlock. `facts` is the full inventory, unfiltered by project — `/memory`
   * (getMemorySummary) needs to show and let the user forget a fact regardless of which project is
   * currently active. `factsBlock` — what the model actually sees this turn — filters to
   * global-or-current-project only, so an unrelated project's facts don't leak into context (see
   * UserFact.project's doc comment).
   */
  async loadFacts(sessionId: string, opts: { record?: boolean } = {}): Promise<{ facts: UserFact[]; factsBlock: string; knownFactKeys: { key: string; text: string }[] }> {
    // `record: false` (M6) is for read-only views (/memory, status): looking at memory must not count as the model having seen it, nor replace what the last turn injected.
    const record = opts.record !== false
    const sessionFacts = (((await this.memory.get(`facts:${sessionId}`)) as UserFact[] | undefined) ?? []).map(migrateFact)
    const durableFacts = (((await this.memory.get(DURABLE_FACTS_KEY)) as UserFact[] | undefined) ?? []).map(migrateFact)
    const facts = mergeFacts(durableFacts, sessionFacts)
    // Computed here, from the read above, so the turn needs no extra await for the classifier's key context.
    const knownFactKeys = knownKeysOf(durableFacts)
    const project = this.currentProject()
    const inScope = facts.filter((f) => f.project === undefined || f.project === project)
    if (memoryBudgetedRenderEnabled()) {
      const rendered = renderFactsBlock(inScope, this.memoryBudgetChars())
      if (!record) return { facts, factsBlock: rendered.block, knownFactKeys }
      this.lastDroppedCount = rendered.droppedCount
      this.lastInjectedBlock = rendered.block
      this.lastInjection = { facts: rendered.shown.map((f) => ({ text: f.text, unconfirmed: isUnconfirmed(f) })), notShown: rendered.droppedCount }
      for (const f of rendered.shown) {
        const id = `${f.text}|${f.extractedAt}`
        this.pendingInjections.set(id, (this.pendingInjections.get(id) ?? 0) + 1)
      }
      return { facts, factsBlock: rendered.block, knownFactKeys }
    }
    const shown = inScope.slice(-FACT_CAP)
    const factsBlock = inScope.length > 0
      ? `\nKnown facts about the user:\n${shown.map(factLine).join('\n')}`
      : ''
    if (record) {
      this.lastInjectedBlock = factsBlock
      this.lastInjection = { facts: shown.map((f) => ({ text: f.text, unconfirmed: isUnconfirmed(f) })), notShown: inScope.length - shown.length }
    }
    return { facts, factsBlock, knownFactKeys }
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
  async forgetFact(index: number, sessionId: string, erase = false): Promise<UserFact | undefined> {
    const sessionFacts = (((await this.memory.get(`facts:${sessionId}`)) as UserFact[] | undefined) ?? []).map(migrateFact)
    const durableFacts = (((await this.memory.get(DURABLE_FACTS_KEY)) as UserFact[] | undefined) ?? []).map(migrateFact)
    const merged = mergeFacts(durableFacts, sessionFacts)
    if (index < 0 || index >= merged.length) return undefined
    const fact = merged[index]
    const remainingDurable = durableFacts.filter((f) => !sameFact(f, fact))
    const remainingSession = sessionFacts.filter((f) => !sameFact(f, fact))
    if (remainingDurable.length !== durableFacts.length) {
      await this.commitDurable(remainingDurable, [{ op: 'remove', factId: factId(fact), before: fact, index: durableFacts.findIndex((f) => sameFact(f, fact)), store: 'durable', writer: 'forget', turn: sessionId }])
    }
    if (remainingSession.length !== sessionFacts.length) await this.memory.set(`facts:${sessionId}`, remainingSession)
    // `erase`: also drop the fact's text from the audit log, so `/memory history` and `/memory undo` can no longer bring it back.
    if (erase) await this.eraseFromAuditLog(fact)
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
   * neither pass finds anything. Facts routed to durable by `resolveWriteRoute()` (memory-governance.ts; see its doc
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
    // M6 `/memory off`: no writes of any kind (not even usage counters) for this install.
    if (await this.isMemoryOff()) return { contradictions: [], corroborations: [] }
    const project = this.currentProject()
    const gateOn = memoryWriteGateEnabled()
    const mode = this.writeMode()
    const flaggedForPending: UserFact[] = []
    const newFacts: UserFact[] = []
    for (const candidate of buildTurnFacts(sessionId, gateOn ? excludeInjectedBlock(userMessage, this.lastInjectedBlock) : userMessage, statedFacts, true, this.clock)) {
      const decision = admitCandidate(candidate, gateOn)
      if (decision.action === 'drop') continue
      const f = decision.fact.category === 'project' && project ? { ...decision.fact, project } : decision.fact
      if (decision.action === 'flag') flaggedForPending.push(f)
      else newFacts.push(f)
    }
    // A no-op turn (neither pass found anything) must stay a true no-op — no store touched at
    // all, not even an empty-array write — matching every reader that treats an absent key the
    // same as an empty one, and the "records nothing" test's expectation that the key itself
    // stays unset until a fact is actually captured.
    if (memoryBudgetedRenderEnabled()) await this.flushInjectionUsage(sessionId)
    if (newFacts.length === 0 && flaggedForPending.length === 0) return { contradictions: [], corroborations: [] }

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
    const audits: AuditDraft[] = []
    const auditPending: AuditDraft[] = []
    const turn = sessionId

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
      rejectedFacts = [...rejectedFacts, { text: fact.text, rejectedAt: this.clock(), rejectionSource: 'auto_retracted' }]
      pendingChanged = true
      rejectedChanged = true
      auditPending.push({ op: 'reject', factId: factId(fact), before: fact, store: 'pending', writer: 'recordFacts:retract', turn })
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
        // user_only: corroboration never lifts a guess past "waiting for the user" — it stays queued as medium.
        if (next === 'high' && resolveWriteRoute(mode, 'in_turn', { ...target, confidence: 'high' }) === 'pending') continue
        const upgraded: UserFact = { ...target, confidence: next }
        sessionFacts = sessionFacts.map((f) => (sameFact(f, target) ? upgraded : f))
        pendingFacts = pendingFacts.filter((f) => !sameFact(f, target))
        if (next === 'medium') {
          pendingFacts = [...pendingFacts, { ...upgraded, category: upgraded.category ?? 'other' }]
          pendingChanged = true
        } else if (next === 'high' && resolveWriteRoute(mode, 'in_turn', upgraded) === 'durable') {
          durableFacts = [...durableFacts, upgraded]
          durableChanged = true
          pendingChanged = true
          audits.push({ op: 'add', factId: factId(upgraded), after: upgraded, store: 'durable', writer: 'recordFacts:corroborate', turn })
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
            extractedAt: this.clock(),
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
    // M8: audit entries record the position the pre-image held in the durable list at the start of this call, so undo restores order exactly (same rule as the Python twin).
    const durableAtStart = [...durableFacts]
    const indexAtStart = (f: UserFact): number => durableAtStart.findIndex((d) => sameFact(d, f))
    for (let fact of newFacts) {
      const route = resolveWriteRoute(mode, 'in_turn', fact)
      // A candidate that must wait for the user (pending route) never retires what is already stored: the old value stays live until the user confirms the new one.
      if (memoryBudgetedRenderEnabled() && fact.key && route !== 'pending') {
        const key = fact.key
        const sameKey = (f: UserFact): boolean => f.key === key && (f.project ?? '') === (fact.project ?? '')
        const priorLive = [...durableFacts, ...sessionFacts].filter(sameKey)
        // Restating the same value is a no-op, not a new entry.
        if (priorLive.some((f) => f.text === fact.text)) continue
        if (priorLive.length > 0) {
          const retiredAt = this.clock()
          const seen = new Set<string>()
          for (const old of priorLive) {
            const id = factId(old)
            if (seen.has(id)) continue
            seen.add(id)
            retiredNow.push({ ...old, retiredAt })
            if (durableFacts.some((d) => sameFact(d, old))) {
              const isLast = old === priorLive[priorLive.length - 1]
              audits.push({ op: isLast ? 'replace' : 'retire', factId: id, before: old, ...(isLast ? { after: { ...fact, supersedes: old.text } } : {}), index: indexAtStart(old), store: 'durable', writer: 'recordFacts:supersede', turn })
            }
          }
          if (durableFacts.some(sameKey)) { durableFacts = durableFacts.filter((f) => !sameKey(f)); durableChanged = true }
          sessionFacts = sessionFacts.filter((f) => !sameKey(f))
          fact = { ...fact, supersedes: priorLive[priorLive.length - 1].text }
        }
      }
      // A high-confidence candidate held back by user_only is shown to the model as unconfirmed, like any other pending guess.
      sessionFacts = [...sessionFacts, route === 'pending' && fact.confidence === 'high' ? { ...fact, confidence: 'medium' } : fact]
      if (route === 'durable') {
        durableFacts = [...durableFacts, fact]
        durableChanged = true
        if (!audits.some((a) => a.op === 'replace' && a.after && sameFact(a.after, fact))) {
          audits.push({ op: 'add', factId: factId(fact), after: fact, store: 'durable', writer: 'recordFacts', turn })
        }
      } else if (route === 'pending') {
        const queued = { ...fact, ...(fact.confidence === 'high' ? { confidence: 'medium' as const } : {}), category: fact.category ?? 'other' }
        pendingFacts = [...pendingFacts, queued]
        pendingChanged = true
        auditPending.push({ op: 'add', factId: factId(fact), after: queued, store: 'pending', writer: 'recordFacts', turn })
      }
    }
    // M2: an instruction-shaped candidate is never auto-promoted and never enters the session
    // store (so it can't render); it waits in the pending queue, marked, for the user to see.
    for (const fact of flaggedForPending) {
      const queued = { ...fact, category: fact.category ?? 'other' }
      pendingFacts = [...pendingFacts, queued]
      pendingChanged = true
      auditPending.push({ op: 'add', factId: factId(fact), after: queued, store: 'pending', writer: 'recordFacts:flagged', turn })
    }

    if (retiredNow.length > 0) {
      const retired = ((await this.memory.get(RETIRED_FACTS_KEY)) as UserFact[] | undefined) ?? []
      await this.memory.set(RETIRED_FACTS_KEY, [...retired, ...retiredNow])
    }
    await this.memory.set(`facts:${sessionId}`, sessionFacts)
    if (durableChanged) await this.commitDurable(durableFacts, audits)
    if (pendingChanged) await this.memory.set(PENDING_CONFIRMATION_KEY, pendingFacts)
    if (rejectedChanged) await this.memory.set(REJECTED_FACTS_KEY, rejectedFacts)
    await this.appendAudit(auditPending)
    this.writeCount++

    return { contradictions, corroborations }
  }

  private consolidating = false

  /**
   * M5: proposes consolidation and archive changes; applies NOTHING (D1: staged). Work is for the
   * stores as the previous session left them: callers run it at session start or `/new`, or on the
   * manual `/memory consolidate` (`manual` forces the model pass).
   *
   * Cost gate, deterministic and before any model call: the model pass runs only when the audit log
   * has entries newer than `memory:consolidation-state.lastSeq` or the curated (durable) store is
   * over the character budget, and there are at least two live facts; otherwise zero model calls.
   * Archive proposals use no model: only M1's usage timestamps and the retention window. A failed
   * or unusable model call changes nothing (the watermark does not move, so the next run retries).
   * Requires the audit log: a change that cannot be undone is never proposed.
   */
  async runConsolidation(
    opts: { manual?: boolean; onUsage?: (usage: TokenUsage) => void } = {},
  ): Promise<{ status: 'disabled' | 'needs_audit_log' | 'busy' | 'skipped' | 'ran' | 'failed'; proposed: number; modelCalls: number; projectedChars?: number; usedChars?: number }> {
    if (!memoryConsolidationEnabled()) return { status: 'disabled', proposed: 0, modelCalls: 0 }
    if (!memoryAuditLogEnabled()) return { status: 'needs_audit_log', proposed: 0, modelCalls: 0 }
    // M6: `/memory off` stops consolidation before any model call or staging write.
    if (await this.isMemoryOff()) return { status: 'disabled', proposed: 0, modelCalls: 0 }
    if (this.consolidating) return { status: 'busy', proposed: 0, modelCalls: 0 }
    this.consolidating = true
    try {
      const durable = (((await this.memory.get(DURABLE_FACTS_KEY)) as UserFact[] | undefined) ?? []).map(migrateFact).filter((f) => !f.retiredAt)
      const state = ((await this.memory.get(CONSOLIDATION_STATE_KEY)) as ConsolidationState | undefined) ?? { lastSeq: 0 }
      const log = ((await this.memory.get(AUDIT_LOG_KEY)) as AuditEntry[] | undefined) ?? []
      // Changes made by consolidation itself (and their undos) are not new information to consolidate.
      const diff = log.filter((e) => e.seq > state.lastSeq && e.op !== 'undo' && !e.writer.startsWith('consolidation'))
      const budget = this.memoryBudgetChars()
      const usedChars = renderFactsBlock(durable, Number.MAX_SAFE_INTEGER).block.length
      const existing = ((await this.memory.get(CONSOLIDATION_PROPOSALS_KEY)) as ConsolidationProposal[] | undefined) ?? []
      const dismissed = new Set(state.dismissed ?? [])
      let nextNo = state.nextProposalNo ?? 1
      const now = this.clock()
      const staged: ConsolidationProposal[] = []
      const claimed = new Set(existing.flatMap((p) => p.factIds))
      const byId = new Map(durable.map((f) => [factId(f), f]))
      const stage = (kind: ConsolidationProposal['kind'], ids: string[], reason: string, extra: { text?: string; by?: string } = {}): void => {
        if (ids.some((id) => claimed.has(id))) return
        if (dismissed.has(proposalSignature(kind, ids, extra.text))) return
        ids.forEach((id) => claimed.add(id))
        staged.push({ id: `c${nextNo++}`, kind, factIds: ids, reason, createdAt: now, touchesUserAsserted: ids.some((id) => byId.get(id)?.source === 'user_asserted'), ...extra })
      }

      let modelCalls = 0
      let newWatermark = state.lastSeq
      const gateOpen = (opts.manual === true || diff.length > 0 || usedChars > budget) && durable.length >= 2
      let failed = false
      if (gateOpen) {
        modelCalls = 1
        const refs = durable.map((f, i) => ({ ref: `f${i + 1}`, f }))
        const input: ConsolidationInput = {
          facts: refs.map(({ ref, f }) => ({ ref, text: f.text, source: f.source, ...(f.key ? { key: f.key } : {}), ...(f.injectedCount ? { injectedCount: f.injectedCount } : {}), ...(f.lastInjectedAt ? { lastInjectedAt: f.lastInjectedAt } : {}) })),
          recentChanges: diff.map((e) => ({ op: e.op, text: (e.after ?? e.before)?.text ?? e.factId })),
          budget: { usedChars, budgetChars: budget },
        }
        const ops = await proposeConsolidationOps(input, this.llmClient, this.model(), opts.onUsage)
        if (ops === undefined) failed = true
        else {
          const refToFact = new Map(refs.map(({ ref, f }) => [ref, f]))
          for (const op of ops) {
            const sources = op.refs.map((r) => refToFact.get(r)!)
            // Plain-code structural check (no language understanding needed): merging across projects would leak scope.
            if (op.kind === 'merge' && new Set(sources.map((f) => f.project ?? '')).size > 1) continue
            const extra = op.kind === 'supersede' ? { by: factId(refToFact.get(op.by!)!) } : { text: op.text }
            stage(op.kind, sources.map(factId), op.reason, extra)
          }
          newWatermark = log.length > 0 ? log[log.length - 1].seq : state.lastSeq
        }
      }

      // Staged forgetting: zero model calls, and only when usage tracking exists (otherwise "never injected" would be true of everything).
      if (!failed && memoryBudgetedRenderEnabled()) {
        const days = memoryRetentionDays()
        for (const f of findArchiveCandidates(durable, Date.now(), days)) {
          stage('archive', [factId(f)], `Not placed in a prompt (nor stated) for over ${days} days. "In the prompt" is weaker than "used".`)
        }
      }
      if (failed) return { status: 'failed', proposed: 0, modelCalls }
      if (staged.length > 0) await this.memory.set(CONSOLIDATION_PROPOSALS_KEY, [...existing, ...staged])
      if (gateOpen || staged.length > 0) await this.memory.set(CONSOLIDATION_STATE_KEY, { ...state, lastSeq: newWatermark, at: now, nextProposalNo: nextNo })
      const savedChars = (p: ConsolidationProposal): number => {
        const src = p.factIds.reduce((n, id) => n + (byId.get(id) ? factLine(byId.get(id)!).length + 1 : 0), 0)
        return p.kind === 'archive' || p.kind === 'supersede' ? src : src - (p.text ? p.text.length + 3 : 0)
      }
      const projectedChars = usedChars - staged.reduce((n, p) => n + savedChars(p), 0)
      return { status: gateOpen || staged.length > 0 ? 'ran' : 'skipped', proposed: staged.length, modelCalls, projectedChars, usedChars }
    } finally {
      this.consolidating = false
    }
  }

  async getConsolidationProposals(): Promise<ConsolidationProposal[]> {
    return ((await this.memory.get(CONSOLIDATION_PROPOSALS_KEY)) as ConsolidationProposal[] | undefined) ?? []
  }

  /** `/memory archive` — what staged forgetting has set aside. Nothing in it is deleted. */
  async getArchivedFacts(): Promise<UserFact[]> {
    return ((await this.memory.get(ARCHIVED_FACTS_KEY)) as UserFact[] | undefined) ?? []
  }

  /** `/memory consolidate dismiss <n>`: drops the proposal and remembers its signature so it is not raised again. */
  async dismissProposal(index: number): Promise<ConsolidationProposal | undefined> {
    const proposals = await this.getConsolidationProposals()
    if (index < 0 || index >= proposals.length) return undefined
    const p = proposals[index]
    await this.memory.set(CONSOLIDATION_PROPOSALS_KEY, proposals.filter((_, i) => i !== index))
    const state = ((await this.memory.get(CONSOLIDATION_STATE_KEY)) as ConsolidationState | undefined) ?? { lastSeq: 0 }
    await this.memory.set(CONSOLIDATION_STATE_KEY, { ...state, dismissed: [...(state.dismissed ?? []), proposalSignature(p.kind, p.factIds, p.text)] })
    return p
  }

  /**
   * `/memory consolidate accept <n>`: the user's explicit yes. Applies one staged proposal to the
   * durable store through `commitDurable` as one audit group (`/memory undo <seq>` reverts all of it,
   * restoring the store and its order exactly). Merged/superseded originals go to the retired store,
   * archived ones to the archive store; nothing is deleted. Refuses without the audit log, and treats
   * a proposal whose facts changed since it was staged as stale.
   */
  async acceptProposal(index: number, sessionId = 'memory'): Promise<{ ok: boolean; message: string }> {
    if (!memoryConsolidationEnabled()) return { ok: false, message: 'Memory consolidation is off (AUDIT_MEMORY_CONSOLIDATION).' }
    if (await this.isMemoryOff()) return { ok: false, message: 'Memory writes are off (/memory on to resume); nothing was changed.' }
    if (!memoryAuditLogEnabled()) return { ok: false, message: 'Refusing: consolidation changes must be undoable, and the audit log is off (AUDIT_MEMORY_AUDIT_LOG).' }
    const proposals = await this.getConsolidationProposals()
    if (index < 0 || index >= proposals.length) return { ok: false, message: `No proposal #${index + 1}.` }
    const p = proposals[index]
    const rest = proposals.filter((_, i) => i !== index)
    const durable = (((await this.memory.get(DURABLE_FACTS_KEY)) as UserFact[] | undefined) ?? []).map(migrateFact)
    const sources = p.factIds.map((id) => durable.find((f) => factId(f) === id))
    if (sources.some((s) => !s)) {
      await this.memory.set(CONSOLIDATION_PROPOSALS_KEY, rest)
      return { ok: false, message: `Proposal #${index + 1} is stale (a fact it touches has changed); dropped.` }
    }
    const facts = sources as UserFact[]
    const retiredAt = this.clock()
    const group = `consolidation:${p.id}`
    let next = durable
    const drafts: AuditDraft[] = []
    const retiredNow: UserFact[] = []
    const archivedNow: UserFact[] = []
    const take = (f: UserFact): number => { const i = next.findIndex((x) => sameFact(x, f)); next = next.filter((x) => !sameFact(x, f)); return i }
    let replacement: UserFact | undefined
    if (p.kind === 'merge' || p.kind === 'tighten') {
      const lastSource = facts[facts.length - 1]
      const sharedKey = facts.every((f) => f.key && f.key === facts[0].key) ? facts[0].key : undefined
      const injected = facts.reduce((n, f) => n + (f.injectedCount ?? 0), 0)
      const lastInjectedAt = facts.map((f) => f.lastInjectedAt).filter((x): x is string => !!x).sort().pop()
      const candidate: UserFact = {
        text: p.text ?? lastSource.text,
        extractedAt: facts.map((f) => f.extractedAt).sort().pop()!,
        sourceTurn: lastSource.sourceTurn,
        // The user accepting the proposal is the confirmation (same re-sourcing as /memory confirm); a user_asserted source keeps its protection.
        source: facts.some((f) => f.source === 'user_asserted') ? 'user_asserted' : 'externally_verified',
        durable: true,
        ...(facts[0].category ? { category: facts[0].category } : {}),
        ...(facts[0].project !== undefined ? { project: facts[0].project } : {}),
        ...(sharedKey ? { key: sharedKey } : {}),
        ...(injected > 0 ? { injectedCount: injected } : {}),
        ...(lastInjectedAt ? { lastInjectedAt } : {}),
        origin: 'user',
      }
      const decision = admitCandidate(candidate, memoryWriteGateEnabled())
      if (decision.action !== 'admit') return { ok: false, message: 'The write gate did not admit the consolidated text; nothing changed.' }
      replacement = decision.fact
    }
    facts.forEach((f, i) => {
      const idx = take(f)
      const id = factId(f)
      if (p.kind === 'archive') {
        const archived = { ...f, retiredAt }
        archivedNow.push(archived)
        drafts.push({ op: 'archive', factId: id, before: f, after: archived, index: idx, store: 'durable', writer: 'consolidation:archive', turn: sessionId, group })
        return
      }
      retiredNow.push({ ...f, retiredAt })
      const isLast = i === facts.length - 1
      drafts.push({ op: isLast && replacement ? 'replace' : 'retire', factId: id, before: f, ...(isLast && replacement ? { after: replacement } : {}), index: idx, store: 'durable', writer: `consolidation:${p.kind}`, turn: sessionId, group })
    })
    if (replacement) next = [...next, replacement]
    if (retiredNow.length > 0) await this.memory.set(RETIRED_FACTS_KEY, [...(((await this.memory.get(RETIRED_FACTS_KEY)) as UserFact[] | undefined) ?? []), ...retiredNow])
    if (archivedNow.length > 0) await this.memory.set(ARCHIVED_FACTS_KEY, [...(await this.getArchivedFacts()), ...archivedNow])
    await this.commitDurable(next, drafts)
    await this.memory.set(CONSOLIDATION_PROPOSALS_KEY, rest)
    return { ok: true, message: `Applied ${p.kind} proposal (${p.factIds.length} fact${p.factIds.length === 1 ? '' : 's'}) as ${group}; /memory history shows its entries and /memory undo <seq> reverts them all.` }
  }

  /** `/memory archive restore <n>`: puts an archived entry back among the live facts (audited; undoable). */
  async restoreArchivedFact(listIndex: number, sessionId = 'memory'): Promise<UserFact | undefined> {
    // `listIndex` is a position in `listArchive()`; only the set-aside head of that list is restorable (a replaced entry's newer value would conflict).
    const archive = await this.getArchivedFacts()
    const index = listIndex
    if (index < 0 || index >= archive.length) return undefined
    const archived = archive[index]
    const { retiredAt: _r, ...live } = archived
    const durable = (((await this.memory.get(DURABLE_FACTS_KEY)) as UserFact[] | undefined) ?? []).map(migrateFact)
    await this.memory.set(ARCHIVED_FACTS_KEY, archive.filter((_, i) => i !== index))
    await this.commitDurable([...durable, live], [{ op: 'restore', factId: factId(archived), before: archived, after: live, store: 'durable', writer: 'archive:restore', turn: sessionId }])
    return live
  }

  /** Writes the batched `injectedCount`/`lastInjectedAt` updates collected by budgeted renders, to whichever store(s) hold each fact. A no-op (no writes) when nothing was rendered. */
  private async flushInjectionUsage(sessionId: string): Promise<void> {
    if (this.pendingInjections.size === 0) return
    const pending = this.pendingInjections
    this.pendingInjections = new Map()
    const now = this.clock()
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
    if (durable.changed) await this.commitDurable(durable.facts)
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
    const rejectedAt = this.clock()
    await this.memory.set(REJECTED_FACTS_KEY, [...rejected, ...facts.map((f) => ({ text: f.text, rejectedAt, rejectionSource }))])
    await this.appendAudit(facts.map((f) => ({ op: 'reject' as const, factId: factId(f), before: f, store: 'pending' as const, writer: `reject:${rejectionSource}`, turn: 'memory' })))
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
    const { flagged: _flagged, proposedOp, retireTargetId, stagedBy: _stagedBy, verification: _verification, ...unflagged } = fact
    if (proposedOp === 'retire') {
      // A confirmed retire proposal removes the target (into the retired store) and adds nothing.
      const target = durableFacts.find((f) => factId(f) === retireTargetId)
      if (target) {
        const retired = ((await this.memory.get(RETIRED_FACTS_KEY)) as UserFact[] | undefined) ?? []
        await this.memory.set(RETIRED_FACTS_KEY, [...retired, { ...target, retiredAt: this.clock() }])
        await this.commitDurable(durableFacts.filter((f) => f !== target), [{ op: 'retire', factId: factId(target), before: target, index: durableFacts.indexOf(target), store: 'durable', writer: 'confirm:reviewer-retire', turn: 'memory' }])
      }
      return { fact: { ...unflagged, source: 'externally_verified', confidence: undefined }, conflictNotice: contradictions[0]?.description }
    }
    const confirmed: UserFact = { ...unflagged, source: 'externally_verified', confidence: undefined }
    // M4: a confirmed keyed upsert replaces the live entry with the same key (M1 supersession), keeping the old one in the retired store.
    let nextDurable = [...durableFacts]
    const extraAudits: AuditDraft[] = []
    if (confirmed.key && memoryBudgetedRenderEnabled()) {
      const sameKey = (f: UserFact): boolean => f.key === confirmed.key && (f.project ?? '') === (confirmed.project ?? '')
      const priors = durableFacts.filter(sameKey)
      if (priors.length > 0) {
        const retiredAt = this.clock()
        const retired = ((await this.memory.get(RETIRED_FACTS_KEY)) as UserFact[] | undefined) ?? []
        await this.memory.set(RETIRED_FACTS_KEY, [...retired, ...priors.map((p) => ({ ...p, retiredAt }))])
        nextDurable = durableFacts.filter((f) => !sameKey(f))
        for (const p of priors) extraAudits.push({ op: 'retire', factId: factId(p), before: p, index: durableFacts.indexOf(p), store: 'durable', writer: 'confirm:supersede', turn: 'memory' })
        confirmed.supersedes = priors[priors.length - 1].text
      }
    }
    await this.commitDurable([...nextDurable, confirmed], [...extraAudits, { op: 'confirm', factId: factId(fact), before: fact, after: confirmed, store: 'durable', writer: 'confirm', turn: 'memory' }])
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
    const { facts } = await this.loadFacts(sessionId, { record: false })
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
      exportedAt: this.clock(),
      facts: summary.facts,
      reminders: summary.reminders,
      pending: summary.pending,
      experience: this.experienceStore.toJSON(),
      digests: await this.digests.exportAll(),
      retired: await this.listArchive(),
      audit: await this.getAuditLog(Number.MAX_SAFE_INTEGER),
      governance: { mode: this.writeMode(), off: await this.isMemoryOff() },
    }
  }

  /** What the most recent turn's facts block contained (undefined before the first turn). Set only by the turn path, never by read-only views. */
  getLastInjection(): MemoryInjection | undefined {
    return this.lastInjection
  }

  /** `/memory archive`: entries a keyed update replaced, newest first. M5 EXTENSION POINT: its archive store joins here (and in `exportMemory`) when it exists. */
  async listArchive(): Promise<UserFact[]> {
    const retired = ((await this.memory.get(RETIRED_FACTS_KEY)) as UserFact[] | undefined) ?? []
    // M5's set-aside store (restorable) comes first, then M6's replaced entries newest first; `restore`/`forget` index this one list.
    return [...(await this.getArchivedFacts()), ...[...retired].reverse()]
  }

  /**
   * `/memory archive forget <n>`: permanently erases one archived entry (index over `listArchive()`),
   * including its pre-images in the audit log (those entries stay, marked `erased`, and can no longer
   * be undone). The only path that edits the audit log other than appending, and only on an explicit user request.
   */
  async forgetArchived(index: number): Promise<UserFact | undefined> {
    const archive = await this.listArchive()
    if (index < 0 || index >= archive.length) return undefined
    const fact = archive[index]
    const retired = ((await this.memory.get(RETIRED_FACTS_KEY)) as UserFact[] | undefined) ?? []
    // `supersedes` on a newer fact quotes the old text; erasing means that reference goes too (durable store, remaining archive, audit images).
    const unlink = <T extends UserFact>(f: T): T => (f.supersedes === fact.text ? { ...f, supersedes: undefined } : f)
    await this.memory.set(RETIRED_FACTS_KEY, retired.filter((f) => !sameFact(f, fact)).map(unlink))
    const setAside = await this.getArchivedFacts()
    if (setAside.some((f) => sameFact(f, fact))) await this.memory.set(ARCHIVED_FACTS_KEY, setAside.filter((f) => !sameFact(f, fact)))
    const durable = ((await this.memory.get(DURABLE_FACTS_KEY)) as UserFact[] | undefined) ?? []
    if (durable.some((f) => f.supersedes === fact.text)) await this.commitDurable(durable.map(unlink))
    await this.eraseFromAuditLog(fact)
    return fact
  }

  /** Strips one fact's pre/post-images from the audit log (entries stay, marked `erased`, and can no longer be undone) and unlinks `supersedes` references to it. */
  private async eraseFromAuditLog(fact: UserFact): Promise<void> {
    const unlink = <T extends UserFact>(f: T): T => (f.supersedes === fact.text ? { ...f, supersedes: undefined } : f)
    const log = ((await this.memory.get(AUDIT_LOG_KEY)) as AuditEntry[] | undefined) ?? []
    const touches = (e: AuditEntry): boolean => e.factId === factId(fact) || (e.before !== undefined && sameFact(e.before, fact)) || (e.after !== undefined && sameFact(e.after, fact))
    if (log.some((e) => touches(e) || e.before?.supersedes === fact.text || e.after?.supersedes === fact.text)) {
      // Only this fact's own images go; the other side of a replace (the new value) is a different fact and stays.
      await this.memory.set(AUDIT_LOG_KEY, log.map((e) => {
        if (!touches(e)) return { ...e, ...(e.before ? { before: unlink(e.before) } : {}), ...(e.after ? { after: unlink(e.after) } : {}) }
        const { before, after, ...rest } = e
        return {
          ...rest,
          factId: `erased:${e.seq}`,
          erased: true,
          ...(before && !sameFact(before, fact) ? { before: unlink(before) } : {}),
          ...(after && !sameFact(after, fact) ? { after: unlink(after) } : {}),
        }
      }))
    }
  }

  /** Read-only health snapshot (`/doctor`, memory panel). Never touches usage counters or the last-injection record. */
  async getMemoryStatus(sessionId: string): Promise<MemoryStatus> {
    const { facts } = await this.loadFacts(sessionId, { record: false })
    const project = this.currentProject()
    const live = facts.filter((f) => !f.retiredAt && (f.project === undefined || f.project === project))
    const pending = ((await this.memory.get(PENDING_CONFIRMATION_KEY)) as PendingFact[] | undefined) ?? []
    const audit = ((await this.memory.get(AUDIT_LOG_KEY)) as AuditEntry[] | undefined) ?? []
    const consolidation = (await this.memory.get(CONSOLIDATION_STATE_KEY)) as { lastSeq?: number; at?: string } | undefined
    return {
      mode: this.writeMode(),
      off: await this.isMemoryOff(),
      budgetedRender: memoryBudgetedRenderEnabled(),
      budgetChars: this.memoryBudgetChars(),
      storeChars: live.reduce((n, f) => n + factLine(f).length + 1, 0),
      liveFacts: live.length,
      pending: pending.length,
      flaggedPending: pending.filter((f) => f.flagged).length,
      retired: ((await this.memory.get(RETIRED_FACTS_KEY)) as UserFact[] | undefined)?.length ?? 0,
      auditEnabled: memoryAuditLogEnabled(),
      auditEntries: audit.length,
      lastConsolidatedSeq: consolidation?.lastSeq,
      lastConsolidationAt: consolidation?.at,
      lastInjection: this.lastInjection,
    }
  }

  /** M3 (D4): `/memory forget digest <id>` or, with no id, every digest. Returns how many were removed. */
  async forgetDigests(id?: string): Promise<number> {
    return this.digests.forget(id)
  }

  /** M3: read-only digest reader over the same store the recall tool uses. */
  get digests(): DigestStore {
    return (this.digestStoreInstance ??= new DigestStore(this.memory))
  }

  /** Token usage of the most recent digest/flush calls made by this service (cost per session edge). */
  digestUsage = { inputTokens: 0, outputTokens: 0, costUsd: 0 }

  private trackDigestUsage = (usage: TokenUsage): void => {
    this.digestUsage = {
      inputTokens: this.digestUsage.inputTokens + usage.inputTokens,
      outputTokens: this.digestUsage.outputTokens + usage.outputTokens,
      costUsd: this.digestUsage.costUsd + (usage.costUsd ?? 0),
    }
  }

  /**
   * M3 session-edge digest (`/new`, exit). One bounded call, fail-open: any failure leaves the previous digest (if any)
   * untouched. Skipped when the conversation has no user message. Output is judged and redacted by `admitCandidate`
   * (see episodic-digest.ts) and stored at `episodic:<id>`; it never touches durable facts. Callers gate on
   * `episodicDigestEnabled()`; never call from inside a turn.
   */
  async writeSessionDigest(sessionId: string, transcript: ChatMessage[], onUsage?: (usage: TokenUsage) => void): Promise<SessionDigest | null> {
    if (!transcript.some((m) => m.role === 'user')) return null
    // M6: `/memory off` stops digests too (no LLM spend, no write).
    if (await this.isMemoryOff()) return null
    try {
      const result = await writeDigest(this.memory, this.llmClient, { sessionId, messages: transcript, extractFacts: false }, this.model(), (u) => { this.trackDigestUsage(u); onUsage?.(u) })
      return result?.digest ?? null
    } catch {
      return null
    }
  }

  /** M3: ends the conversation's digest identity so the next conversation under the same session id gets a new digest. Call after `writeSessionDigest`. */
  async endDigestConversation(sessionId: string): Promise<void> {
    await endConversation(this.memory, sessionId)
  }

  /**
   * M3 pre-compaction flush: called with exactly the messages compaction is about to drop. One call extracts candidate
   * facts and a digest delta (folded into the conversation's digest). Candidates are judged by `admitCandidate` and go
   * to the pending queue only, never durable. Fail-open: returns 0 on any failure and compaction proceeds regardless.
   */
  async flushBeforeCompaction(sessionId: string, older: ChatMessage[], onUsage?: (usage: TokenUsage) => void): Promise<number> {
    // An earlier compaction's summary message was already flushed when it was made; do not re-read it.
    const messages = older.filter((m) => !m.content.startsWith(SUMMARY_HEADER))
    if (!messages.some((m) => m.role === 'user')) return 0
    if (await this.isMemoryOff()) return 0
    try {
      const result = await writeDigest(this.memory, this.llmClient, { sessionId, messages, extractFacts: true }, this.model(), (u) => { this.trackDigestUsage(u); onUsage?.(u) })
      if (!result) return 0
      return await this.queueFlushCandidates(sessionId, result.facts)
    } catch {
      return 0
    }
  }

  /** Judges flush candidates (gate forced on: a missing judgement drops the candidate) and appends the survivors to the pending queue. Exact-text duplicates of anything pending, durable or rejected are skipped. */
  private async queueFlushCandidates(sessionId: string, candidates: UserFact[]): Promise<number> {
    if (candidates.length === 0) return 0
    const pending = ((await this.memory.get(PENDING_CONFIRMATION_KEY)) as PendingFact[] | undefined) ?? []
    const durable = (((await this.memory.get(DURABLE_FACTS_KEY)) as UserFact[] | undefined) ?? []).map(migrateFact)
    const rejected = ((await this.memory.get(REJECTED_FACTS_KEY)) as RejectedFact[] | undefined) ?? []
    const seen = new Set([...pending.map((f) => f.text), ...durable.map((f) => f.text), ...rejected.map((f) => f.text)].map((t) => t.trim().toLowerCase()))
    let queued = 0
    for (const candidate of candidates) {
      const decision = admitCandidate(candidate, true)
      // `session` here means the judgement was missing: not stored anywhere (the flush has no session-scoped home).
      if (decision.action === 'drop' || decision.action === 'session') continue
      const text = decision.fact.text.trim()
      if (!text || seen.has(text.toLowerCase())) continue
      seen.add(text.toLowerCase())
      // M6: through the one cross-turn entry point, so `memoryWriteMode` picks the route (default: the pending queue) and `/memory off` blocks it.
      // The raw candidate (judgement attached) goes in: submitCandidate re-runs the same pure gate, forced on here as before (fail-closed on a missing judgement).
      const out = await this.submitCandidate('digest', candidate, sessionId, { forceGate: true })
      if (out.route === 'pending' || out.route === 'durable') queued++
    }
    return queued
  }
}
