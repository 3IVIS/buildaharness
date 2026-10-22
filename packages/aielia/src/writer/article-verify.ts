import type { ArticleMeta, Claim } from './article-model.js'
import { effectiveSourceStatus } from './article-rules.js'

/**
 * Verifying claims (pure parts): which claims to take, and how a search that found nothing is said. The search, the reading and the model
 * check themselves are run by ArticleService.verifyClaims; whether a page backs a claim is the support check's judgement, never decided here.
 */

export type VerifyOutcome =
  | 'supported'
  | 'partly_supported'
  | 'contradicted'
  | 'not_supported'
  | 'no_source_found'
  | 'cannot_search'
  | 'search_failed'
  | 'could_not_check'

export interface VerifyEntry {
  claimId: string
  quote: string
  outcome: VerifyOutcome
  /** Addresses of pages found and kept as sources for the claim. */
  found: string[]
  reason?: string
}

export interface VerifyReport {
  entries: VerifyEntry[]
  /** Factual claims left for another run because of the limit. */
  leftOver: number
  /** The writer stopped the run: the entries are the claims checked before that. */
  stopped?: boolean
}

export const DEFAULT_VERIFY_LIMIT = 10
export const DEFAULT_VERIFY_PAGES = 3

/**
 * The claims to verify, in text order: the factual ones that are not already supported by a check that still counts. Named claims are taken
 * even when supported (the writer asked for them). At most `limit` are taken; the count of the rest is returned.
 */
export function verifyTargets(meta: ArticleMeta, claimIds: readonly string[] | undefined, limit: number): { ids: string[]; leftOver: number } {
  const wanted = claimIds ? new Set(claimIds) : undefined
  const pool = [...meta.claims]
    .filter((c) => c.kind === 'factual')
    .filter((c) => (wanted ? wanted.has(c.id) : effectiveSourceStatus(c, meta.sources) !== 'supported'))
    .sort((a, b) => a.position - b.position)
  return { ids: pool.slice(0, limit).map((c) => c.id), leftOver: Math.max(0, pool.length - limit) }
}

/** The lookup that still applies to the claim (its text has not changed since), or undefined. */
export function currentLookup(claim: Claim): NonNullable<Claim['lookup']> | undefined {
  return claim.lookup && claim.lookup.claimText === claim.quote ? claim.lookup : undefined
}

/** What the page says about a claim that was looked for and not backed; undefined when there was no lookup or sources have since been attached. */
export function lookupNote(claim: Claim, hasSources: boolean): string | undefined {
  const l = currentLookup(claim)
  if (!l || hasSources) return undefined
  const day = l.at.slice(0, 10)
  if (l.outcome === 'unavailable') return `Not searched: this browser cannot search the web (${day}).`
  if (l.outcome === 'no_results') return `No source found: searched the web on ${day} and nothing came back that was not already used.`
  return `No source found: searched on ${day}, read ${l.tried.length} page${l.tried.length === 1 ? '' : 's'}, none of them backs it.`
}

/** One sentence for the chat or a notice about a finished run. */
export function summarizeVerify(report: VerifyReport): string {
  if (report.entries.length === 0) return 'There are no factual claims left to verify.'
  const count = (o: VerifyOutcome): number => report.entries.filter((e) => e.outcome === o).length
  const parts = [
    count('supported') && `${count('supported')} backed`,
    count('partly_supported') && `${count('partly_supported')} partly backed`,
    count('contradicted') && `${count('contradicted')} contradicted by a source`,
    count('not_supported') && `${count('not_supported')} not backed by the sources it has`,
    count('no_source_found') && `${count('no_source_found')} with no source found`,
    count('cannot_search') && `${count('cannot_search')} not searched (no web search here)`,
    count('search_failed') && `${count('search_failed')} where the search failed`,
    count('could_not_check') && `${count('could_not_check')} that could not be checked`,
  ].filter(Boolean)
  const backed = count('supported') + count('partly_supported')
  const n = report.entries.length
  // "Verified" is only said of claims a source backed; otherwise the run only looked.
  const head = `Looked at ${n} claim${n === 1 ? '' : 's'}${backed === 0 ? ', none backed' : ''}`
  const why = count('cannot_search') > 0 ? ' Nothing could look anything up here: attach a repository in the chat pane, or add a search key and a page proxy in Settings.' : ''
  return `${head}: ${parts.join(', ')}.${why}${report.leftOver > 0 ? ` ${report.leftOver} more claims are left; each run takes ${n}, so run it again for the rest.` : ''}`
}

/**
 * Where the whole article stands, from its records: a run only looks at some claims (a limit, or the ones already backed are skipped), so a later
 * run's summary alone would read as if it were the result for the whole article. Empty when the article has no factual claims.
 */
export function summarizeArticleSources(meta: ArticleMeta): string {
  const factual = meta.claims.filter((c) => c.kind === 'factual')
  if (factual.length === 0) return ''
  const n = (pred: (s: ReturnType<typeof effectiveSourceStatus>) => boolean): number => factual.filter((c) => pred(effectiveSourceStatus(c, meta.sources))).length
  const parts = [
    n((s) => s === 'supported') && `${n((s) => s === 'supported')} backed`,
    n((s) => s === 'partly_supported') && `${n((s) => s === 'partly_supported')} partly backed`,
    n((s) => s === 'contradicted') && `${n((s) => s === 'contradicted')} contradicted`,
    n((s) => s === 'not_supported') && `${n((s) => s === 'not_supported')} not backed by their sources`,
    n((s) => s === 'none') && `${n((s) => s === 'none')} with no source`,
    n((s) => s === 'attached' || s === 'not_checked' || s === 'stale') && `${n((s) => s === 'attached' || s === 'not_checked' || s === 'stale')} with a source not checked yet`,
  ].filter(Boolean)
  return `The whole article, ${factual.length} factual claim${factual.length === 1 ? '' : 's'}: ${parts.join(', ')}.`
}
