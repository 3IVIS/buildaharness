import type { ArticleMeta, Claim, Link, Section, Source, SourceStatus } from './article-model.js'

/**
 * The rules the article model must always keep (plans/aielia_write_article_model_plan.html, section 9), as pure functions.
 * Each returns a new value or a refusal with a reason; none mutates its input, and none deletes silently.
 */

export type Actor = 'writer' | 'resolver' | 'assistant' | 'editor'
export type Refusal = { ok: false; reason: string }

// ---------------------------------------------------------------- claims

/**
 * What a claim's source status may be shown as. A check only counts if it ran on the claim's current text against the
 * current stored passages; otherwise the verdict is not shown as supported (not_checked), or stale when a source changed.
 */
export function effectiveSourceStatus(claim: Claim, sources: readonly Source[]): SourceStatus {
  const checked: SourceStatus[] = ['supported', 'partly_supported', 'not_supported', 'contradicted']
  if (!checked.includes(claim.sourceStatus)) return claim.sourceStatus
  const check = claim.check
  if (!check || check.claimText !== claim.quote) return 'not_checked'
  for (const [id, fingerprint] of Object.entries(check.sourceFingerprints)) {
    const src = sources.find((s) => s.id === id)
    if (!src || src.fingerprint !== fingerprint) return 'stale'
    if (src.freshness === 'changed' || src.freshness === 'unreachable') return 'stale'
  }
  return claim.sourceStatus
}

/** Changing a claim's text resets its check result. */
export function editClaimText(claim: Claim, quote: string, by: 'model' | 'writer', now: string): Claim {
  if (quote === claim.quote) return claim
  const author = claim.author === by ? claim.author : 'mixed'
  const sourceStatus: SourceStatus = claim.sourceStatus === 'none' ? 'none' : 'not_checked'
  return { ...claim, quote, author, authorAt: now, sourceStatus, check: undefined }
}

// ---------------------------------------------------------------- review state

/** The resolver may mark a section needs review; it cannot mark it clean. Only the writer clears it. */
export function setSectionReview(meta: ArticleMeta, sectionId: string, state: Section['review']['state'], reason: string | undefined, by: Actor, now: string): { ok: true; meta: ArticleMeta } | Refusal {
  const section = meta.sections.find((s) => s.id === sectionId)
  if (!section) return { ok: false, reason: `No section ${sectionId}.` }
  if (state === 'needs_review' && by !== 'resolver' && by !== 'writer') return { ok: false, reason: 'Only the resolver or the writer can mark a section as needing review.' }
  if (state === 'clean' && by !== 'writer') return { ok: false, reason: 'Only the writer can mark a section clean.' }
  if (section.review.state === 'needs_review' && state !== 'needs_review' && by !== 'writer') return { ok: false, reason: 'Only the writer can clear needs review.' }
  const sections = meta.sections.map((s) => (s.id === sectionId ? { ...s, review: { state, reason, setBy: by === 'assistant' ? ('editor' as const) : (by as 'resolver' | 'writer' | 'editor'), at: now } } : s))
  return { ok: true, meta: { ...meta, sections } }
}

// ---------------------------------------------------------------- links

const PROTECTED: Link['origin'][] = ['confirmed', 'drawn']

/** Confirmed and hand-drawn links are never changed or removed by the assistant; it can only propose a change. */
export function removeLink(meta: ArticleMeta, linkId: string, by: Actor): { ok: true; meta: ArticleMeta } | Refusal {
  const link = meta.links.find((l) => l.id === linkId)
  if (!link) return { ok: false, reason: `No link ${linkId}.` }
  if (PROTECTED.includes(link.origin) && by !== 'writer') return { ok: false, reason: 'Confirmed and hand-drawn links can only be removed by the writer; the assistant can propose the change.' }
  return { ok: true, meta: { ...meta, links: meta.links.filter((l) => l.id !== linkId) } }
}

export function confirmLink(meta: ArticleMeta, linkId: string, by: Actor): { ok: true; meta: ArticleMeta } | Refusal {
  if (by !== 'writer') return { ok: false, reason: 'Only the writer can confirm a link.' }
  const link = meta.links.find((l) => l.id === linkId)
  if (!link) return { ok: false, reason: `No link ${linkId}.` }
  return { ok: true, meta: { ...meta, links: meta.links.map((l) => (l.id === linkId ? { ...l, origin: 'confirmed' as const } : l)) } }
}

// ---------------------------------------------------------------- integrity

export interface Problem {
  where: string
  message: string
}

/** Every id referenced by a link, comment, claim or suggestion must exist. Broken records are reported and kept, never deleted. */
export function checkIntegrity(meta: ArticleMeta): Problem[] {
  const ids = {
    section: new Set(meta.sections.map((s) => s.id)),
    claim: new Set(meta.claims.map((c) => c.id)),
    source: new Set(meta.sources.map((s) => s.id)),
    comment: new Set(meta.comments.map((c) => c.id)),
  }
  const problems: Problem[] = []
  for (const l of meta.links) {
    for (const end of [l.from, l.to]) if (!ids[end.type].has(end.id)) problems.push({ where: `link ${l.id}`, message: `refers to a ${end.type} ${end.id} that does not exist` })
  }
  for (const c of meta.claims) if (!ids.section.has(c.sectionId)) problems.push({ where: `claim ${c.id}`, message: `refers to a section ${c.sectionId} that does not exist` })
  for (const c of meta.comments) {
    if (c.anchor && !ids[c.anchor.type].has(c.anchor.id)) problems.push({ where: `comment ${c.id}`, message: `is anchored to a ${c.anchor.type} ${c.anchor.id} that does not exist` })
    if (c.suggestionId && !meta.suggestions.some((s) => s.id === c.suggestionId)) problems.push({ where: `comment ${c.id}`, message: `refers to a suggestion ${c.suggestionId} that does not exist` })
    for (const other of c.conflictsWith) if (!ids.comment.has(other)) problems.push({ where: `comment ${c.id}`, message: `conflicts with a comment ${other} that does not exist` })
  }
  for (const s of meta.sections) if (s.parentId && !ids.section.has(s.parentId)) problems.push({ where: `section ${s.id}`, message: `has a parent ${s.parentId} that does not exist` })
  return problems
}

// ---------------------------------------------------------------- readiness and snapshots

export interface Readiness {
  unsourcedFactualClaims: number
  staleOrUnsupportedClaims: number
  openComments: number
  sectionsNeedingReview: number
}

/** Computed, never stored by hand (D3: warn only). Publishing is allowed regardless; a snapshot records these counts. */
export function computeReadiness(meta: ArticleMeta): Readiness {
  let unsourced = 0
  let bad = 0
  for (const c of meta.claims) {
    if (c.kind !== 'factual') continue
    const status = effectiveSourceStatus(c, meta.sources)
    if (status === 'none') unsourced++
    else if (status === 'stale' || status === 'not_supported' || status === 'contradicted' || status === 'partly_supported' || status === 'not_checked') bad++
  }
  return {
    unsourcedFactualClaims: unsourced,
    staleOrUnsupportedClaims: bad,
    openComments: meta.comments.filter((c) => c.state === 'open').length,
    sectionsNeedingReview: meta.sections.filter((s) => s.review.state === 'needs_review').length,
  }
}

export interface Snapshot {
  readonly kind: 'published' | 'checkpoint'
  readonly label?: string
  readonly at: string
  readonly markdown: string
  readonly meta: ArticleMeta
  readonly readiness: Readiness
}

function freezeDeep<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value as object)) freezeDeep(v)
    Object.freeze(value)
  }
  return value
}

/** A snapshot is a frozen deep copy: later edits to the working article cannot change it. */
export function createSnapshot(kind: Snapshot['kind'], markdown: string, meta: ArticleMeta, now: string, label?: string): Snapshot {
  const copy = JSON.parse(JSON.stringify(meta)) as ArticleMeta
  return freezeDeep({ kind, label, at: now, markdown, meta: copy, readiness: computeReadiness(copy) })
}

/** Restoring creates a new working version from the snapshot; the snapshot itself and the history are untouched. */
export function restoreSnapshot(snapshot: Snapshot): { markdown: string; meta: ArticleMeta } {
  return { markdown: snapshot.markdown, meta: JSON.parse(JSON.stringify(snapshot.meta)) as ArticleMeta }
}
