import type { ArticleMeta, Suggestion } from './article-model.js'

/**
 * Suggested changes (T9). A suggestion never touches the Markdown until the writer accepts it. It stores the exact
 * quoted text it replaces; if that text is no longer where it was (or at all), the suggestion is stale and cannot be
 * accepted as it stands. All functions are pure.
 */

export type SuggestionResult = { ok: true; meta: ArticleMeta; markdown: string } | { ok: false; reason: string }

function nextId(meta: ArticleMeta): string {
  let n = meta.suggestions.length + 1
  while (meta.suggestions.some((s) => s.id === `sg${n}`)) n++
  return `sg${n}`
}

/** Finds the quote in the text, preferring the occurrence closest to the hint. */
function find(markdown: string, quote: string, hint: number): number {
  let best = -1
  let at = markdown.indexOf(quote)
  while (at !== -1) {
    if (best === -1 || Math.abs(at - hint) < Math.abs(best - hint)) best = at
    at = markdown.indexOf(quote, at + 1)
  }
  return best
}

export function proposeSuggestion(
  meta: ArticleMeta,
  markdown: string,
  input: { quote: string; replacement: string; reason: string; by: 'assistant' | 'writer'; now: string },
): SuggestionResult {
  if (!input.quote) return { ok: false, reason: 'A suggestion needs the text it replaces.' }
  const start = markdown.indexOf(input.quote)
  if (start === -1) return { ok: false, reason: 'The text to replace is not in the article.' }
  const s: Suggestion = { id: nextId(meta), span: { start, end: start + input.quote.length, quote: input.quote }, replacement: input.replacement, reason: input.reason, proposedBy: input.by, state: 'pending', createdAt: input.now }
  return { ok: true, markdown, meta: { ...meta, suggestions: [...meta.suggestions, s] } }
}

/** Marks pending suggestions stale when their quoted text no longer exists; refreshes the span of those that moved. */
export function refreshSuggestions(meta: ArticleMeta, markdown: string): ArticleMeta {
  const suggestions = meta.suggestions.map((s) => {
    if (s.state !== 'pending') return s
    const at = find(markdown, s.span.quote, s.span.start)
    if (at === -1) return { ...s, state: 'stale' as const }
    return at === s.span.start ? s : { ...s, span: { ...s.span, start: at, end: at + s.span.quote.length } }
  })
  return { ...meta, suggestions }
}

/** Accepts a pending suggestion, optionally with the writer's own replacement text. Returns the new Markdown. */
export function acceptSuggestion(meta: ArticleMeta, markdown: string, id: string, edited?: string): SuggestionResult {
  const s = meta.suggestions.find((x) => x.id === id)
  if (!s) return { ok: false, reason: `No suggestion ${id}.` }
  if (s.state !== 'pending') return { ok: false, reason: `Suggestion ${id} is ${s.state}, not pending.` }
  const at = find(markdown, s.span.quote, s.span.start)
  if (at === -1) return { ok: false, reason: 'The text this suggestion replaces has changed, so it can no longer be applied as it stands.' }
  const replacement = edited ?? s.replacement
  const next = markdown.slice(0, at) + replacement + markdown.slice(at + s.span.quote.length)
  const state = edited !== undefined && edited !== s.replacement ? ('edited_accepted' as const) : ('accepted' as const)
  const delta = replacement.length - s.span.quote.length
  const suggestions = meta.suggestions.map((x) => {
    if (x.id === id) return { ...x, state, replacement, span: { ...x.span, start: at, end: at + replacement.length } }
    // other pending suggestions after the edit shift with the text; ones that overlapped it go stale
    if (x.state !== 'pending') return x
    const overlaps = x.span.start < at + s.span.quote.length && x.span.end > at
    if (overlaps) return { ...x, state: 'stale' as const }
    return x.span.start >= at + s.span.quote.length ? { ...x, span: { ...x.span, start: x.span.start + delta, end: x.span.end + delta } } : x
  })
  return { ok: true, markdown: next, meta: { ...meta, suggestions } }
}

export function rejectSuggestion(meta: ArticleMeta, id: string): SuggestionResult & { ok: boolean } {
  const s = meta.suggestions.find((x) => x.id === id)
  if (!s) return { ok: false, reason: `No suggestion ${id}.` }
  if (s.state !== 'pending') return { ok: false, reason: `Suggestion ${id} is ${s.state}, not pending.` }
  return { ok: true, markdown: '', meta: { ...meta, suggestions: meta.suggestions.map((x) => (x.id === id ? { ...x, state: 'rejected' as const } : x)) } }
}
