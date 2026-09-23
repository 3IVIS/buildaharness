/**
 * Whether PersonalAssistant wires the Trajectory Supervisor (docs/adr/005-trajectory-supervisor.md)
 * into the harness: the stall-edge `supervisorDecider`, the `askUser` host, and the read-only
 * `runInvestigation` host for GATHER_EVIDENCE.
 *
 * The harness library's own `supervisorEnabled()` (packages/harness/src/supervisor.ts, twinned with
 * adapter/harness/supervisor.py and conformance-tested) stays default OFF — that default belongs to
 * the library and to its other callers. aielia, the shipped assistant, resolves its own default
 * here: **ON** as of 2026-09-23. The supervisor only ever makes an LLM call on the
 * `cannot_make_progress()` stall edge (INV-22 — never on a healthy iteration), so a turn that never
 * stalls is byte-identical either way; the cost is one bounded call per stall.
 *
 * Same env var as the harness (`HARNESS_TRAJECTORY_SUPERVISOR`), so existing tooling and the eval
 * arms keep working; unlike the harness, an unset or empty value means enabled, and an explicit
 * falsy value is the escape hatch. An unrecognized value falls back to the default with a warning
 * (the typo-tolerance convention normalizeOneLoopMode/normalizeAskMode use).
 */
export const SUPERVISOR_ENV = 'HARNESS_TRAJECTORY_SUPERVISOR'
export const DEFAULT_SUPERVISOR_ENABLED = true

const TRUTHY = new Set(['1', 'true', 'yes', 'on', 'enabled'])
const FALSY = new Set(['0', 'false', 'no', 'off', 'disabled'])

export function resolveSupervisorEnabled(env: Record<string, string | undefined> = process.env): boolean {
  const raw = (env[SUPERVISOR_ENV] ?? '').trim().toLowerCase()
  if (raw === '') return DEFAULT_SUPERVISOR_ENABLED
  if (TRUTHY.has(raw)) return true
  if (FALSY.has(raw)) return false
  console.error(`[warning] ${SUPERVISOR_ENV}="${env[SUPERVISOR_ENV]}" is not a recognized on/off value — using the default (${DEFAULT_SUPERVISOR_ENABLED ? 'enabled' : 'disabled'}).`)
  return DEFAULT_SUPERVISOR_ENABLED
}
