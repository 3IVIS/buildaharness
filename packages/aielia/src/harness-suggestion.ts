/**
 * `HarnessSuggestion` (plan section 5): one proposed change to one registered surface, with the reasoning and the
 * expectations a later check can hold it to. `fromJSON` is TOTAL, like `SupervisorDirective.fromJSON`: anything
 * unknown or malformed degrades to a no-op suggestion (empty surface id, `change.kind === 'noop'`) that the validator
 * rejects, never a throw and never a partially trusted object.
 */
import type { SurfaceClass } from './harness-surfaces.js'

export const SUGGESTION_STATUSES = ['proposed', 'verified', 'quarantined', 'accepted', 'dismissed', 'applied', 'reverted', 'expired'] as const
export type SuggestionStatus = (typeof SUGGESTION_STATUSES)[number]

export const SUGGESTION_TIERS = [1, 2] as const
export type SuggestionTier = (typeof SUGGESTION_TIERS)[number]

/** The change, typed by surface. `noop` is what a malformed input degrades to. `set` carries the new slot value. */
export type SuggestionChange =
  | { kind: 'noop' }
  | { kind: 'set'; value: boolean | number | string; /** Layer ids or setting slots the authored change refers to. */ references?: string[] }

export interface SuggestionValidity {
  harnessVersionMin?: string
  harnessVersionMax?: string
  backend?: string
  modelFamily?: string
  /** Epoch milliseconds. */
  expiresAt?: number
}

export interface SuggestionDecision {
  by: 'user' | 'gate' | 'system'
  outcome: string
  reason: string
  at?: number
}

export interface HarnessSuggestion {
  id: string
  tier: SuggestionTier
  surfaceId: string
  class: SurfaceClass
  /** Structure-only signature of the weakness cluster this answers. */
  clusterSignature: string
  change: SuggestionChange
  whyNotNoop: string
  regressionGuard: string
  expectedEffect: string
  expectedAffectedCases: string[]
  protectedCases: string[]
  expectedBeacon: string
  evidenceRefs: string[]
  /** Capabilities the change needs beyond the default grant. */
  capabilityNeeds: string[]
  validity: SuggestionValidity
  fingerprint: string
  status: SuggestionStatus
  decision?: SuggestionDecision
  parentId?: string
}

/** FNV-1a, 32 bit, hex. Stable across runs; not a security hash. */
function hash32(s: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0')
}

/** JSON with object keys sorted, so equal structures serialise equally. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

/** A stable hash of surface id, change and cluster signature. Authored prose and ids do not enter it. */
export function suggestionFingerprint(surfaceId: string, change: SuggestionChange, clusterSignature: string): string {
  const { references: _refs, ...rest } = change as { references?: string[] } & SuggestionChange
  return hash32(stableStringify({ surfaceId, change: rest, clusterSignature }))
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : ''
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []
}

function parseChange(v: unknown): SuggestionChange {
  if (!v || typeof v !== 'object') return { kind: 'noop' }
  const o = v as Record<string, unknown>
  if (o.kind !== 'set') return { kind: 'noop' }
  const value = o.value
  if (typeof value !== 'boolean' && typeof value !== 'string' && !(typeof value === 'number' && Number.isFinite(value))) return { kind: 'noop' }
  const references = Array.isArray(o.references) ? strList(o.references) : undefined
  return references ? { kind: 'set', value, references } : { kind: 'set', value }
}

function parseValidity(v: unknown): SuggestionValidity {
  if (!v || typeof v !== 'object') return {}
  const o = v as Record<string, unknown>
  const out: SuggestionValidity = {}
  for (const k of ['harnessVersionMin', 'harnessVersionMax', 'backend', 'modelFamily'] as const) {
    if (typeof o[k] === 'string' && o[k]) out[k] = o[k] as string
  }
  if (typeof o.expiresAt === 'number' && Number.isFinite(o.expiresAt)) out.expiresAt = o.expiresAt
  return out
}

function parseDecision(v: unknown): SuggestionDecision | undefined {
  if (!v || typeof v !== 'object') return undefined
  const o = v as Record<string, unknown>
  if (o.by !== 'user' && o.by !== 'gate' && o.by !== 'system') return undefined
  const d: SuggestionDecision = { by: o.by, outcome: str(o.outcome), reason: str(o.reason) }
  if (typeof o.at === 'number' && Number.isFinite(o.at)) d.at = o.at
  return d
}

/** Total: never throws. The fingerprint is recomputed, never trusted from the input. */
export function suggestionFromJSON(json: unknown): HarnessSuggestion {
  const o = json && typeof json === 'object' && !Array.isArray(json) ? (json as Record<string, unknown>) : {}
  const surfaceId = str(o.surfaceId)
  const clusterSignature = str(o.clusterSignature)
  let change = parseChange(o.change)
  const known = surfaceId !== ''
  if (!known) change = { kind: 'noop' }
  const status = (SUGGESTION_STATUSES as readonly unknown[]).includes(o.status) ? (o.status as SuggestionStatus) : 'proposed'
  const decision = parseDecision(o.decision)
  const parentId = str(o.parentId)
  return {
    id: str(o.id),
    tier: o.tier === 1 ? 1 : 2,
    surfaceId,
    class: o.class === 'E' ? 'E' : 'I',
    clusterSignature,
    change,
    whyNotNoop: str(o.whyNotNoop),
    regressionGuard: str(o.regressionGuard),
    expectedEffect: str(o.expectedEffect),
    expectedAffectedCases: strList(o.expectedAffectedCases),
    protectedCases: strList(o.protectedCases),
    expectedBeacon: str(o.expectedBeacon),
    evidenceRefs: strList(o.evidenceRefs),
    capabilityNeeds: strList(o.capabilityNeeds),
    validity: parseValidity(o.validity),
    fingerprint: suggestionFingerprint(surfaceId, change, clusterSignature),
    status,
    ...(decision ? { decision } : {}),
    ...(parentId ? { parentId } : {}),
  }
}

export function isNoopSuggestion(s: HarnessSuggestion): boolean {
  return s.change.kind === 'noop'
}
