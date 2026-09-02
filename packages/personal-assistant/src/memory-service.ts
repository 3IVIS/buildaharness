import type { ExperienceStore, StrategyWeightKey, DecompositionEntry, RecoverySequenceEntry, ExperienceStoreData } from '@buildaharness/harness'
import type { MemoryAdapter, ReminderStore, ReminderRecord } from '@buildaharness/runtime'
import { extractFactsFromTurn, migrateFact, type UserFact } from './fact-extraction.js'

// Most-recent facts (and, separately, active reminders) injected into the system prompt each
// turn — a hard cap, not a summary, so this stays cheap even as the fact/reminder store grows.
export const FACT_CAP = 20

// Deliberately NOT suffixed with a sessionId — clearSession() only deletes `facts:${sessionId}`,
// so a fact stored here (see recordFacts()) survives /new the same way reminderStore/
// experienceStore already do (see AssistantSession.clearSession's doc comment on why those stay
// untouched). This personal-assistant is single-user/single-install, so one global durable-fact
// list (not per-session) is the right shape — matching reminderStore/experienceStore's own
// precedent.
export const DURABLE_FACTS_KEY = 'facts:durable'

/** Bound on how many learned decompositions/recovery sequences `getMemorySummary()` includes — see MemorySummary's doc comment. */
export const MEMORY_SUMMARY_PREVIEW_LIMIT = 20

/**
 * Read-only snapshot returned by `getMemorySummary()` — see that method's doc comment.
 * `decompositions`/`recoverySequences` are capped at the 20 most recently learned entries
 * (newest first) so `/memory` stays scannable after months of accumulated learning; `/memory
 * export` (see `exportMemory()`) returns every category unbounded, since a file on disk doesn't
 * have the same terminal-scrollback concern a REPL print does.
 */
export interface MemorySummary {
  facts: UserFact[]
  reminders: ReminderRecord[]
  experience: {
    strategyWeights: Record<StrategyWeightKey, number>
    decompositions: DecompositionEntry[]
    recoverySequences: RecoverySequenceEntry[]
  }
}

/** Full, unbounded snapshot written by `/memory export` — every ExperienceStore category plus facts/reminders, as plain JSON. */
export interface MemoryExport {
  exportedAt: string
  facts: UserFact[]
  reminders: ReminderRecord[]
  experience: ExperienceStoreData
}

/** Durable facts first, then session facts whose text isn't already present among them — so a
 * fact recorded as durable (an allergy, a name) doesn't show up twice within the same session it
 * was stated in, but does reappear on its own once /new clears the session list. */
function mergeFacts(durableFacts: UserFact[], sessionFacts: UserFact[]): UserFact[] {
  const durableTexts = new Set(durableFacts.map(f => f.text))
  return [...durableFacts, ...sessionFacts.filter(f => !durableTexts.has(f.text))]
}

/**
 * Owns fact/reminder/experience reads that feed each turn's system prompt, fact capture, and the
 * `/memory`/`/memory export` read-only snapshots — the "what has this assistant learned" surface
 * of PersonalAssistant, split out in Phase 4d of the architecture remediation plan. Fully
 * self-contained: no dependency on any other extracted module.
 */
export class MemoryService {
  constructor(
    private readonly memory: MemoryAdapter,
    private readonly reminderStore: ReminderStore,
    private readonly experienceStore: ExperienceStore,
  ) {}

  /** Durable + session facts for `sessionId`, plus the ready-to-splice system-prompt block — see runTurn's former factsBlock. */
  async loadFacts(sessionId: string): Promise<{ facts: UserFact[]; factsBlock: string }> {
    const sessionFacts = (((await this.memory.get(`facts:${sessionId}`)) as UserFact[] | undefined) ?? []).map(migrateFact)
    const durableFacts = (((await this.memory.get(DURABLE_FACTS_KEY)) as UserFact[] | undefined) ?? []).map(migrateFact)
    const facts = mergeFacts(durableFacts, sessionFacts)
    const factsBlock = facts.length > 0
      ? `\nKnown facts about the user:\n${facts.slice(-FACT_CAP).map(f => `- ${f.text}`).join('\n')}`
      : ''
    return { facts, factsBlock }
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
   * Captures a durable fact from the user's message, if any, into the session's fact store. A
   * no-op for ordinary turns. Facts flagged `durable` (name, preference, health/dietary — see
   * fact-extraction.ts) are ALSO appended to DURABLE_FACTS_KEY, a store clearSession() never
   * touches, so they survive /new instead of vanishing with the rest of the session's facts.
   *
   * `llmStatedFact` is classifyTurnIntent's statesDurableFact — only trusted (as a session-scoped
   * capture) when the free lexical pass above found nothing at all for this message, so a
   * phrasing FACT_MARKERS/HEALTH_OR_DIETARY_MARKERS doesn't recognize (any language, or an
   * English paraphrase the marker list doesn't cover) still gets captured instead of silently
   * dropped. The lexical pass stays authoritative — and free — whenever it does find something.
   *
   * Promotion policy (Phase 5): only USER_ASSERTED facts (the lexical pass, via `isDurable()`)
   * promote to the cross-session DURABLE_FACTS_KEY store automatically. `llmStatedFact`'s own
   * `durable` bit is an advisory LLM opinion, not authoritative — a MODEL_INFERRED fact is always
   * recorded session-scoped (still available for this session's prompt context) but never
   * auto-promoted, since it has no corroboration (the lexical pass, checked first, found nothing)
   * and there's no explicit user-confirmation flow yet to earn promotion the other way.
   */
  async recordFacts(sessionId: string, userMessage: string, llmStatedFact?: { text: string; durable: boolean } | null): Promise<void> {
    const facts = extractFactsFromTurn(userMessage, `turn:${sessionId}`)
    const factsToRecord: UserFact[] =
      facts.length === 0 && llmStatedFact
        ? [{ text: llmStatedFact.text, extractedAt: new Date().toISOString(), sourceTurn: `turn:${sessionId}`, source: 'model_inferred', durable: false }]
        : facts
    for (const fact of factsToRecord) {
      await this.memory.set(`facts:${sessionId}`, fact, 'append')
      if (fact.durable) {
        await this.memory.set(DURABLE_FACTS_KEY, fact, 'append')
      }
    }
  }

  /**
   * Read-only snapshot of what this session/assistant has learned: durable facts extracted
   * from the user's own messages, reminders created so far, and the real content (not just
   * counts) of the learning-layer `ExperienceStore` — strategy weights in full, and the 20
   * most recently learned decompositions/recovery sequences (see MEMORY_SUMMARY_PREVIEW_LIMIT).
   * Use `exportMemory()` for the full, unbounded contents. Used by `/memory`.
   */
  async getMemorySummary(sessionId: string): Promise<MemorySummary> {
    const { facts } = await this.loadFacts(sessionId)
    const reminders = await this.reminderStore.list()
    const experienceData = this.experienceStore.toJSON()
    return {
      facts,
      reminders,
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
   * facts/reminders, as plain JSON. Read-only: this adds no corresponding import path, so a
   * user cannot hand-edit the result and load it back in. Used by `/memory export`.
   */
  async exportMemory(sessionId: string): Promise<MemoryExport> {
    const summary = await this.getMemorySummary(sessionId)
    return {
      exportedAt: new Date().toISOString(),
      facts: summary.facts,
      reminders: summary.reminders,
      experience: this.experienceStore.toJSON(),
    }
  }
}
