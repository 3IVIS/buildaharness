import { z } from 'zod'
import { MEMORY_EVENT_KINDS, MEMORY_REASON_CODES, MEMORY_SOURCE_TYPES, MEMORY_DECIDED_BY, MEMORY_EVENT_STORE_KEY, MEMORY_EVENT_KEEP } from './_memory-core-generated.js'
import type { UserFact } from './fact-extraction.js'

/**
 * One record per memory transition: what changed, WHY (a closed, countable reason code) and which
 * sources justified it. Pure (no I/O, no clock): `MemoryService` builds events from the changes it
 * makes and hands them to an `EventSink`. The wire enums come from the shared contract
 * (`spec/memory-core.json`), so the Python twin sees the same names.
 *
 * Privacy: an event holds ids and codes, never fact text, unless the caller asks for images
 * (`withImages`, tied to the audit log flag). `factKey()` is a one-way id, so an event about a
 * forgotten fact reveals nothing; `scrubForgotten()` also drops the quotes and images of every
 * earlier event about it.
 */
export const MEMORY_EVENTS_KEY: string = MEMORY_EVENT_STORE_KEY
export const MEMORY_EVENTS_KEEP: number = MEMORY_EVENT_KEEP

export const MemoryEventKindSchema = z.enum(MEMORY_EVENT_KINDS)
export const ReasonCodeSchema = z.enum(MEMORY_REASON_CODES)
export const SourceRefSchema = z.object({
  type: z.enum(MEMORY_SOURCE_TYPES),
  /** messageId | toolCallId | factKey | command name. */
  ref: z.string(),
  /** Short justification the reader sees; present only with images on, and removed when the fact is forgotten. */
  quote: z.string().optional(),
})
export const MemoryEventSchema = z.object({
  seq: z.number().int(),
  at: z.string(),
  session: z.string(),
  turn: z.string(),
  kind: MemoryEventKindSchema,
  /** `factKey()` of the fact the event is about (the pre-image for a supersession). */
  factId: z.string(),
  /** `factKey()` of the replacement, for a supersession. */
  afterFactId: z.string().optional(),
  attributeKey: z.string().optional(),
  store: z.enum(['durable', 'pending', 'rejected', 'session']).optional(),
  before: z.object({ text: z.string() }).passthrough().optional(),
  after: z.object({ text: z.string() }).passthrough().optional(),
  reason: ReasonCodeSchema,
  sources: z.array(SourceRefSchema),
  decidedBy: z.enum(MEMORY_DECIDED_BY),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  group: z.string().optional(),
})

export type MemoryEventKind = z.infer<typeof MemoryEventKindSchema>
export type ReasonCode = z.infer<typeof ReasonCodeSchema>
export type SourceRef = z.infer<typeof SourceRefSchema>
export type MemoryEvent = z.infer<typeof MemoryEventSchema>
export type MemoryEventDraft = Omit<MemoryEvent, 'seq' | 'at'>

export interface EventSink {
  emit(events: MemoryEvent[]): void | Promise<void>
}

export class InMemoryEventSink implements EventSink {
  readonly events: MemoryEvent[] = []
  emit(events: MemoryEvent[]): void {
    this.events.push(...events)
  }
}

/** Stable, non-reversible id for a fact (FNV-1a over `text|extractedAt`): lets events point at a fact without carrying its words. */
export function factKey(fact: Pick<UserFact, 'text' | 'extractedAt'>): string {
  return keyOfFactId(`${fact.text}|${fact.extractedAt}`)
}

export function keyOfFactId(id: string): string {
  let h = 0x811c9dc5
  for (let i = 0; i < id.length; i++) {
    h ^= id.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return `f_${h.toString(16).padStart(8, '0')}`
}

/** The slice of an audit entry an event is derived from (structural, so this module never imports the service). */
export interface AuditLike {
  op: 'add' | 'replace' | 'retire' | 'remove' | 'confirm' | 'reject' | 'undo' | 'archive' | 'restore'
  factId: string
  before?: UserFact
  after?: UserFact
  store: 'durable' | 'pending' | 'rejected'
  writer: string
  turn: string
  group?: string
}

const QUOTE_MAX = 160

function decidedByFor(writer: string, fact: UserFact | undefined): MemoryEvent['decidedBy'] {
  if (writer === 'reviewer' || writer === 'consolidation') return writer
  if (writer.startsWith('confirm') || writer.startsWith('reject') || writer === 'forget' || writer.startsWith('undo') || writer.startsWith('archive')) return 'user'
  if (fact?.source === 'user_asserted') return 'rule'
  return 'classifier'
}

function sourcesFor(a: AuditLike, fact: UserFact | undefined, withImages: boolean): SourceRef[] {
  const out: SourceRef[] = []
  const decided = decidedByFor(a.writer, fact)
  if (decided === 'user' && !a.writer.startsWith('recordFacts')) out.push({ type: 'user_command', ref: a.writer })
  if (fact && !a.writer.startsWith('forget')) {
    const quote = withImages && fact.evidence ? fact.evidence.slice(0, QUOTE_MAX) : undefined
    out.push({ type: fact.source === 'observed' || fact.source === 'externally_verified' ? 'tool_result' : 'user_message', ref: fact.sourceTurn, ...(quote ? { quote } : {}) })
  }
  if (a.op === 'replace' || (a.op === 'retire' && a.writer.includes('supersede'))) {
    if (a.before) out.push({ type: 'prior_fact', ref: factKey(a.before) })
  }
  if (out.length === 0) out.push({ type: 'user_command', ref: a.writer })
  return out
}

/** Project one audit change onto its event: kind, reason, decider and sources, from the op, the writer and the fact's own provenance bits (never its wording). */
export function eventFromAudit(a: AuditLike, withImages: boolean): MemoryEventDraft {
  const fact = a.after ?? a.before
  const decidedBy = decidedByFor(a.writer, fact)
  let kind: MemoryEventKind
  let reason: ReasonCode
  switch (a.op) {
    case 'add':
      if (a.store === 'pending') {
        kind = 'decline'
        reason = a.writer.endsWith(':flagged') ? 'gate_blocked_instruction' : 'inferred_pending_confirmation'
      } else {
        kind = 'promote'
        reason = fact?.source === 'user_asserted' ? 'user_stated' : 'inferred_high_conf'
      }
      break
    case 'confirm': kind = 'promote'; reason = 'user_confirmed'; break
    case 'replace':
      kind = 'supersede'
      reason = a.after?.source === 'user_asserted' ? 'user_corrected' : 'superseded_by_newer'
      break
    case 'retire':
      kind = 'retire'
      reason = a.writer.includes('supersede') ? 'superseded_by_newer' : 'user_confirmed'
      break
    case 'remove': kind = a.writer === 'forget' ? 'forget' : 'retire'; reason = 'explicit_forget'; break
    case 'reject':
      kind = a.writer.endsWith(':retract') ? 'contradict' : 'decline'
      reason = a.writer.endsWith(':retract') ? 'conflicts_with_fact' : 'user_rejected'
      break
    case 'archive': kind = 'retire'; reason = 'user_confirmed'; break
    case 'restore':
    case 'undo': kind = 'restore'; reason = 'user_confirmed'; break
  }
  const forgetting = kind === 'forget'
  return {
    session: a.turn,
    turn: a.turn,
    kind,
    factId: keyOfFactId(a.factId),
    ...(a.op === 'replace' && a.after ? { afterFactId: factKey(a.after) } : {}),
    ...(fact?.key ? { attributeKey: fact.key } : {}),
    store: a.store,
    ...(withImages && !forgetting && a.before ? { before: { ...a.before } } : {}),
    ...(withImages && !forgetting && a.after ? { after: { ...a.after } } : {}),
    reason,
    sources: sourcesFor(a, fact, withImages && !forgetting),
    decidedBy,
    ...(fact?.confidence ? { confidence: fact.confidence } : {}),
    ...(a.group ? { group: a.group } : {}),
  }
}

/** Drops quotes and images from every earlier event about a forgotten fact, so the log cannot be used to read it back. */
export function scrubForgotten(log: MemoryEvent[], forgottenKeys: Set<string>): MemoryEvent[] {
  if (forgottenKeys.size === 0) return log
  return log.map((e) => {
    if (!forgottenKeys.has(e.factId) && !(e.afterFactId && forgottenKeys.has(e.afterFactId))) return e
    const { before, after, ...rest } = e
    void before
    void after
    return { ...rest, sources: e.sources.map(({ quote, ...s }) => { void quote; return s }) }
  })
}

/** Keeps the newest `keep` events. */
export function trimEvents(log: MemoryEvent[], keep = MEMORY_EVENTS_KEEP): MemoryEvent[] {
  return log.length > keep ? log.slice(log.length - keep) : log
}

/**
 * Replays an event stream from empty and returns the ids of the durable facts, in order. This is
 * the correctness check for the log: it must equal `factKey()` over the stored durable list.
 * `unsupported` counts events it cannot replay (an undo reinserts at a recorded position).
 */
export function foldDurable(events: MemoryEvent[]): { ids: string[]; unsupported: number } {
  let ids: string[] = []
  let unsupported = 0
  for (const e of events) {
    if (e.store !== 'durable') continue
    if (e.kind === 'promote') ids.push(e.factId)
    else if (e.kind === 'supersede') {
      ids = ids.filter((i) => i !== e.factId)
      if (e.afterFactId) ids.push(e.afterFactId)
    } else if (e.kind === 'retire' || e.kind === 'forget') ids = ids.filter((i) => i !== e.factId)
    else if (e.kind === 'restore') unsupported++
  }
  return { ids, unsupported }
}

export interface EventFilter {
  /** A fact id as printed by `formatMemoryEvents` (`f_xxxxxxxx`), or an attribute key. */
  fact?: string
  kind?: MemoryEventKind
}

export function filterEvents(events: MemoryEvent[], f: EventFilter = {}): MemoryEvent[] {
  return events.filter((e) => (!f.fact || e.factId === f.fact || e.afterFactId === f.fact || e.attributeKey === f.fact) && (!f.kind || e.kind === f.kind))
}

/** `/memory history events [fact]`: one line per event, with the reason and its sources. Shared by the CLI and chat-ui. */
export function formatMemoryEvents(events: MemoryEvent[]): string {
  if (events.length === 0) return 'No memory events recorded (AUDIT_MEMORY_EVENTS is off, or nothing has changed yet).'
  return events
    .map((e) => {
      const text = (e.after ?? e.before)?.text
      const src = e.sources.map((s) => `${s.type}:${s.ref}${s.quote ? ` "${s.quote}"` : ''}`).join(', ')
      return `#${e.seq} ${e.at} ${e.kind} ${e.factId}${text ? ` "${text}"` : ''} — ${e.reason} by ${e.decidedBy}${src ? ` [${src}]` : ''}`
    })
    .join('\n')
}
