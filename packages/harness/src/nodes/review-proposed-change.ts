import type { WorldModel } from '../state/world-model.js'
import type { OutputContract } from '../state/output-contract.js'
import type { HypothesisSet } from '../state/hypothesis-set.js'
import type { EvidenceStore } from '../state/evidence-store.js'
import type { Task } from '../state/task-graph.js'
import { getReviewNegationTriggers } from '../lexical/patterns.js'
import { harnessLexicalActive } from '../lexical/lexical-off.js'
import { tokenize, containsCJK } from '../lexical/script-utils.js'
import { MAX_OPTIONS_PER_QUESTION, type AskQuestion, type AskQuestionOption } from './escalate.js'

export type ReviewDimension =
  | 'task_alignment'
  | 'world_model_consistency'
  | 'output_contract_precheck'
  | 'code_quality'
  | 'hypothesis_compatibility'

export interface DimensionResult {
  dimension: ReviewDimension
  passed: boolean
  reason: string
}

export interface ReviewResult {
  passed: boolean
  failed_dimensions: DimensionResult[]
  consecutive_failures: number
  escalation_triggered: boolean
}

export interface ProposedChange {
  description?: string
  change_type?: string
  required_resources?: string[]
  required_state_structures?: string[]
}

const ESCALATION_THRESHOLD = 2

function getChangeDescription(proposedChange: ProposedChange): string {
  return (proposedChange.description ?? '').toLowerCase()
}

// NEGATION_STOPWORDS/NEGATION_TRIGGERS now live in packages/harness/src/lexical/patterns/negation.json
// (see lexical/patterns.ts) — mirrored in adapter/harness/lexical_patterns.py, read by
// adapter/harness/review_gate.py's own isNegation-equivalent.
const { triggers: NEGATION_TRIGGERS, stopwords: NEGATION_STOPWORDS } = getReviewNegationTriggers()

/**
 * True when changeDesc negates stmt. Primary check: changeDesc literally contains "not <stmt>"
 * etc. — a real hit, but stmt is usually a full sentence-shaped belief statement or predicted
 * observation, so changeDesc containing it byte-for-byte almost never happens with real freeform
 * text (a paraphrase like "dropping the login requirement" for a belief "login is required"
 * never matches "removes login is required"). Fallback: a negation trigger word is present in
 * changeDesc *and* changeDesc shares significant (non-stopword) vocabulary with stmt — the same
 * shared-subject requirement statementsOpposed (detect-contradictions.ts) uses, so this doesn't
 * regress into over-firing on a change that's merely topically related rather than opposed.
 *
 * The `length > 3` cutoff below only makes sense for whitespace-tokenized (Latin-script) words —
 * it's meant to drop short function words tokenize() didn't already filter as stopwords. CJK
 * tokens are one character each (see script-utils.ts's tokenize doc comment), so that same cutoff
 * discarded every CJK token and made this fallback path structurally unable to catch a paraphrased
 * Chinese negation (only the literal-concatenation check above could fire) — fixed by exempting
 * CJK tokens from the length cutoff, the same containsCJK-based carve-out statementsOpposed's
 * sharedTokens gate already relies on (which needs no length cutoff at all, since a single shared
 * CJK character is exactly as meaningful a signal there as a whole shared English word is here).
 */
function isNegation(changeDesc: string, stmt: string): boolean {
  if (!changeDesc || !stmt) return false
  if (!harnessLexicalActive('review-negation')) return false // HARNESS_LEXICAL_OFF: the semantic reviewer runs alone
  const patterns = NEGATION_TRIGGERS.map((trigger) => `${trigger}${stmt}`)
  if (patterns.some(p => changeDesc.includes(p))) return true

  if (!NEGATION_TRIGGERS.some(t => changeDesc.includes(t))) return false
  const stmtWords = tokenize(stmt).filter(w => (containsCJK(w) || w.length > 3) && !NEGATION_STOPWORDS.has(w))
  if (stmtWords.length === 0) return false
  const changeWords = new Set(tokenize(changeDesc))
  const overlap = stmtWords.filter(w => changeWords.has(w))
  return overlap.length >= Math.min(2, stmtWords.length)
}

function checkTaskAlignment(proposedChange: ProposedChange, currentTask: Task | null): DimensionResult {
  if (currentTask === null) {
    return { dimension: 'task_alignment', passed: true, reason: 'No current task — alignment not applicable' }
  }
  const taskDesc = currentTask.description.toLowerCase()
  const changeDesc = getChangeDescription(proposedChange)
  if (taskDesc && !changeDesc) {
    return { dimension: 'task_alignment', passed: false, reason: 'Proposed change has no description but task requires one' }
  }
  return { dimension: 'task_alignment', passed: true, reason: 'Change aligns with task' }
}

function checkWorldModelConsistency(proposedChange: ProposedChange, worldModel: WorldModel | null): DimensionResult {
  if (worldModel === null) {
    return { dimension: 'world_model_consistency', passed: true, reason: 'No world model provided' }
  }
  const changeDesc = getChangeDescription(proposedChange)
  for (const belief of worldModel.beliefs) {
    if (belief.confidence < 0.8) continue
    const stmt = belief.statement.toLowerCase()
    if (isNegation(changeDesc, stmt)) {
      return {
        dimension: 'world_model_consistency',
        passed: false,
        reason: `Change contradicts HIGH-reliability belief: ${JSON.stringify(stmt)}`,
      }
    }
  }
  return { dimension: 'world_model_consistency', passed: true, reason: 'No contradiction with world model beliefs' }
}

function checkOutputContract(proposedChange: ProposedChange, outputContract: OutputContract | null): DimensionResult {
  if (outputContract === null) {
    return { dimension: 'output_contract_precheck', passed: true, reason: 'No output contract provided' }
  }
  // HARNESS_LEXICAL review-phrases: "remove <section>" is a phrase match over free text.
  if (!harnessLexicalActive('review-phrases')) {
    return { dimension: 'output_contract_precheck', passed: true, reason: 'Lexical phrase check switched off' }
  }
  const changeDesc = getChangeDescription(proposedChange)
  for (const section of outputContract.required_sections) {
    const s = section.toLowerCase()
    const removalPatterns = [`remove ${s}`, `delete ${s}`, `drop ${s}`, `removes ${s}`]
    if (removalPatterns.some(p => changeDesc.includes(p))) {
      return {
        dimension: 'output_contract_precheck',
        passed: false,
        reason: `Change removes required interface field: ${JSON.stringify(section)}`,
      }
    }
  }
  return { dimension: 'output_contract_precheck', passed: true, reason: 'No required interface fields removed' }
}

function checkCodeQuality(proposedChange: ProposedChange, toolManifest: EvidenceStore | null): DimensionResult {
  if (toolManifest === null) {
    return { dimension: 'code_quality', passed: true, reason: 'No tool manifest — code quality check skipped' }
  }
  const manifest = toolManifest.tool_availability_manifest
  const hasLinter =
    (manifest['linter']?.available ?? false) ||
    (manifest['pylint']?.available ?? false) ||
    (manifest['ruff']?.available ?? false)

  if (!hasLinter) {
    return { dimension: 'code_quality', passed: true, reason: 'No linter available — code quality check skipped' }
  }
  const changeDesc = getChangeDescription(proposedChange)
  if (harnessLexicalActive('review-phrases') && (changeDesc.includes('syntax error') || changeDesc.includes('invalid code'))) {
    return { dimension: 'code_quality', passed: false, reason: 'Change description indicates code quality issues' }
  }
  return { dimension: 'code_quality', passed: true, reason: 'Code quality check passed' }
}

function checkHypothesisCompatibility(proposedChange: ProposedChange, hypothesisSet: HypothesisSet | null): DimensionResult {
  if (hypothesisSet === null) {
    return { dimension: 'hypothesis_compatibility', passed: true, reason: 'No hypothesis set provided' }
  }
  const changeDesc = getChangeDescription(proposedChange)
  for (const h of hypothesisSet.active) {
    for (const obs of h.predicted_observations) {
      const obsLower = obs.toLowerCase()
      if (isNegation(changeDesc, obsLower)) {
        return {
          dimension: 'hypothesis_compatibility',
          passed: false,
          reason: `Change contradicts predicted observation: ${JSON.stringify(obs)}`,
        }
      }
    }
  }
  return { dimension: 'hypothesis_compatibility', passed: true, reason: 'Compatible with active hypotheses' }
}

/**
 * Records a single review dimension's outcome into the per-task consecutive-failure counter
 * and derives escalation_triggered from it — the same bookkeeping reviewProposedChange itself
 * uses for its 5 lexical dimensions, exposed so an *additional* check (e.g. a semantic
 * consistency check layered on top — see harness-runtime.ts) gets identical
 * consecutive-failure/escalation treatment instead of a second, divergent mechanism.
 */
export function applyReviewOutcome(
  taskId: string,
  passed: boolean,
  consecutiveFailuresMap: Map<string, number>,
  failedDimension?: DimensionResult | DimensionResult[],
): ReviewResult {
  if (passed) {
    consecutiveFailuresMap.set(taskId, 0)
    return { passed: true, failed_dimensions: [], consecutive_failures: 0, escalation_triggered: false }
  }
  const prev = consecutiveFailuresMap.get(taskId) ?? 0
  const consec = prev + 1
  consecutiveFailuresMap.set(taskId, consec)
  return {
    passed: false,
    failed_dimensions: failedDimension === undefined ? [] : Array.isArray(failedDimension) ? failedDimension : [failedDimension],
    consecutive_failures: consec,
    escalation_triggered: consec >= ESCALATION_THRESHOLD,
  }
}

export function reviewProposedChange(
  proposedChange: ProposedChange,
  currentTask: Task | null,
  worldModel: WorldModel | null,
  outputContract: OutputContract | null,
  hypothesisSet: HypothesisSet | null,
  toolManifest: EvidenceStore | null,
  consecutiveFailuresMap: Map<string, number>,
): ReviewResult {
  const taskId = currentTask?.id ?? 'default'
  const checks: Array<() => DimensionResult> = [
    () => checkTaskAlignment(proposedChange, currentTask),
    () => checkWorldModelConsistency(proposedChange, worldModel),
    () => checkOutputContract(proposedChange, outputContract),
    () => checkCodeQuality(proposedChange, toolManifest),
    () => checkHypothesisCompatibility(proposedChange, hypothesisSet),
  ]

  // Run every dimension and collect every failure, as adapter/harness/review_gate.py's review_proposed_change() does.
  // (It used to stop at the first failing dimension, so failed_dimensions was never longer than one and the
  // review_failure site could never offer its "which fix?" question — see diagnoseReviewFailureOptions below.) The checks
  // are pure and cheap; whether the change passes is unchanged — it fails exactly when at least one dimension fails.
  const failed = checks.map((check) => check()).filter((result) => !result.passed)
  return failed.length > 0
    ? applyReviewOutcome(taskId, false, consecutiveFailuresMap, failed)
    : applyReviewOutcome(taskId, true, consecutiveFailuresMap)
}

// ── Q7 — deterministic-site question builder (the internal plan) ──
//
// Twin note: adapter/harness/review_gate.py's review_proposed_change() runs all 5 dimensions and collects every failure,
// and so does reviewProposedChange() above since 2026-09-30 (it used to short-circuit on the first failing dimension, so
// failed_dimensions was always length <= 1 and diagnoseReviewFailureOptions() below always returned undefined — the
// review_failure site in harness-runtime.ts could only ever fall back to the plain missing_info halt). Now a change that
// trips two or three dimensions at once (and has failed review twice in a row for the same task) is offered a structured
// "which fix should I apply?" question when the effective ask mode is on; a single failing dimension, or more than
// MAX_OPTIONS_PER_QUESTION, still falls back to the plain halt exactly as before.
const REVIEW_DIMENSION_FIXES: Record<ReviewDimension, string> = {
  task_alignment: 'Revise the proposed change to align with the current task description',
  world_model_consistency: 'Resolve the conflict with existing high-confidence beliefs before proceeding',
  output_contract_precheck: 'Adjust the proposed change to satisfy the output contract',
  code_quality: 'Address the code-quality issue before proceeding',
  hypothesis_compatibility: 'Reconcile the change with the active hypothesis predictions',
}

/**
 * Deterministically categorize failed review dimensions into candidate fixes — one static,
 * templated option per distinct failed dimension, no LLM call, nothing drafted from the
 * dimension's own `reason` text. Returns undefined (not an empty array) when fewer than two
 * distinct dimensions failed, or when more failed than Q0's MAX_OPTIONS_PER_QUESTION can
 * hold (silently dropping one would be worse than falling back) — both cases leave the call
 * site to fall back to today's plain missing_info halt, unchanged.
 */
export function diagnoseReviewFailureOptions(failedDimensions: DimensionResult[]): AskQuestionOption[] | undefined {
  const distinct = Array.from(new Set(failedDimensions.map((d) => d.dimension)))
  if (distinct.length < 2 || distinct.length > MAX_OPTIONS_PER_QUESTION) return undefined
  return distinct.map((d) => ({ label: REVIEW_DIMENSION_FIXES[d] }))
}

/** Wrap diagnoseReviewFailureOptions()'s output into an AskQuestion. Pure. */
export function buildReviewFailureQuestion(options: AskQuestionOption[]): AskQuestion {
  return {
    id: 'review-failure-resolution',
    question: 'The proposed change failed review. Which fix should I apply?',
    options,
  }
}
