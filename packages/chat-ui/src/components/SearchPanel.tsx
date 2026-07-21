import { useState } from 'react'
import type { TranscriptSearchHit } from '@buildaharness/personal-assistant'

interface Props {
  /** Bound to assistant.searchTranscript — cross-session by design, same as the CLI's /search (see assistant.ts's doc comment on searchTranscript). */
  search: (query: string) => Promise<TranscriptSearchHit[]>
  onCancel: () => void
}

function shortSessionId(sessionId: string): string {
  return sessionId.length > 8 ? `${sessionId.slice(0, 8)}…` : sessionId
}

function escapeRegExp(term: string): string {
  return term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * Bolds the same query tokens scoring.ts's tokenizer would have matched on (lowercased
 * [a-z0-9]+ runs) — so what's highlighted here is never a promise the underlying ranking
 * didn't actually make. Deliberately not reusing formatSearchResults' snippet-centering: this
 * renders full/near-full content as real React nodes (for <mark> highlighting), not a single
 * plain-text line, so it isn't a fit for that CLI-oriented formatter.
 */
function highlightMatches(content: string, query: string): React.ReactNode {
  const terms = Array.from(new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? []))
  if (terms.length === 0) return content
  const pattern = new RegExp(`(${terms.map(escapeRegExp).join('|')})`, 'gi')
  const parts = content.split(pattern)
  return parts.map((part, i) => (terms.includes(part.toLowerCase()) ? <mark key={i}>{part}</mark> : <span key={i}>{part}</span>))
}

/**
 * Cross-session transcript search — the GUI equivalent of the CLI's /search command
 * (review §11 P1: `searchTranscript` already existed and was well-tested, but had no GUI
 * surface at all in chat-ui or desktop). Modeled on SettingsScreen's full-screen-swap
 * header/body layout, since (like Diagnostics) this queries the whole memory store rather
 * than one message — not the per-bubble toggle pattern ChatMessageBubble's "Sources" uses.
 *
 * "Jump to the matched message" (review's task wording) is implemented as expand-in-place to
 * the full untruncated content, not a jump to a different session's live chat view — this app
 * has no multi-session picker anywhere (sessionIdRef is fixed for the lifetime of the mounted
 * App), so there is no "that session's view" to navigate to yet. Expanding a hit is the
 * closest read-only-navigation equivalent that fits today's single-session architecture.
 */
export function SearchPanel({ search, onCancel }: Props): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [hits, setHits] = useState<TranscriptSearchHit[] | null>(null)
  const [searching, setSearching] = useState(false)
  const [expandedIndex, setExpandedIndex] = useState<number | null>(null)

  async function handleSearch(e: React.FormEvent): Promise<void> {
    e.preventDefault()
    const trimmed = query.trim()
    if (!trimmed) {
      setHits(null)
      return
    }
    setSearching(true)
    setExpandedIndex(null)
    try {
      setHits(await search(trimmed))
    } finally {
      setSearching(false)
    }
  }

  return (
    <div className="search-panel">
      <div className="search-panel__header">
        <button type="button" className="search-panel__back" onClick={onCancel}>← Back</button>
        <div className="search-panel__title">Search</div>
      </div>

      <div className="search-panel__body">
        <form className="search-panel__form" onSubmit={(e) => void handleSearch(e)}>
          <input
            className="search-panel__input"
            aria-label="Search past messages"
            placeholder="Search past messages…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
          <button type="submit" disabled={searching || !query.trim()}>
            {searching ? 'Searching…' : 'Search'}
          </button>
        </form>

        {hits !== null && hits.length === 0 && (
          <div className="search-panel__empty">No results for &quot;{query.trim()}&quot;.</div>
        )}

        {hits !== null && hits.length > 0 && (
          <ul className="search-panel__results">
            {hits.map((hit, i) => (
              <li key={i} className="search-panel__result">
                <button
                  type="button"
                  className="search-panel__result-row"
                  onClick={() => setExpandedIndex((prev) => (prev === i ? null : i))}
                  aria-expanded={expandedIndex === i}
                  // Explicit, plain-text accessible name — the <mark> highlighting inside is
                  // decorative-only. Letting the browser compute the name from that markup
                  // instead would drop whitespace at every text/element boundary (a real
                  // screen-reader-facing bug, not just a test-matching quirk): per the accname
                  // spec's name-from-content algorithm, each child's own contribution is trimmed
                  // before concatenation, so "about " immediately followed by <mark>garden</mark>
                  // collapses to "aboutgarden" with no space at all.
                  aria-label={`${hit.role} message, ${hit.at}: ${hit.content}`}
                >
                  <span className="search-panel__result-meta" aria-hidden="true">
                    <span className="search-panel__result-session">{shortSessionId(hit.sessionId)}</span>{' '}
                    <span className="search-panel__result-at">{hit.at}</span>{' '}
                    <span className="search-panel__result-role">{hit.role}</span>
                  </span>{' '}
                  <span className="search-panel__result-snippet" aria-hidden="true">
                    {highlightMatches(hit.content.slice(0, 160), query)}
                  </span>
                </button>
                {expandedIndex === i && (
                  <div className="search-panel__result-detail">{highlightMatches(hit.content, query)}</div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  )
}
