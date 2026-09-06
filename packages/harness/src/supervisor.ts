// Trajectory Supervisor — types + flag (S0 of
// plans/harness_trajectory_supervisor_plan.html). TS twin of
// adapter/harness/supervisor.py.
//
// A slow-loop meta-controller that intervenes *only* on the cannot_make_progress()
// stall edge (and, from S1, a reviewer-HIGH streak). This module holds the closed
// directive enum and its payload types. buildDigest() lives in trajectory-digest.ts;
// decide() (the single LLM call) is wired in S2 — nothing here calls a model.
//
// fromJSON on every type here is TOTAL: an out-of-enum action, or an action whose
// required payload is missing, degrades to CONTINUE rather than throwing. This is the
// enum-safety contract from the plan's testing section, and it must stay
// byte-identical to supervisor.py's from_dict().

const FLAG_ENV = 'HARNESS_TRAJECTORY_SUPERVISOR'
const TRUTHY = new Set(['1', 'true', 'yes', 'on', 'enabled'])

/** True iff HARNESS_TRAJECTORY_SUPERVISOR is set to a truthy value. Default OFF.
 *  `env` defaults to process.env when available (Node); pass explicitly in the browser. */
export function supervisorEnabled(env?: Record<string, string | undefined>): boolean {
  const source = env ?? (typeof process !== 'undefined' ? process.env : {})
  return TRUTHY.has(String(source[FLAG_ENV] ?? '').trim().toLowerCase())
}

export const SUPERVISOR_ACTIONS = [
  'CONTINUE',
  'REDIRECT_STRATEGY',
  'REFRAME_PLAN',
  'GATHER_EVIDENCE',
  'ASK_USER',
  'ABORT',
] as const
export type SupervisorAction = (typeof SUPERVISOR_ACTIONS)[number]

const ACTION_SET: Set<string> = new Set(SUPERVISOR_ACTIONS)

const MAX_STR = 600
const MAX_TOOLS = 8

function clip(text: unknown, limit = MAX_STR): string {
  const s = String(text ?? '').trim()
  return s.length <= limit ? s : s.slice(0, limit - 1) + '…'
}

// ── Payload types ──────────────────────────────────────────────────────────

export interface InvestigationRequestData {
  question: string
  suggested_tools: string[]
  budget: number
}

export class InvestigationRequest {
  question: string
  suggested_tools: string[]
  budget: number

  constructor(data?: Partial<InvestigationRequestData>) {
    this.question = data?.question ?? ''
    this.suggested_tools = data?.suggested_tools ?? []
    this.budget = data?.budget ?? 5
  }

  toJSON(): InvestigationRequestData {
    return { question: this.question, suggested_tools: [...this.suggested_tools], budget: this.budget }
  }

  static fromJSON(json: unknown): InvestigationRequest | null {
    if (json === null || typeof json !== 'object' || Array.isArray(json)) return null
    const d = json as Record<string, unknown>
    const tools = (Array.isArray(d.suggested_tools) ? d.suggested_tools : [])
      .filter(t => String(t ?? '').trim())
      .map(t => clip(t, 120))
      .slice(0, MAX_TOOLS)
    let budget = Number(d.budget ?? 5)
    if (!Number.isFinite(budget)) budget = 5
    budget = Math.max(0, Math.min(Math.trunc(budget), 50))
    return new InvestigationRequest({ question: clip(d.question ?? ''), suggested_tools: tools, budget })
  }
}

export interface UserQuestionData {
  question: string
  options: string[]
}

export class UserQuestion {
  question: string
  options: string[]

  constructor(data?: Partial<UserQuestionData>) {
    this.question = data?.question ?? ''
    this.options = data?.options ?? []
  }

  toJSON(): UserQuestionData {
    return { question: this.question, options: [...this.options] }
  }

  static fromJSON(json: unknown): UserQuestion | null {
    if (json === null || typeof json !== 'object' || Array.isArray(json)) return null
    const d = json as Record<string, unknown>
    const opts = (Array.isArray(d.options) ? d.options : [])
      .filter(o => String(o ?? '').trim())
      .map(o => clip(o, 200))
      .slice(0, MAX_TOOLS)
    return new UserQuestion({ question: clip(d.question ?? ''), options: opts })
  }
}

// ── The directive ─────────────────────────────────────────────────────────

export interface SupervisorDirectiveData {
  action: SupervisorAction
  rationale: string
  strategy_hint: string | null
  plan_note: string | null
  investigation: InvestigationRequestData | null
  question: UserQuestionData | null
}

export class SupervisorDirective {
  action: SupervisorAction
  rationale: string
  strategy_hint: string | null
  plan_note: string | null
  investigation: InvestigationRequest | null
  question: UserQuestion | null

  constructor(data?: Partial<{
    action: SupervisorAction
    rationale: string
    strategy_hint: string | null
    plan_note: string | null
    investigation: InvestigationRequest | null
    question: UserQuestion | null
  }>) {
    this.action = data?.action ?? 'CONTINUE'
    this.rationale = data?.rationale ?? ''
    this.strategy_hint = data?.strategy_hint ?? null
    this.plan_note = data?.plan_note ?? null
    this.investigation = data?.investigation ?? null
    this.question = data?.question ?? null
  }

  /** A CONTINUE directive — the deterministic ladder proceeds unchanged. */
  static cont(rationale = ''): SupervisorDirective {
    return new SupervisorDirective({ action: 'CONTINUE', rationale: clip(rationale) })
  }

  toJSON(): SupervisorDirectiveData {
    return {
      action: this.action,
      rationale: this.rationale,
      strategy_hint: this.strategy_hint,
      plan_note: this.plan_note,
      investigation: this.investigation ? this.investigation.toJSON() : null,
      question: this.question ? this.question.toJSON() : null,
    }
  }

  static fromJSON(json: unknown): SupervisorDirective {
    if (json === null || typeof json !== 'object' || Array.isArray(json)) return SupervisorDirective.cont()
    const d = json as Record<string, unknown>

    const action = d.action
    if (typeof action !== 'string' || !ACTION_SET.has(action)) {
      return SupervisorDirective.cont(clip(d.rationale ?? ''))
    }

    const rationale = clip(d.rationale ?? '')
    const strategyHint = d.strategy_hint ? clip(d.strategy_hint, 200) : null
    const planNote = d.plan_note ? clip(d.plan_note) : null
    const investigation = InvestigationRequest.fromJSON(d.investigation)
    const question = UserQuestion.fromJSON(d.question)

    // Payload-shape safety: an action missing its required payload → CONTINUE.
    if (action === 'REDIRECT_STRATEGY' && !strategyHint) return SupervisorDirective.cont(rationale)
    if (action === 'REFRAME_PLAN' && !planNote) return SupervisorDirective.cont(rationale)
    if (action === 'GATHER_EVIDENCE' && (!investigation || !investigation.question)) {
      return SupervisorDirective.cont(rationale)
    }
    if (action === 'ASK_USER' && (!question || !question.question)) return SupervisorDirective.cont(rationale)

    return new SupervisorDirective({
      action: action as SupervisorAction,
      rationale,
      strategy_hint: strategyHint,
      plan_note: planNote,
      investigation: action === 'GATHER_EVIDENCE' ? investigation : null,
      question: action === 'ASK_USER' ? question : null,
    })
  }
}

// ── S2 driveMainLoop wiring helper ──────────────────────────────────────────
//
// loop.py (S1, Python) inlines this coercion + fail-open logic in its stall branch,
// which its synchronous unit tests drive directly. driveMainLoop is far harder to
// force into the failed-task-rollback-under-stall state from a unit test, so on the
// TS side the same logic is extracted here and tested in isolation. The two must
// stay behaviourally identical.

import type { TrajectoryDigestData } from './trajectory-digest.js'

const S2_UNWIRED_ACTIONS = new Set<SupervisorAction>(['GATHER_EVIDENCE', 'ASK_USER', 'ABORT'])

/** REDIRECT_STRATEGY / REFRAME_PLAN / CONTINUE are wired in S2; everything else
 *  degrades to CONTINUE (carrying the original rationale) until S3–S6. */
export function coerceForWiredActions(directive: SupervisorDirective): SupervisorDirective {
  if (S2_UNWIRED_ACTIONS.has(directive.action)) {
    return SupervisorDirective.cont(`[not wired: ${directive.action}] ${directive.rationale}`)
  }
  return directive
}

/** Run the caller's async decider on a stall digest, coerce the result, and report
 *  it once. Never throws: a decider that rejects, a malformed body, or a throwing
 *  onDirective handler all resolve to a safe CONTINUE. */
export async function resolveSupervisorDirective(
  decider: (digest: TrajectoryDigestData) => Promise<Partial<SupervisorDirectiveData> | null>,
  digest: TrajectoryDigestData,
  onDirective?: (directive: SupervisorDirective) => void,
): Promise<SupervisorDirective> {
  let raw: Partial<SupervisorDirectiveData> | null = null
  try {
    raw = await decider(digest)
  } catch {
    raw = null // fail open → CONTINUE
  }
  const directive = coerceForWiredActions(SupervisorDirective.fromJSON(raw))
  try {
    onDirective?.(directive)
  } catch {
    /* an observability handler must never break the run */
  }
  return directive
}
