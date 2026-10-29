/**
 * Append-only archive of suggestion outcomes (plan section 5): lineage, cell, gate result, evidence, decision and
 * reason, plus the best recorded score the Ladder step compares against. Bounded by a retention window and a maximum
 * entry count; only expiry removes entries, never an edit. The best score survives pruning and only ever rises.
 */
import type { GateResult } from './admission-gate.js'
import type { SuggestionEvidence } from './suggestion-evidence.js'

export interface ArchiveEntry {
  /** Monotonic sequence number, assigned on append. */
  seq: number
  suggestionId: string
  parentId?: string
  fingerprint: string
  /** The cell the suggestion occupies (its surface id). */
  cell: string
  gate?: GateResult
  evidence?: SuggestionEvidence
  decision: string
  reason: string
  /** Epoch milliseconds. */
  at: number
  round?: number
}

export type NewArchiveEntry = Omit<ArchiveEntry, 'seq'>

export interface ArchiveOptions {
  /** Entries older than this are dropped on `prune`. Default 90 days. */
  retentionMs?: number
  /** Hard cap on retained entries; the oldest go first. */
  maxEntries?: number
}

export const DEFAULT_ARCHIVE_RETENTION_MS = 90 * 24 * 60 * 60 * 1000
export const DEFAULT_ARCHIVE_MAX_ENTRIES = 1000

export class SuggestionArchive {
  private entries: ArchiveEntry[] = []
  private nextSeq = 1
  private best = 0
  private readonly retentionMs: number
  private readonly maxEntries: number

  constructor(opts: ArchiveOptions = {}) {
    this.retentionMs = opts.retentionMs ?? DEFAULT_ARCHIVE_RETENTION_MS
    this.maxEntries = opts.maxEntries ?? DEFAULT_ARCHIVE_MAX_ENTRIES
  }

  append(entry: NewArchiveEntry): ArchiveEntry {
    const stored: ArchiveEntry = { ...entry, seq: this.nextSeq++ }
    this.entries.push(stored)
    if (stored.gate?.accepted && stored.gate.quantisedScore !== undefined) this.recordBestScore(stored.gate.quantisedScore)
    return stored
  }

  /** A copy of the retained entries, oldest first. */
  list(): ArchiveEntry[] {
    return this.entries.map((e) => ({ ...e }))
  }

  byCell(cell: string): ArchiveEntry[] {
    return this.list().filter((e) => e.cell === cell)
  }

  /** The chain from the root ancestor down to `suggestionId`, following parent ids among retained entries. */
  lineage(suggestionId: string): ArchiveEntry[] {
    const chain: ArchiveEntry[] = []
    const seen = new Set<string>()
    let id: string | undefined = suggestionId
    while (id && !seen.has(id)) {
      seen.add(id)
      const e = [...this.entries].reverse().find((x) => x.suggestionId === id)
      if (!e) break
      chain.unshift({ ...e })
      id = e.parentId
    }
    return chain
  }

  /** The best quantised score recorded so far; the Ladder reference. */
  bestRecordedScore(): number {
    return this.best
  }

  /** Raises the best score; a lower value is ignored. */
  recordBestScore(score: number): void {
    if (Number.isFinite(score) && score > this.best) this.best = score
  }

  /** Drops entries past the retention window, then the oldest beyond the cap. Returns how many were removed. */
  prune(now: number): number {
    const before = this.entries.length
    this.entries = this.entries.filter((e) => now - e.at <= this.retentionMs)
    if (this.entries.length > this.maxEntries) this.entries = this.entries.slice(this.entries.length - this.maxEntries)
    return before - this.entries.length
  }

  toJSON(): { entries: ArchiveEntry[]; nextSeq: number; best: number } {
    return { entries: this.list(), nextSeq: this.nextSeq, best: this.best }
  }

  /** Total: anything malformed yields an empty archive rather than a throw. */
  static fromJSON(raw: unknown, opts: ArchiveOptions = {}): SuggestionArchive {
    const a = new SuggestionArchive(opts)
    if (!raw || typeof raw !== 'object') return a
    const r = raw as Record<string, unknown>
    if (Array.isArray(r.entries)) {
      for (const e of r.entries) {
        if (!e || typeof e !== 'object') continue
        const x = e as Record<string, unknown>
        if (typeof x.suggestionId !== 'string' || typeof x.cell !== 'string' || typeof x.at !== 'number' || typeof x.seq !== 'number') continue
        a.entries.push({
          seq: x.seq,
          suggestionId: x.suggestionId,
          parentId: typeof x.parentId === 'string' ? x.parentId : undefined,
          fingerprint: typeof x.fingerprint === 'string' ? x.fingerprint : '',
          cell: x.cell,
          gate: x.gate as GateResult | undefined,
          evidence: x.evidence as SuggestionEvidence | undefined,
          decision: typeof x.decision === 'string' ? x.decision : '',
          reason: typeof x.reason === 'string' ? x.reason : '',
          at: x.at,
          round: typeof x.round === 'number' ? x.round : undefined,
        })
      }
    }
    a.nextSeq = Math.max(typeof r.nextSeq === 'number' ? r.nextSeq : 1, ...a.entries.map((e) => e.seq + 1), 1)
    if (typeof r.best === 'number') a.recordBestScore(r.best)
    return a
  }
}
