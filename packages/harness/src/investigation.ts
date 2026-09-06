// Bounded read-only investigation sub-agent — S5 of
// plans/harness_trajectory_supervisor_plan.html (GATHER_EVIDENCE). TS twin of
// adapter/harness/investigation.py.
//
// When the Trajectory Supervisor emits a GATHER_EVIDENCE directive at a stall edge,
// the harness runs a bounded read-only investigation (via a host-provided callback —
// see HarnessRunOptions.runInvestigation) and merges the findings back into the
// parent WorldModel as provenanced observations, bumping the generation id so
// staleness + contradiction detection re-run over them.
//
// Invariants (mirrors the Python module, CI-gated from S4/S5):
//   INV-23  Investigation sub-agents have no write / shell / email tools —
//           suggested_tools is filtered to INVESTIGATION_READ_ONLY_TOOLS before any
//           dispatch (validateInvestigationTools).
//   INV-24  Investigation depth is capped at 1 — runInvestigation(depth>=1) throws.
//   INV-25  Every investigation runs under its own bounded call budget; a tool that
//           hangs past perCallTimeoutMs is abandoned and the run still returns.

import type { Observation, WorldModel } from './state/world-model.js'
import { SupervisorDirective, type InvestigationRequestData } from './supervisor.js'

/** Read-only fn_ref subset an investigation may touch. A tool not in this set —
 *  including every write / shell / email tool — is rejected before dispatch (INV-23).
 *  Kept byte-identical to investigation.py's INVESTIGATION_READ_ONLY_TOOLS. */
export const INVESTIGATION_READ_ONLY_TOOLS: ReadonlySet<string> = new Set([
  'retrieve',
  'rag_retrieve',
  'kb_retrieve',
  'search',
  'web_search',
  'fetch_url',
  'http_get',
  'read_file',
  'list_directory',
  'get_session_state',
  'list_reminders',
  'lookup',
])

/** Named for clarity / logging; membership in the allowlist above is what gates dispatch. */
export const INVESTIGATION_FORBIDDEN_TOOLS: ReadonlySet<string> = new Set([
  'write_file',
  'run_shell_command',
  'shell',
  'exec',
  'send_email',
  'deploy',
  'apply_patch',
])

const MAX_DEPTH = 1
const MAX_CALL_BUDGET = 20
const DEFAULT_PER_CALL_TIMEOUT_MS = 15_000
const MAX_FINDING_LEN = 800

export class InvestigationDepthExceededError extends Error {
  constructor(depth: number) {
    super(
      `investigation depth ${depth} >= ${MAX_DEPTH}: an investigation cannot spawn an investigation (INV-24)`,
    )
    this.name = 'InvestigationDepthExceededError'
  }
}

function clip(text: unknown, limit = MAX_FINDING_LEN): string {
  const s = String(text ?? '').trim()
  return s.length <= limit ? s : s.slice(0, limit - 1) + '…'
}

export interface InvestigationFinding {
  content: string
  tool: string
  reliability: 'MEDIUM' | 'HIGH'
}

export interface InvestigationOutcome {
  findings: InvestigationFinding[]
  callsMade: number
  exhausted: boolean
  rejectedTools: string[]
}

export interface InvestigationRequestLike {
  question?: string
  suggested_tools?: string[]
  budget?: number
}

/** A host-supplied read-only tool call: (toolName, question) → result string | null.
 *  May be sync or async. Faults / hangs are isolated by runInvestigation. */
export type InvestigationToolRunner = (tool: string, question: string) => string | null | Promise<string | null>

/** Split a suggested-tool list into { allowed, rejected }. INV-23. Byte-identical to
 *  investigation.py's validate_investigation_tools(). */
export function validateInvestigationTools(tools: readonly string[] | undefined): {
  allowed: string[]
  rejected: string[]
} {
  const allowed: string[] = []
  const rejected: string[] = []
  for (const raw of tools ?? []) {
    const name = String(raw ?? '').trim()
    if (!name) continue
    if (INVESTIGATION_READ_ONLY_TOOLS.has(name)) allowed.push(name)
    else rejected.push(name)
  }
  return { allowed, rejected }
}

async function callToolBounded(
  toolRunner: InvestigationToolRunner,
  tool: string,
  question: string,
  timeoutMs: number,
): Promise<string | null> {
  // A hung tool call must not wedge the loop (INV-25). Promise.race against a timer;
  // a rejection or timeout yields null rather than propagating. The straggler promise
  // is abandoned.
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => resolve(null), timeoutMs)
  })
  try {
    const result = await Promise.race([Promise.resolve().then(() => toolRunner(tool, question)), timeout])
    return result ?? null
  } catch {
    return null
  } finally {
    if (timer) clearTimeout(timer)
  }
}

/** Run one bounded read-only investigation. `depth` >= 1 throws (INV-24). Never
 *  rejects for tool faults — a tool that throws, returns nothing, or hangs past
 *  `perCallTimeoutMs` is skipped and counted (INV-25). */
export async function runInvestigation(
  request: InvestigationRequestLike,
  opts: {
    toolRunner: InvestigationToolRunner
    toolReliability?: Record<string, string>
    depth?: number
    perCallTimeoutMs?: number
  },
): Promise<InvestigationOutcome> {
  const depth = opts.depth ?? 0
  if (depth >= MAX_DEPTH) throw new InvestigationDepthExceededError(depth)

  const question = clip(request.question ?? '', 600)
  const rawBudget = Number(request.budget ?? 5)
  const budget = Math.max(0, Math.min(Number.isFinite(rawBudget) ? Math.trunc(rawBudget) : 5, MAX_CALL_BUDGET))
  const { allowed, rejected } = validateInvestigationTools(request.suggested_tools)

  const outcome: InvestigationOutcome = { findings: [], callsMade: 0, exhausted: false, rejectedTools: rejected }
  if (!question || allowed.length === 0 || budget === 0) {
    outcome.exhausted = allowed.length > 0 && budget === 0
    return outcome
  }

  const timeoutMs = opts.perCallTimeoutMs ?? DEFAULT_PER_CALL_TIMEOUT_MS
  for (const tool of allowed) {
    if (outcome.callsMade >= budget) {
      outcome.exhausted = true
      break
    }
    outcome.callsMade++
    const raw = await callToolBounded(opts.toolRunner, tool, question, timeoutMs)
    const text = clip(raw)
    if (!text) continue
    const reliability = opts.toolReliability?.[tool] === 'HIGH' ? 'HIGH' : 'MEDIUM'
    outcome.findings.push({ content: text, tool, reliability })
  }

  if (!outcome.exhausted && outcome.callsMade < allowed.length) outcome.exhausted = true
  return outcome
}

let _obsCounter = 0

/** Merge investigation findings into the parent WorldModel as provenanced
 *  observations (source="supervisor_investigation"), then bump the generation id so
 *  staleness + contradiction detection re-run. Mirrors merge_investigation_findings()
 *  in the Python twin (Observation has no derived_from field — INV-01 is belief-level;
 *  provenance is `source` plus a content prefix). */
export function mergeInvestigationFindings(
  worldModel: WorldModel,
  findings: readonly InvestigationFinding[],
  meta: { question: string },
): Observation[] {
  const q = clip(meta.question, 300).replace(/]/g, ' ')
  const merged: Observation[] = []
  for (const finding of findings) {
    const obs: Observation = {
      id: `supervisor_investigation:${(++_obsCounter).toString(36)}${Date.now().toString(36)}`,
      content:
        `[supervisor_investigation q=${q}] ` +
        `[tool=${finding.tool} reliability=${finding.reliability} ` +
        `derived_from=supervisor_investigation] ${finding.content}`,
      source: 'supervisor_investigation',
      recorded_at: new Date().toISOString(),
    }
    worldModel.observations.push(obs)
    merged.push(obs)
  }
  worldModel.incrementGenerationId()
  return merged
}

/** Distinct investigations already merged this run — used for the per-run cap K.
 *  Counts unique `[supervisor_investigation q=…]` prefixes so multiple findings from
 *  one investigation count once. Mirrors count_investigations() in the Python twin. */
export function countInvestigations(worldModel: WorldModel): number {
  const seen = new Set<string>()
  for (const obs of worldModel.observations ?? []) {
    if (obs.source === 'supervisor_investigation' && obs.content.startsWith('[supervisor_investigation ')) {
      seen.add(obs.content.split(']', 1)[0])
    }
  }
  return seen.size
}

/** Per-run cap K on supervisor investigations (Q4). Beyond it, GATHER_EVIDENCE
 *  degrades — to ASK_USER once wired, to CONTINUE today. Same value as loop.py's
 *  _SUPERVISOR_INVESTIGATION_CAP. */
export const INVESTIGATION_CAP_K = 3

/** A host-provided bounded read-only investigation: request → findings. The host
 *  runs its own tool loop (own Budget, tool-policy gate). Absent → GATHER_EVIDENCE
 *  degrades to CONTINUE. */
export type RunInvestigationHost = (req: InvestigationRequestData) => Promise<InvestigationFinding[]>

/**
 * Resolve a GATHER_EVIDENCE directive at a stall edge (S5). Runs the host
 * investigation, merges its findings into `worldModel` with provenance + a
 * generation bump, and returns a coerced CONTINUE so the deterministic ladder
 * proceeds over the new evidence. Degrades to CONTINUE — carrying a labelled
 * rationale — when: no host callback, per-run cap K already hit, or the host
 * throws / rejects. Never throws.
 *
 * loop.py (S4, Python) does the equivalent split across run_one_iteration()'s
 * early-return + the driver's run_investigation()/merge_investigation_findings();
 * the two must stay behaviourally identical for the degradation + cap rules.
 */
export async function resolveGatherEvidence(
  worldModel: WorldModel,
  directive: SupervisorDirective,
  host: RunInvestigationHost | undefined,
): Promise<SupervisorDirective> {
  if (!host || !directive.investigation) {
    return SupervisorDirective.cont(`[not wired: GATHER_EVIDENCE] ${directive.rationale}`)
  }
  if (countInvestigations(worldModel) >= INVESTIGATION_CAP_K) {
    return SupervisorDirective.cont(`[investigation cap ${INVESTIGATION_CAP_K} reached] ${directive.rationale}`)
  }
  const req = directive.investigation.toJSON()
  let findings: InvestigationFinding[]
  try {
    findings = (await host(req)) ?? []
  } catch {
    return SupervisorDirective.cont(`[investigation failed] ${directive.rationale}`)
  }
  if (findings.length > 0) mergeInvestigationFindings(worldModel, findings, { question: req.question })
  return SupervisorDirective.cont(`[investigation done] ${directive.rationale}`)
}
