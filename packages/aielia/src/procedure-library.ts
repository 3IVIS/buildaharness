/**
 * Reusable procedures, read side: a validated entry shape for the four experience-store procedure classes
 * (decomposition, tool workflow, verification plan, recovery sequence), and one bounded hint for planning.
 * An entry carries its evidence status, a stated "when to use" condition, preconditions and checks (the lightweight
 * contract), a verification step and a size cap. Unknown keys are rejected, so an entry cannot carry task
 * identifiers or other case-specific fields. Only the description, status and condition reach the prompt; the
 * body (steps) stays out until asked for. An empty or non-matching library renders nothing, and the prompt passes
 * through byte for byte. Pure: no node:* and no DOM imports.
 */

export const PROCEDURE_CLASSES = ['decomposition', 'tool_workflow', 'verification_plan', 'recovery_sequence'] as const
export type ProcedureClass = (typeof PROCEDURE_CLASSES)[number]

export const EVIDENCE_STATUSES = ['provisional', 'screened', 'certified'] as const
export type ProcedureEvidenceStatus = (typeof EVIDENCE_STATUSES)[number]

/** Limits enforced by the shape check; an entry over any of them is rejected, never truncated. */
export const PROCEDURE_LIMITS = {
  idChars: 64,
  descriptionChars: 200,
  conditionChars: 200,
  listItems: 8,
  itemChars: 200,
  bodyChars: 1200,
} as const

/** How many hints one planning call may show, and the total characters they may take. */
export const PROCEDURE_HINT_MAX_ENTRIES = 3
export const PROCEDURE_HINT_MAX_CHARS = 700

export interface ProcedureEntry {
  id: string
  procedureClass: ProcedureClass
  evidenceStatus: ProcedureEvidenceStatus
  /** One line shown in context. */
  description: string
  whenToUse: {
    /** Structural class of the task this applies to (for example 'multi_step_plan'); matched exactly. */
    taskClass: string
    condition: string
  }
  preconditions: string[]
  checks: string[]
  /** How to confirm the procedure did its job. Required. */
  verification: string
  /** The body: read on demand, never injected by the hint. */
  steps: string[]
}

const ENTRY_KEYS = new Set(['id', 'procedureClass', 'evidenceStatus', 'description', 'whenToUse', 'preconditions', 'checks', 'verification', 'steps'])
const WHEN_KEYS = new Set(['taskClass', 'condition'])

export type ProcedureParse = { ok: true; entry: ProcedureEntry } | { ok: false; reason: string }

function text(v: unknown, max: number): string | null {
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t !== '' && t.length <= max ? t : null
}

function list(v: unknown, requireNonEmpty: boolean): string[] | null {
  if (!Array.isArray(v) || v.length > PROCEDURE_LIMITS.listItems) return null
  const out: string[] = []
  for (const item of v) {
    const t = text(item, PROCEDURE_LIMITS.itemChars)
    if (t === null) return null
    out.push(t)
  }
  return requireNonEmpty && out.length === 0 ? null : out
}

function onlyKeys(obj: object, allowed: Set<string>): boolean {
  return Object.keys(obj).every(k => allowed.has(k))
}

/** Validates one candidate entry. A rejected entry is reported with the reason, never repaired. */
export function parseProcedureEntry(raw: unknown): ProcedureParse {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return { ok: false, reason: 'not an object' }
  const o = raw as Record<string, unknown>
  if (!onlyKeys(o, ENTRY_KEYS)) return { ok: false, reason: 'unknown key' }
  const id = text(o.id, PROCEDURE_LIMITS.idChars)
  if (id === null || !/^[\w.\-]+$/.test(id)) return { ok: false, reason: 'bad id' }
  if (!(PROCEDURE_CLASSES as readonly unknown[]).includes(o.procedureClass)) return { ok: false, reason: 'bad procedureClass' }
  if (!(EVIDENCE_STATUSES as readonly unknown[]).includes(o.evidenceStatus)) return { ok: false, reason: 'bad evidenceStatus' }
  const description = text(o.description, PROCEDURE_LIMITS.descriptionChars)
  if (description === null) return { ok: false, reason: 'bad description' }
  const w = o.whenToUse
  if (typeof w !== 'object' || w === null || Array.isArray(w) || !onlyKeys(w, WHEN_KEYS)) return { ok: false, reason: 'bad whenToUse' }
  const taskClass = text((w as Record<string, unknown>).taskClass, PROCEDURE_LIMITS.idChars)
  const condition = text((w as Record<string, unknown>).condition, PROCEDURE_LIMITS.conditionChars)
  if (taskClass === null || condition === null) return { ok: false, reason: 'bad whenToUse' }
  const preconditions = list(o.preconditions, false)
  const checks = list(o.checks, false)
  const steps = list(o.steps, true)
  if (preconditions === null) return { ok: false, reason: 'bad preconditions' }
  if (checks === null) return { ok: false, reason: 'bad checks' }
  if (steps === null) return { ok: false, reason: 'bad steps' }
  const verification = text(o.verification, PROCEDURE_LIMITS.itemChars)
  if (verification === null) return { ok: false, reason: 'missing verification' }
  const entry: ProcedureEntry = {
    id, procedureClass: o.procedureClass as ProcedureClass, evidenceStatus: o.evidenceStatus as ProcedureEvidenceStatus,
    description, whenToUse: { taskClass, condition }, preconditions, checks, verification, steps,
  }
  if (JSON.stringify(entry).length > PROCEDURE_LIMITS.bodyChars) return { ok: false, reason: 'over size cap' }
  return { ok: true, entry }
}

/** Keeps the valid entries of whatever a loader returned; duplicates by id keep the first. Junk gives []. */
export function parseProcedureLibrary(raw: unknown): ProcedureEntry[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: ProcedureEntry[] = []
  for (const item of raw) {
    const r = parseProcedureEntry(item)
    if (r.ok && !seen.has(r.entry.id)) {
      seen.add(r.entry.id)
      out.push(r.entry)
    }
  }
  return out
}

const STATUS_RANK: Record<ProcedureEvidenceStatus, number> = { certified: 0, screened: 1, provisional: 2 }

/** Entries of a class whose structural task class matches, strongest evidence first, capped. */
export function matchProcedures(library: readonly ProcedureEntry[] | undefined, procedureClass: ProcedureClass, taskClass: string): ProcedureEntry[] {
  if (!library || library.length === 0) return []
  return library
    .filter(e => e.procedureClass === procedureClass && e.whenToUse.taskClass === taskClass)
    .sort((a, b) => STATUS_RANK[a.evidenceStatus] - STATUS_RANK[b.evidenceStatus])
    .slice(0, PROCEDURE_HINT_MAX_ENTRIES)
}

/** The bounded hint: description-only, evidence status shown on every line. '' when nothing matches. */
export function renderProcedureHint(library: readonly ProcedureEntry[] | undefined, procedureClass: ProcedureClass, taskClass: string): string {
  const lines: string[] = []
  let used = 0
  for (const e of matchProcedures(library, procedureClass, taskClass)) {
    const line = `- (${e.evidenceStatus}) ${e.description.replace(/[\[\]\s]+/g, ' ')} Use when: ${e.whenToUse.condition.replace(/[\[\]\s]+/g, ' ')}`
    if (used + line.length > PROCEDURE_HINT_MAX_CHARS) break
    lines.push(line)
    used += line.length
  }
  return lines.length === 0 ? '' : `\n\n[Known procedures, hints only; the user's request comes first:\n${lines.join('\n')}]`
}

/** The single planning insertion point: `prompt` unchanged (same string) when no entry matches. */
export function withProcedureHint(prompt: string, library: readonly ProcedureEntry[] | undefined, procedureClass: ProcedureClass, taskClass: string): string {
  const hint = renderProcedureHint(library, procedureClass, taskClass)
  return hint === '' ? prompt : prompt + hint
}

/** The body of one entry, for when the model or user asks for it by id. */
export function procedureBody(library: readonly ProcedureEntry[] | undefined, id: string): string | undefined {
  const e = library?.find(x => x.id === id)
  if (!e) return undefined
  return `(${e.evidenceStatus}) ${e.description}\nPreconditions: ${e.preconditions.join('; ') || 'none'}\nSteps:\n${e.steps.map((s, i) => `${i + 1}. ${s}`).join('\n')}\nChecks: ${e.checks.join('; ') || 'none'}\nVerify: ${e.verification}`
}
