import type { ILLMClient, TokenUsage } from '@buildaharness/runtime'
import { dropLinksToMissingClaims, extractClaims, type ExtractionResult } from './article-claims.js'
import { serializeArticle, loadArticleFolder, type ArticleBundle, type ArticleFolder } from './article-folder.js'
import { createArticleMeta, type ArticleMeta, type Claim, type Idea, type Link, type Source } from './article-model.js'
import { assessSourceChange, resolveChange, type ResolveResult, type SourceImpact } from './article-resolver.js'
import { addCommentOnText, refreshComments } from './article-comments.js'
import { checkableClaims, renderIssuesForChat, unsupportedClaims, type IssueCategory } from './article-issues.js'
import { applyProfile, renderStyleGuide, setBrief, deleteProfile, loadProfiles, saveProfile } from './article-style.js'
import type { Brief, StyleProfile } from './article-model.js'
import { addIdea, editIdea, removeIdea, setIdeaState, suggestIdeas, type IdeaSuggestion } from './article-ideas.js'
import { attachSourceToText, proposeSourceLinks, textUnitAt, type SourceLinkProposal, type TextRange } from './article-source-links.js'
import { addDrawnLink, proposeDependencies, type DependencyKind, type DependencyProposal } from './article-dependencies.js'
import { addSnapshot, compareVersions, isLargeChange, summarizeChange, type ChangeSummary, type VersionComparison } from './article-history.js'
import { checkIntegrity, computeReadiness, confirmLink, createSnapshot, removeLink, restoreSnapshot, setSectionReview, type Problem, type Readiness, type Snapshot } from './article-rules.js'
import { suggestEdits, type EditSuggestResult } from './article-edit-suggest.js'
import { reconcileSections } from './article-sections.js'
import { DEFAULT_VERIFY_LIMIT, DEFAULT_VERIFY_PAGES, verifyTargets, type VerifyEntry, type VerifyReport } from './article-verify.js'
import { folderFileAddress, pathInFolder, type FolderReader } from './local-folder.js'
import { pickRepoFiles } from './article-repo.js'
import type { RepoReader } from './repo-reader.js'
import { checkConsistency, type ConsistencyResult } from './article-consistency.js'
import { looksLikeHtml } from '../html-to-markdown.js'
import { acceptNewPassage, applyRecheck, createSource, excerptFor, pageToArticle, sourceKindForFile, parseRepoFileLink, sliceLines, type LineRange } from './article-sources.js'
import { acceptSuggestion, refreshSuggestions, rejectSuggestion } from './article-suggestions.js'
import { checkClaimSupport, needsAutoCheck, sourcesForClaim, type SupportCheck } from './article-support.js'
import { loadPermissions } from './write-permissions.js'
import type { WriterChatPort } from './writer-chat-turn.js'
import { createEmptyWriterChatState, type ArticleRef, type CaptureOp, type WriterChatState } from './writer-chat-state.js'

/**
 * The article service: the operations the /write page and the terminal runner need, built from the pure pieces. Storage is
 * a port (the browser supplies IndexedDB, tests and the runner an in-memory store). The model clients are injected.
 */

export interface ArticleStore {
  list(): Promise<ArticleRef[]>
  load(id: string): Promise<ArticleBundle | undefined>
  save(id: string, bundle: ArticleBundle): Promise<void>
  remove(id: string): Promise<void>
  getSetting(key: string): Promise<unknown>
  setSetting(key: string, value: unknown): Promise<void>
}

export function createMemoryArticleStore(): ArticleStore {
  const bundles = new Map<string, ArticleBundle>()
  const settings = new Map<string, unknown>()
  return {
    async list() {
      return [...bundles.entries()].map(([id, b]) => ({ id, title: b.meta.title, name: b.meta.name }))
    },
    async load(id) {
      const b = bundles.get(id)
      return b ? structuredClone(b) : undefined
    },
    async save(id, bundle) {
      bundles.set(id, structuredClone(bundle))
    },
    async remove(id) {
      bundles.delete(id)
    },
    async getSetting(key) {
      return settings.get(key)
    },
    async setSetting(key, value) {
      if (value === undefined) settings.delete(key)
      else settings.set(key, value)
    },
  }
}

export interface ArticleServiceOptions {
  store: ArticleStore
  llm: ILLMClient
  /** Model for every call when `modelFor` is not given. */
  model?: string
  /** The model for each role, read at call time so the writer can change it between calls: the writer model drafts edit suggestions; the checker model runs claim extraction, support checks, link finding and the effects check. */
  modelFor?: (role: 'writer' | 'checker') => string | undefined
  /** The name stored with a check result ("which model ran it"); defaults to the checker model. */
  modelName?: string
  /** Reads a web page as plain text. Absent where the browser cannot reach pages (no proxy and no desktop shell); links are then stored without a passage and the writer pastes it. */
  fetchWeb?: (url: string) => Promise<string>
  /** Searches the web for pages that might back a claim. Absent where no search is set up. */
  searchWeb?: (query: string) => Promise<{ title: string; url: string; snippet: string }[]>
  onUsage?: (usage: TokenUsage) => void
  now?: () => string
  newId?: () => string
}

export interface UpdateOutcome {
  bundle: ArticleBundle
  changedSectionIds: string[]
  removedSections: string[]
  extraction?: ExtractionResult
  resolution?: ResolveResult
  autoChecks: { claimId: string; status: SupportCheck['status'] }[]
  /** The pass over the whole article for conflicts and overreach (one model call); absent when extraction did not run. */
  consistency?: ConsistencyResult
}

/** True for an http or https address; anything else (file:, javascript:, a bare word) is never fetched. */
function isHttpAddress(address: string): boolean {
  try {
    const { protocol } = new URL(address)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

/** A source whose text can be fetched: a web link, or a link to a repository file (stored as code). */
function isReadableLink(s: Source): boolean {
  return (s.kind === 'web' || s.kind === 'code') && !!s.address && isHttpAddress(s.address)
}

/** The most of a page's markup read when it is brought in to edit; the text made from it is cut separately. */
const MAX_PAGE_HTML_CHARS = 3_000_000

/** The most of a page kept as a source passage. */
const MAX_SOURCE_CHARS = 30000

function sectionText(markdown: string, s: { span: { start: number; end: number } }): string {
  return markdown.slice(s.span.start, s.span.end)
}

const clip = (t: string, n = 400): string => (t.length > n ? `${t.slice(0, n)}…` : t)

export interface SourceCandidate {
  title: string
  url: string
  snippet: string
}

export interface SourceRecheckReport {
  read: number
  unchanged: number
  /** Addresses whose page text differs from what was stored. */
  changed: string[]
  unreachable: string[]
  /** Web sources not read: no page reader here, or past the limit. */
  skipped: number
}

export interface ResolveReport {
  category: IssueCategory
  /** How many items the action dealt with. */
  done: number
  /** One plain sentence saying what happened. */
  note: string
}

export class ArticleService {
  private readonly store: ArticleStore
  private readonly now: () => string
  private readonly newId: () => string

  constructor(private readonly opts: ArticleServiceOptions) {
    this.store = opts.store
    this.now = opts.now ?? ((): string => new Date().toISOString())
    this.newId = opts.newId ?? ((): string => `a-${crypto.randomUUID().slice(0, 8)}`)
  }

  private checker(): string | undefined {
    return this.opts.modelFor?.('checker') ?? this.opts.model
  }

  private writer(): string | undefined {
    return this.opts.modelFor?.('writer') ?? this.opts.model
  }

  list(): Promise<ArticleRef[]> {
    return this.store.list()
  }

  async get(id: string): Promise<ArticleBundle> {
    const b = await this.store.load(id)
    if (!b) throw new Error(`No article ${id}.`)
    return b
  }

  async create(title: string, markdown = ''): Promise<string> {
    const id = this.newId()
    const meta = createArticleMeta(id, title)
    const sections = reconcileSections([], markdown, (taken) => {
      let n = taken.size + 1
      while (taken.has(`s${n}`)) n++
      return `s${n}`
    }).sections
    const heading = sections.find((x) => x.level === 1 && x.heading.trim() !== '')?.heading.trim()
    await this.store.save(id, { markdown, meta: { ...meta, title: heading ?? title, name: title, sections }, snapshots: [] })
    return id
  }

  /** The short name the writer files the article under. It does not change the text or the title. */
  async rename(id: string, name: string): Promise<void> {
    const b = await this.get(id)
    const trimmed = name.trim()
    if (!trimmed) throw new Error('A name cannot be empty.')
    await this.store.save(id, { ...b, meta: { ...b.meta, name: trimmed } })
  }

  /**
   * The writer's text changed. Structure first (no model): re-anchor sections and refresh suggestions, then save. Then, unless
   * `analyze` is false, the model judgements: extract claims, run the automatic checks on text the model wrote, and judge what
   * the edit means for the other sections. A failed model step leaves its part as it was and is reported in the outcome.
   */
  async updateText(id: string, markdown: string, options: { analyze?: boolean; model?: string } = {}): Promise<UpdateOutcome> {
    const before = await this.get(id)
    const rec = reconcileSections(before.meta.sections, markdown, (taken) => {
      let n = taken.size + 1
      while (taken.has(`s${n}`)) n++
      return `s${n}`
    })
    const oldById = new Map(before.meta.sections.map((s) => [s.id, s]))
    const changedSectionIds = rec.sections.filter((s) => {
      const old = oldById.get(s.id)
      return !old || sectionText(before.markdown, old) !== sectionText(markdown, s)
    }).map((s) => s.id)

    // The article's title is its first top-level heading, so the writer edits it in the text and nowhere else.
    const heading = rec.sections.find((x) => x.level === 1 && x.heading.trim() !== '')?.heading.trim()
    let meta = refreshComments(refreshSuggestions({ ...before.meta, sections: rec.sections, title: heading ?? before.meta.title }, markdown), markdown)
    // A rewrite is a natural point to be able to go back to: keep the text as it was.
    const snapshots = isLargeChange(before.markdown, markdown) ? addSnapshot(before.snapshots, createSnapshot('checkpoint', before.markdown, before.meta, this.now(), 'Before a large change')) : before.snapshots
    let bundle: ArticleBundle = { ...before, markdown, meta, snapshots }
    await this.store.save(id, bundle)
    const outcome: UpdateOutcome = { bundle, changedSectionIds, removedSections: rec.removed.map((s) => s.heading), autoChecks: [] }
    if (options.analyze === false || changedSectionIds.length === 0) return outcome

    meta = await this.extractAndCheck(meta, markdown, outcome, options.model)

    const { llm, onUsage } = this.opts
    const model = options.model ?? this.checker()
    const summary = changedSectionIds
      .map((sid) => {
        const old = oldById.get(sid)
        const now = meta.sections.find((s) => s.id === sid)!
        return `Section "${now.heading}". Before: ${old ? clip(sectionText(before.markdown, old)) : '(new section)'} After: ${clip(sectionText(markdown, now))}`
      })
      .join('\n')
    const resolution = await resolveChange({ meta, markdown, change: { kind: 'text_edited', sectionIds: changedSectionIds, summary }, now: this.now() }, llm, model, onUsage)
    outcome.resolution = resolution
    if (resolution.status === 'resolved') meta = resolution.meta

    bundle = { ...before, markdown, meta, snapshots }
    await this.store.save(id, bundle)
    outcome.bundle = bundle
    return outcome
  }

  /** Claim extraction and the automatic checks over the whole article: the first pass for a new article, or on request. Model steps that fail are reported and leave their part as it was. */
  async analyze(id: string, model?: string): Promise<UpdateOutcome> {
    const b = await this.get(id)
    const outcome: UpdateOutcome = { bundle: b, changedSectionIds: b.meta.sections.map((x) => x.id), removedSections: [], autoChecks: [] }
    const meta = await this.extractAndCheck(b.meta, b.markdown, outcome, model)
    outcome.bundle = { ...b, meta }
    await this.store.save(id, outcome.bundle)
    return outcome
  }

  private async extractAndCheck(start: ArticleMeta, markdown: string, outcome: UpdateOutcome, override?: string): Promise<ArticleMeta> {
    const { llm, onUsage } = this.opts
    const model = override ?? this.checker()
    let meta = start
    const extraction = await extractClaims({ markdown, sections: meta.sections, claims: meta.claims, now: this.now() }, llm, model, onUsage)
    outcome.extraction = extraction
    if (extraction.status === 'extracted') meta = dropLinksToMissingClaims({ ...meta, claims: extraction.claims })
    for (const claimId of [...extraction.added, ...extraction.matched]) {
      const claim = meta.claims.find((c) => c.id === claimId)
      if (!claim || !needsAutoCheck(claim) || (claim.sourceStatus === 'supported' && claim.check)) continue
      const check = await checkClaimSupport({ meta, markdown, claimId, modelName: this.opts.modelName ?? model ?? 'model', now: this.now() }, llm, model, onUsage)
      outcome.autoChecks.push({ claimId, status: check.status })
      meta = check.meta
    }
    if (extraction.status === 'extracted') {
      const consistency = await checkConsistency({ meta, markdown, now: this.now() }, llm, model, onUsage)
      outcome.consistency = consistency
      meta = consistency.meta
    }
    return meta
  }

  async addSource(id: string, input: { kind: Source['kind']; address?: string; passage?: string; note?: string; lines?: LineRange }): Promise<string> {
    const b = await this.get(id)
    let n = b.meta.sources.length + 1
    while (b.meta.sources.some((s) => s.id === `src${n}`)) n++
    const repo = input.address ? parseRepoFileLink(input.address) : undefined
    // A link to a repository file is a code source; the lines of its #L10-L20 fragment are the lines kept.
    const kind = repo && input.kind === 'web' ? 'code' : input.kind
    const source = createSource({ id: `src${n}`, ...input, kind, lines: input.lines ?? repo?.lines, now: this.now() })
    await this.store.save(id, { ...b, meta: { ...b.meta, sources: [...b.meta.sources, source] } })
    return source.id
  }

  /**
   * Reads a web source's address. First read: the page text becomes the stored passage. Later reads: same text keeps it current;
   * different text is held as `fetchedPassage` (the stored passage and every check stay as they were), the source is marked
   * changed and a model judges which citing claims it touches. The writer accepts the new text with acceptSourceChange.
   */
  async readSource(id: string, sourceId: string, modelOverride?: string): Promise<{ status: 'read' | 'unchanged' | 'changed' | 'unreachable' | 'unavailable' | 'not_a_link'; impacts: SourceImpact[]; reason?: string }> {
    const b = await this.get(id)
    const src = b.meta.sources.find((x) => x.id === sourceId)
    if (!src) return { status: 'not_a_link', impacts: [], reason: `No source ${sourceId}.` }
    if (!isReadableLink(src)) return { status: 'not_a_link', impacts: [], reason: 'Only a web link or a link to a repository file can be read.' }
    if (!this.opts.fetchWeb) return { status: 'unavailable', impacts: [], reason: 'This browser cannot read web pages. Paste the passage instead.' }
    const address = src.address as string
    let text: string
    try {
      const raw = await this.opts.fetchWeb(parseRepoFileLink(address)?.rawUrl ?? address)
      // A web page comes back as its HTML; the passage is the readable text of it, not the markup (a code file is kept exactly as it is).
      const readable = src.kind === 'web' && looksLikeHtml(raw) ? pageToArticle(raw.slice(0, MAX_PAGE_HTML_CHARS), address).markdown : raw
      text = readable.slice(0, MAX_SOURCE_CHARS).trim()
    } catch (e) {
      await this.saveSource(id, b, applyRecheck(src, { unreachable: true }, this.now()))
      return { status: 'unreachable', impacts: [], reason: e instanceof Error ? e.message : String(e) }
    }
    if (!text) {
      await this.saveSource(id, b, applyRecheck(src, { unreachable: true }, this.now()))
      return { status: 'unreachable', impacts: [], reason: 'The page had no text.' }
    }
    return this.receiveText(id, b, src, excerptFor(src, text), modelOverride)
  }

  private saveSource(id: string, b: ArticleBundle, s: Source, meta = b.meta): Promise<void> {
    return this.store.save(id, { ...b, meta: { ...meta, sources: meta.sources.map((x) => (x.id === s.id ? s : x)) } })
  }

  /** New text for a source: the first text becomes the passage; the same text keeps it current; different text is held until accepted, and a model judges which citing claims it touches. */
  private async receiveText(id: string, b: ArticleBundle, src: Source, text: string, modelOverride?: string): Promise<{ status: 'read' | 'unchanged' | 'changed'; impacts: SourceImpact[] }> {
    if (src.passage === undefined) {
      await this.saveSource(id, b, acceptNewPassage(src, text, this.now()))
      return { status: 'read', impacts: [] }
    }
    const rechecked = applyRecheck(src, { passage: text }, this.now())
    if (rechecked.freshness !== 'changed') {
      await this.saveSource(id, b, { ...rechecked, fetchedPassage: undefined })
      return { status: 'unchanged', impacts: [] }
    }
    const model = modelOverride ?? this.checker()
    const assessed = await assessSourceChange({ meta: b.meta, sourceId: src.id, before: src.passage, after: text, now: this.now() }, this.opts.llm, model, this.opts.onUsage)
    await this.saveSource(id, b, { ...rechecked, fetchedPassage: text }, assessed.meta)
    return { status: 'changed', impacts: assessed.impacts }
  }

  /**
   * The writer gives a new version of a file already stored as a source (dropped again). Same text keeps it current; different text is held
   * like a changed page, with the same impact judgement, until the writer accepts it. Without a stored file of that name the file is not matched.
   */
  async offerFileVersion(id: string, name: string, text: string, modelOverride?: string): Promise<{ status: 'read' | 'unchanged' | 'changed' | 'no_match'; sourceId?: string; impacts: SourceImpact[] }> {
    const b = await this.get(id)
    const src = b.meta.sources.find((x) => (x.kind === 'code' || x.kind === 'upload') && x.address === name && !isHttpAddress(name))
    if (!src) return { status: 'no_match', impacts: [] }
    const r = await this.receiveText(id, b, src, excerptFor(src, text.slice(0, MAX_SOURCE_CHARS * 4)), modelOverride)
    return { ...r, sourceId: src.id }
  }

  /**
   * Pulls a web page (or a repository file, by its GitHub link) in as a new article to edit: the page text becomes the article text, and the address is kept
   * as a source marked as where it came from. Nothing in the text is treated as checked.
   */
  async importPage(address: string): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
    const url = address.trim()
    if (!isHttpAddress(url)) return { ok: false, reason: 'Type a web address that starts with http:// or https://.' }
    if (!this.opts.fetchWeb) return { ok: false, reason: 'This browser cannot read web pages. Paste the text into a new article instead.' }
    let text: string
    try {
      text = await this.opts.fetchWeb(parseRepoFileLink(url)?.rawUrl ?? url)
    } catch (e) {
      return { ok: false, reason: `The page could not be read: ${e instanceof Error ? e.message : String(e)}` }
    }
    const page = pageToArticle(text.slice(0, MAX_PAGE_HTML_CHARS), url)
    page.markdown = page.markdown.slice(0, MAX_SOURCE_CHARS * 4)
    if (!page.markdown.trim()) return { ok: false, reason: 'The page had no text.' }
    const id = await this.create(page.title.slice(0, 120), page.markdown)
    await this.addSource(id, { kind: 'web', address: url, passage: page.markdown.slice(0, MAX_SOURCE_CHARS), note: 'The page this article was imported from.' })
    return { ok: true, id }
  }

  /** A text, markdown, MDX or HTML file the writer opens to edit becomes a new article (HTML is turned into markdown). */
  async importTextFile(name: string, text: string): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
    if (!sourceKindForFile({ name })) return { ok: false, reason: 'Only text, markdown, MDX, HTML and code files can be opened to edit.' }
    const page = pageToArticle(text.slice(0, MAX_PAGE_HTML_CHARS), name)
    page.markdown = page.markdown.slice(0, MAX_SOURCE_CHARS * 4)
    if (!page.markdown.trim()) return { ok: false, reason: 'The file had no text.' }
    const base = name.replace(/\.[^./]+$/, '')
    return { ok: true, id: await this.create(page.title.length <= 120 && page.title !== name ? page.title : base, page.markdown) }
  }

  /**
   * Uses a file from a folder the writer allowed: stored as a code or text source under the address `<folder>/<path>`. A file already stored
   * under that address is compared instead, like a new version of a dropped file.
   */
  async addFolderFile(id: string, folder: FolderReader, path: string, modelOverride?: string): Promise<{ status: 'added' | 'read' | 'unchanged' | 'changed' | 'missing' | 'unsupported'; sourceId?: string; impacts: SourceImpact[] }> {
    const kind = sourceKindForFile({ name: path })
    if (!kind) return { status: 'unsupported', impacts: [] }
    const text = await folder.read(path)
    if (text === undefined || !text.trim()) return { status: 'missing', impacts: [] }
    const address = folderFileAddress(folder.name, path)
    const again = await this.offerFileVersion(id, address, text, modelOverride)
    if (again.status !== 'no_match') return { status: again.status, sourceId: again.sourceId, impacts: again.impacts }
    const sourceId = await this.addSource(id, { kind, address, passage: text.slice(0, MAX_SOURCE_CHARS * 4) })
    return { status: 'added', sourceId, impacts: [] }
  }

  /** Reads again every source stored from this folder, before publishing or when asked. Changed files wait for the writer; files that are gone are reported. */
  async recheckFolder(id: string, folder: FolderReader, modelOverride?: string): Promise<{ unchanged: number; changed: string[]; missing: string[] }> {
    const b = await this.get(id)
    const report = { unchanged: 0, changed: [] as string[], missing: [] as string[] }
    for (const s of b.meta.sources) {
      const path = (s.kind === 'code' || s.kind === 'upload') && s.address ? pathInFolder(folder.name, s.address) : undefined
      if (path === undefined) continue
      const text = await folder.read(path)
      if (text === undefined) { report.missing.push(s.address as string); continue }
      const r = await this.offerFileVersion(id, s.address as string, text, modelOverride)
      if (r.status === 'changed') report.changed.push(s.address as string)
      else report.unchanged++
    }
    return report
  }

  /**
   * Keeps only some lines of a source. A source with an address is read again to take them (or to widen them); a dropped file can be narrowed
   * from the text stored, but not widened (drop the file again). The new passage replaces the old one, as an edit by the writer does.
   * `undefined` clears the range.
   */
  async setSourceLines(id: string, sourceId: string, range: LineRange | undefined, modelOverride?: string): Promise<{ ok: boolean; reason?: string }> {
    void modelOverride
    const b = await this.get(id)
    const src = b.meta.sources.find((x) => x.id === sourceId)
    if (!src) return { ok: false, reason: `No source ${sourceId}.` }
    if (src.kind !== 'code' && src.kind !== 'upload' && src.kind !== 'web') return { ok: false, reason: 'Lines can be kept only from a file or a page.' }
    const next: Source = { ...src, lines: range, fetchedPassage: undefined }
    if (!range) delete next.lines
    let full: string | undefined
    if (isReadableLink(src)) {
      if (!this.opts.fetchWeb) return { ok: false, reason: 'This browser cannot read web pages, so the lines cannot be taken again.' }
      try {
        full = (await this.opts.fetchWeb(parseRepoFileLink(src.address as string)?.rawUrl ?? (src.address as string))).slice(0, MAX_SOURCE_CHARS).trim()
      } catch (e) {
        return { ok: false, reason: e instanceof Error ? e.message : String(e) }
      }
    } else if (src.passage !== undefined && !src.lines && range) full = src.passage
    else if (src.passage !== undefined && !range && !src.lines) return { ok: true }
    else return { ok: false, reason: 'Drop the file again to change which lines are kept.' }
    const passage = range ? sliceLines(full, range) : full
    if (!passage.trim()) return { ok: false, reason: 'Those lines are not in the text.' }
    await this.saveSource(id, b, acceptNewPassage(next, passage, this.now()))
    return { ok: true }
  }

  /**
   * Looks for pages that might back a claim: a web search on the claim's own words (no model call). Pages already stored as sources are left out.
   * Nothing is stored until the writer picks one with useSourceCandidate.
   */
  async findSourceCandidates(id: string, claimId: string): Promise<{ status: 'found' | 'unavailable' | 'failed'; results: SourceCandidate[]; reason?: string }> {
    const b = await this.get(id)
    const claim = b.meta.claims.find((c) => c.id === claimId)
    if (!claim) return { status: 'failed', results: [], reason: `No claim ${claimId}.` }
    if (!this.opts.searchWeb) return { status: 'unavailable', results: [], reason: 'Web search is not set up here.' }
    const query = claim.quote.replace(/[#*_`>[\]]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200)
    try {
      const have = new Set(b.meta.sources.map((s) => s.address).filter(Boolean))
      const results = (await this.opts.searchWeb(query)).filter((r) => isHttpAddress(r.url) && !have.has(r.url)).slice(0, 5)
      return { status: 'found', results: results.map((r) => ({ title: r.title.slice(0, 200), url: r.url, snippet: r.snippet.slice(0, 300) })) }
    } catch (e) {
      return { status: 'failed', results: [], reason: e instanceof Error ? e.message : String(e) }
    }
  }

  /** The writer picks a found page: it is stored as a web source, read, and tied to the claim by a link the writer drew. A model checks it only when asked. */
  async useSourceCandidate(id: string, claimId: string, url: string): Promise<{ ok: boolean; reason?: string; read: 'read' | 'unreachable' | 'unavailable' | 'not_a_link' | 'unchanged' | 'changed' }> {
    if (!isHttpAddress(url)) return { ok: false, reason: 'Only a web address can be used.', read: 'not_a_link' }
    const b = await this.get(id)
    if (!b.meta.claims.some((c) => c.id === claimId)) return { ok: false, reason: `No claim ${claimId}.`, read: 'not_a_link' }
    const existing = b.meta.sources.find((s) => s.address === url)
    const sourceId = existing?.id ?? (await this.addSource(id, { kind: 'web', address: url }))
    const read = await this.readSource(id, sourceId)
    await this.attachSource(id, claimId, sourceId)
    return { ok: true, read: read.status }
  }

  /** Reads every web source again (at most 30, one after another). Used before publishing; nothing is blocked, the report says what to look at. */
  async recheckSources(id: string, modelOverride?: string): Promise<SourceRecheckReport> {
    const b = await this.get(id)
    const report: SourceRecheckReport = { read: 0, unchanged: 0, changed: [], unreachable: [], skipped: 0 }
    const web = b.meta.sources.filter(isReadableLink)
    if (!this.opts.fetchWeb) return { ...report, skipped: web.length }
    for (const s of web.slice(0, 30)) {
      const r = await this.readSource(id, s.id, modelOverride)
      if (r.status === 'read') report.read++
      else if (r.status === 'unchanged') report.unchanged++
      else if (r.status === 'changed') report.changed.push(s.address as string)
      else if (r.status === 'unreachable') report.unreachable.push(s.address as string)
    }
    report.skipped = Math.max(0, web.length - 30)
    return report
  }

  /** The writer takes the new text a re-read found: it becomes the stored passage, so checks made on the old text stop counting until run again. */
  async acceptSourceChange(id: string, sourceId: string): Promise<{ ok: boolean; reason?: string }> {
    const b = await this.get(id)
    const src = b.meta.sources.find((x) => x.id === sourceId)
    if (!src?.fetchedPassage) return { ok: false, reason: 'There is no new text waiting.' }
    const next = { ...acceptNewPassage(src, src.fetchedPassage, this.now()), fetchedPassage: undefined }
    await this.store.save(id, { ...b, meta: { ...b.meta, sources: b.meta.sources.map((x) => (x.id === sourceId ? next : x)) } })
    return { ok: true }
  }

  /** The writer ties a claim to a source: a hand-drawn supported_by link, which the assistant can never remove. */
  async attachSource(id: string, claimId: string, sourceId: string): Promise<void> {
    const b = await this.get(id)
    if (!b.meta.claims.some((c) => c.id === claimId)) throw new Error(`No claim ${claimId}.`)
    if (!b.meta.sources.some((s) => s.id === sourceId)) throw new Error(`No source ${sourceId}.`)
    if (b.meta.links.some((l) => l.kind === 'supported_by' && l.from.id === claimId && l.to.id === sourceId)) return
    let n = b.meta.links.length + 1
    while (b.meta.links.some((l) => l.id === `lk${n}`)) n++
    const link: Link = { id: `lk${n}`, from: { type: 'claim', id: claimId }, to: { type: 'source', id: sourceId }, kind: 'supported_by', origin: 'drawn', at: this.now() }
    const claims = b.meta.claims.map((c): Claim => (c.id === claimId && c.sourceStatus === 'none' ? { ...c, sourceStatus: 'attached' } : c))
    await this.store.save(id, { ...b, meta: { ...b.meta, claims, links: [...b.meta.links, link] } })
  }

  async checkClaim(id: string, claimId: string, modelOverride?: string): Promise<SupportCheck> {
    const b = await this.get(id)
    const { llm, onUsage } = this.opts
    const model = modelOverride ?? this.checker()
    const check = await checkClaimSupport({ meta: b.meta, markdown: b.markdown, claimId, modelName: this.opts.modelName ?? model ?? 'model', now: this.now() }, llm, model, onUsage)
    if (check.meta !== b.meta) await this.store.save(id, { ...b, meta: check.meta })
    return check
  }

  /**
   * Verifies factual claims: a claim with sources that have passages is checked against them; a claim with none is searched for (the web search on
   * the claim's own words), the first few pages are read and kept as proposed sources, and one check says whether they back it. If none does, the
   * pages are dropped and the claim records that it was looked for and not backed. Nothing in the text changes. At most `limit` claims per run.
   */
  /** Repositories the writer handed over for this session, per article. Readers hold browser handles and tokens, so they are never stored in the article. */
  private readonly repos = new Map<string, RepoReader[]>()
  private readonly repoFiles = new WeakMap<RepoReader, string[]>()

  /** Hands a repository to the article for verifying claims. The same repository (by name) replaces the earlier reader. */
  attachRepo(id: string, reader: RepoReader): void {
    this.repos.set(id, [...(this.repos.get(id) ?? []).filter((r) => r.name !== reader.name), reader])
  }

  detachRepo(id: string, name: string): void {
    this.repos.set(id, (this.repos.get(id) ?? []).filter((r) => r.name !== name))
  }

  attachedRepos(id: string): string[] {
    return (this.repos.get(id) ?? []).map((r) => r.name)
  }

  /**
   * For a claim with no source: asks the model which files of each attached repository would show whether it is true, reads them (at most three),
   * keeps them as proposed sources and checks the claim. Files that do not back the claim are dropped again. Returns the entry when a repository
   * answered (supported, contradicted and so on), else undefined and the web search is tried.
   */
  private async verifyInRepos(id: string, claimId: string, quote: string, model?: string): Promise<{ entry?: VerifyEntry; tried: string[] }> {
    const readers = this.repos.get(id) ?? []
    const tried: string[] = []
    for (const reader of readers) {
      let paths = this.repoFiles.get(reader)
      if (!paths) {
        try {
          paths = await reader.files()
        } catch {
          continue
        }
        this.repoFiles.set(reader, paths)
      }
      const pick = await pickRepoFiles({ claim: quote, paths }, this.opts.llm, model ?? this.checker(), this.opts.onUsage)
      const added: string[] = []
      for (const path of pick.paths) {
        const text = await reader.read(path)
        if (text === undefined || !text.trim()) continue
        const address = reader.addressOf?.(path) ?? `${reader.name}/${path}`
        const sid = await this.addSource(id, { kind: 'code', address, passage: text.slice(0, MAX_SOURCE_CHARS), note: `Found in ${reader.name} for this claim.` })
        await this.attachProposed(id, claimId, sid, path)
        added.push(sid)
        tried.push(address)
      }
      if (added.length === 0) continue
      const check = await this.checkClaim(id, claimId, model)
      if (check.status !== 'checked') {
        await this.dropFoundSources(id, claimId, added)
        continue
      }
      if (check.verdict === 'not_supported') {
        await this.dropFoundSources(id, claimId, added)
        continue
      }
      return { entry: { claimId, quote, outcome: check.verdict, found: tried, reason: check.reason }, tried }
    }
    return { tried }
  }

  async verifyClaims(id: string, opts: { claimIds?: string[]; limit?: number; pages?: number; model?: string } = {}): Promise<VerifyReport> {
    let b = await this.get(id)
    if (b.meta.claims.length === 0) b = (await this.analyze(id, opts.model)).bundle
    const { ids, leftOver } = verifyTargets(b.meta, opts.claimIds, opts.limit ?? DEFAULT_VERIFY_LIMIT)
    const entries: VerifyEntry[] = []
    for (const claimId of ids) entries.push(await this.verifyOne(id, claimId, opts.pages ?? DEFAULT_VERIFY_PAGES, opts.model))
    return { entries, leftOver }
  }

  private async verifyOne(id: string, claimId: string, pages: number, model?: string): Promise<VerifyEntry> {
    const first = (await this.get(id)).meta.claims.find((c) => c.id === claimId)
    if (!first) return { claimId, quote: '', outcome: 'could_not_check', found: [], reason: `No claim ${claimId}.` }
    const entry = (outcome: VerifyEntry['outcome'], found: string[] = [], reason?: string): VerifyEntry => ({ claimId, quote: first.quote, outcome, found, reason })
    const hasPassage = sourcesForClaim((await this.get(id)).meta, claimId).some((x) => x.passage?.trim())
    const added: string[] = []
    const tried: string[] = []
    if (!hasPassage) {
      const inRepos = await this.verifyInRepos(id, claimId, first.quote, model)
      if (inRepos.entry) return inRepos.entry
      tried.push(...inRepos.tried)
      if (!this.opts.searchWeb || !this.opts.fetchWeb) {
        if ((this.repos.get(id) ?? []).length > 0) {
          await this.setLookup(id, claimId, 'no_results', tried)
          return entry('no_source_found')
        }
        await this.setLookup(id, claimId, 'unavailable', [])
        return entry('cannot_search')
      }
      const found = await this.findSourceCandidates(id, claimId)
      if (found.status !== 'found') return entry('search_failed', [], found.reason)
      if (found.results.length === 0) {
        await this.setLookup(id, claimId, 'no_results', [])
        return entry('no_source_found')
      }
      for (const r of found.results.slice(0, pages)) {
        const sid = await this.addSource(id, { kind: 'web', address: r.url, note: 'Found by a search for this claim.' })
        const read = await this.readSource(id, sid)
        if (read.status !== 'read') { await this.dropFoundSources(id, claimId, [sid]); continue }
        await this.attachProposed(id, claimId, sid, r.title)
        added.push(sid)
        tried.push(r.url)
      }
      if (added.length === 0) {
        await this.setLookup(id, claimId, 'no_results', [])
        return entry('no_source_found')
      }
    }
    const check = await this.checkClaim(id, claimId, model)
    if (check.status !== 'checked') return entry('could_not_check', tried, check.status === 'not_checked' ? check.reason : undefined)
    if (check.verdict === 'not_supported' && added.length > 0) {
      await this.dropFoundSources(id, claimId, added)
      await this.setLookup(id, claimId, 'none_supported', tried)
      return entry('no_source_found', [], check.reason)
    }
    return entry(check.verdict, tried, check.reason)
  }

  private async setLookup(id: string, claimId: string, outcome: NonNullable<Claim['lookup']>['outcome'], tried: string[]): Promise<void> {
    const b = await this.get(id)
    const claims = b.meta.claims.map((c): Claim => (c.id === claimId ? { ...c, lookup: { at: this.now(), claimText: c.quote, outcome, tried } } : c))
    await this.store.save(id, { ...b, meta: { ...b.meta, claims } })
  }

  /** A page found by search is tied to the claim by a proposed link, which the writer can confirm or dismiss like any other proposal. */
  private async attachProposed(id: string, claimId: string, sourceId: string, title: string): Promise<void> {
    const b = await this.get(id)
    let n = b.meta.links.length + 1
    while (b.meta.links.some((l) => l.id === `lk${n}`)) n++
    const link: Link = { id: `lk${n}`, from: { type: 'claim', id: claimId }, to: { type: 'source', id: sourceId }, kind: 'supported_by', origin: 'proposed', reason: `Found by a search${title ? `: ${title.slice(0, 120)}` : ''}`, at: this.now() }
    const claims = b.meta.claims.map((c): Claim => (c.id === claimId && c.sourceStatus === 'none' ? { ...c, sourceStatus: 'attached' } : c))
    await this.store.save(id, { ...b, meta: { ...b.meta, claims, links: [...b.meta.links, link] } })
  }

  /** Removes sources this run added and the links to them; a claim left with none goes back to having no source. */
  private async dropFoundSources(id: string, claimId: string, sourceIds: string[]): Promise<void> {
    const b = await this.get(id)
    const gone = new Set(sourceIds)
    const sources = b.meta.sources.filter((x) => !gone.has(x.id))
    const links = b.meta.links.filter((l) => !(l.to.type === 'source' && gone.has(l.to.id)))
    const remaining = sourcesForClaim({ ...b.meta, sources, links }, claimId).length
    const claims = b.meta.claims.map((c): Claim => (c.id === claimId && remaining === 0 ? { ...c, sourceStatus: 'none', check: undefined } : c))
    await this.store.save(id, { ...b, meta: { ...b.meta, claims, sources, links } })
  }

  /** The writer confirms a claim (and may change its kind). A confirmed claim is matched first on re-extraction and never dropped silently. */
  async confirmClaim(id: string, claimId: string, kind?: Claim['kind']): Promise<void> {
    const b = await this.get(id)
    if (!b.meta.claims.some((c) => c.id === claimId)) throw new Error(`No claim ${claimId}.`)
    const claims = b.meta.claims.map((c): Claim => (c.id === claimId ? { ...c, confirmed: true, needsRecheck: undefined, kind: kind ?? c.kind, author: c.author === 'model' ? 'mixed' : c.author } : c))
    await this.store.save(id, { ...b, meta: { ...b.meta, claims } })
  }

  /** The assistant turns the writer\'s instruction into suggestions; nothing is applied until the writer accepts. */
  async suggest(id: string, instruction: string, modelOverride?: string, refs: { ideaIds?: string[]; commentIds?: string[]; sectionIds?: string[]; focus?: { start: number; end: number } } = {}): Promise<EditSuggestResult> {
    const b = await this.get(id)
    const { llm, onUsage } = this.opts
    const model = modelOverride ?? this.writer()
    const r = await suggestEdits({ meta: b.meta, markdown: b.markdown, instruction, now: this.now(), modelName: model, ...refs }, llm, model, onUsage)
    if (r.status === 'suggested' && r.added.length > 0) await this.store.save(id, { ...b, meta: r.meta })
    return r
  }

  /** The writer asks for the passage under the cursor or selection to be revised: the result is suggested changes inside that passage only. */
  async reviseText(id: string, range: TextRange, instruction: string, modelOverride?: string): Promise<EditSuggestResult | { status: 'failed'; reason: string }> {
    const b = await this.get(id)
    const unit = textUnitAt(b.markdown, range.start, range.end)
    if (!unit) return { status: 'failed', reason: 'There is no text there to revise.' }
    return this.suggest(id, instruction, modelOverride, { focus: { start: unit.start, end: unit.end } })
  }

  /** Accepts a suggestion (optionally with the writer\'s own wording): the Markdown changes, then the usual update runs. */
  async acceptSuggestionAndUpdate(id: string, suggestionId: string, edited?: string, options: { analyze?: boolean } = {}): Promise<{ ok: true; outcome: UpdateOutcome } | { ok: false; reason: string }> {
    const b = await this.get(id)
    const r = acceptSuggestion(b.meta, b.markdown, suggestionId, edited)
    if (!r.ok) return r
    const snapshots = addSnapshot(b.snapshots, createSnapshot('checkpoint', b.markdown, b.meta, this.now(), 'Before accepting a suggested change'))
    await this.store.save(id, { ...b, meta: r.meta, snapshots })
    return { ok: true, outcome: await this.updateText(id, r.markdown, options) }
  }

  async rejectSuggestionById(id: string, suggestionId: string): Promise<{ ok: boolean; reason?: string }> {
    const b = await this.get(id)
    const r = rejectSuggestion(b.meta, suggestionId)
    if (!r.ok) return { ok: false, reason: r.reason }
    await this.store.save(id, { ...b, meta: r.meta })
    return { ok: true }
  }

  /** Only the writer clears a section\'s needs-review (or sets it held / clean). */
  async setReview(id: string, sectionId: string, state: 'clean' | 'held' | 'needs_review'): Promise<{ ok: boolean; reason?: string }> {
    const b = await this.get(id)
    const r = setSectionReview(b.meta, sectionId, state, undefined, 'writer', this.now())
    if (!r.ok) return { ok: false, reason: r.reason }
    await this.store.save(id, { ...b, meta: r.meta })
    return { ok: true }
  }

  async setCommentState(id: string, commentId: string, state: 'open' | 'addressed' | 'dismissed'): Promise<void> {
    const b = await this.get(id)
    if (!b.meta.comments.some((c) => c.id === commentId)) throw new Error(`No comment ${commentId}.`)
    await this.store.save(id, { ...b, meta: { ...b.meta, comments: b.meta.comments.map((c) => (c.id === commentId ? { ...c, state } : c)) } })
  }

  /** Saves the article as it is now as a named version the writer can come back to. */
  async saveVersion(id: string, label?: string): Promise<void> {
    const b = await this.get(id)
    await this.store.save(id, { ...b, snapshots: addSnapshot(b.snapshots, createSnapshot('checkpoint', b.markdown, b.meta, this.now(), label?.trim() || 'Saved by you')) })
  }

  /** Every version, newest first, each with what changed since the version before it (the oldest has nothing to compare with). */
  async history(id: string): Promise<{ index: number; kind: Snapshot['kind']; label?: string; at: string; readiness: Snapshot['readiness']; change: ChangeSummary }[]> {
    const b = await this.get(id)
    return b.snapshots
      .map((s, index) => ({
        index,
        kind: s.kind,
        label: s.label,
        at: s.at,
        readiness: s.readiness,
        change: summarizeChange(index === 0 ? undefined : { markdown: b.snapshots[index - 1].markdown, meta: b.snapshots[index - 1].meta }, { markdown: s.markdown, meta: s.meta }),
      }))
      .reverse()
  }

  /** What the working article has changed since the latest saved version; undefined when nothing was saved yet. */
  async changeSinceLastVersion(id: string): Promise<ChangeSummary | undefined> {
    const b = await this.get(id)
    const last = b.snapshots[b.snapshots.length - 1]
    return last ? summarizeChange({ markdown: last.markdown, meta: last.meta }, { markdown: b.markdown, meta: b.meta }) : undefined
  }

  /** What changed between a stored version and the article now (text, claim status, sources, readiness). */
  async compareWithCurrent(id: string, index: number): Promise<VersionComparison> {
    const b = await this.get(id)
    const snap = b.snapshots[index]
    if (!snap) throw new Error(`No version ${index}.`)
    return compareVersions({ markdown: snap.markdown, meta: snap.meta }, { markdown: b.markdown, meta: b.meta })
  }

  async getVersion(id: string, index: number): Promise<Snapshot> {
    const snap = (await this.get(id)).snapshots[index]
    if (!snap) throw new Error(`No version ${index}.`)
    return snap
  }

  /**
   * Restoring makes a new working version from an old one and rewrites no history. The present article is saved as a checkpoint first,
   * so nothing is lost. Reviewer comments and the writer's corrections are the record of the conversation, not of the text, so they stay as they are.
   */
  async restore(id: string, index: number): Promise<ArticleBundle> {
    const b = await this.get(id)
    const snap = b.snapshots[index]
    if (!snap) throw new Error(`No version ${index}.`)
    const snapshots = addSnapshot(b.snapshots, createSnapshot('checkpoint', b.markdown, b.meta, this.now(), 'Before restoring an earlier version'))
    const restored = restoreSnapshot(snap)
    const meta: ArticleMeta = { ...restored.meta, status: 'drafting', comments: b.meta.comments, corrections: b.meta.corrections }
    const next: ArticleBundle = { markdown: restored.markdown, meta, snapshots }
    await this.store.save(id, next)
    return next
  }

  /** The assistant reads the whole article and proposes dependencies between sections. Proposals wait for the writer to confirm them. */
  async findDependencies(id: string, modelOverride?: string): Promise<DependencyProposal> {
    const b = await this.get(id)
    const { llm, onUsage } = this.opts
    const model = modelOverride ?? this.checker()
    const r = await proposeDependencies({ meta: b.meta, markdown: b.markdown, now: this.now() }, llm, model, onUsage)
    if (r.status === 'proposed' && r.added.length > 0) await this.store.save(id, { ...b, meta: r.meta })
    return r
  }

  /** The writer draws a link by hand. */
  async addDependency(id: string, from: string, to: string, kind: DependencyKind): Promise<{ ok: true } | { ok: false; reason: string }> {
    const b = await this.get(id)
    const r = addDrawnLink(b.meta, from, to, kind, this.now())
    if (!r.ok) return r
    await this.store.save(id, { ...b, meta: r.meta })
    return { ok: true }
  }

  /** Only the writer confirms a proposed link, or removes any link. */
  async confirmDependency(id: string, linkId: string): Promise<{ ok: boolean; reason?: string }> {
    const b = await this.get(id)
    const r = confirmLink(b.meta, linkId, 'writer')
    if (!r.ok) return r
    await this.store.save(id, { ...b, meta: r.meta })
    return { ok: true }
  }

  async removeDependency(id: string, linkId: string): Promise<{ ok: boolean; reason?: string }> {
    const b = await this.get(id)
    const r = removeLink(b.meta, linkId, 'writer')
    if (!r.ok) return r
    await this.store.save(id, { ...b, meta: r.meta })
    return { ok: true }
  }

  /** Attaches a stored source to the text in a range (a phrase, a sentence or what is selected), creating a claim for that text if there is none. */
  async attachSourceToText(id: string, range: TextRange, sourceId: string): Promise<{ ok: true; claimIds: string[]; createdClaim: boolean } | { ok: false; reason: string }> {
    const b = await this.get(id)
    const r = attachSourceToText(b.meta, b.markdown, range, sourceId, this.now())
    if (!r.ok) return r
    await this.store.save(id, { ...b, meta: r.meta })
    return { ok: true, claimIds: r.claimIds, createdClaim: r.createdClaim }
  }

  /** A source stored without saying what it is for: the assistant proposes which claims it bears on, and the writer confirms. */
  async proposeLinksForSource(id: string, sourceId: string, modelOverride?: string): Promise<SourceLinkProposal> {
    const b = await this.get(id)
    const { llm, onUsage } = this.opts
    const model = modelOverride ?? this.checker()
    const r = await proposeSourceLinks({ meta: b.meta, sourceId, now: this.now() }, llm, model, onUsage)
    if (r.status === 'proposed' && r.added.length > 0) await this.store.save(id, { ...b, meta: r.meta })
    return r
  }

  /** The writer removes a source from a claim (the link only; the stored source stays). Proposals and drawn links alike. */
  async detachSource(id: string, claimId: string, sourceId: string): Promise<{ ok: boolean; reason?: string }> {
    const b = await this.get(id)
    const link = b.meta.links.find((l) => l.kind === 'supported_by' && l.from.id === claimId && l.to.id === sourceId)
    if (!link) return { ok: false, reason: 'That source is not attached to that claim.' }
    const r = removeLink(b.meta, link.id, 'writer')
    if (!r.ok) return r
    const stillBacked = r.meta.links.some((l) => l.kind === 'supported_by' && l.from.id === claimId)
    const claims = r.meta.claims.map((c) => (c.id === claimId && !stillBacked && c.sourceStatus === 'attached' ? { ...c, sourceStatus: 'none' as const } : c))
    await this.store.save(id, { ...b, meta: { ...r.meta, claims } })
    return { ok: true }
  }

  // ---- ideas

  async addIdea(id: string, input: { text: string; origin?: Idea['origin']; model?: string; sectionId?: string }): Promise<{ ok: true; idea: Idea } | { ok: false; reason: string }> {
    const b = await this.get(id)
    const r = addIdea(b.meta, { ...input, origin: input.origin ?? 'writer' }, this.now())
    if (!r.ok) return r
    await this.store.save(id, { ...b, meta: r.meta })
    return { ok: true, idea: r.idea }
  }

  async updateIdea(id: string, ideaId: string, patch: { text?: string; sectionId?: string | null; state?: Idea['state'] }): Promise<{ ok: boolean; reason?: string }> {
    const b = await this.get(id)
    let meta = b.meta
    if (patch.text !== undefined || patch.sectionId !== undefined) {
      const r = editIdea(meta, ideaId, { text: patch.text, sectionId: patch.sectionId })
      if (!r.ok) return r
      meta = r.meta
    }
    if (patch.state) {
      const r = setIdeaState(meta, ideaId, patch.state)
      if (!r.ok) return r
      meta = r.meta
    }
    await this.store.save(id, { ...b, meta })
    return { ok: true }
  }

  async deleteIdea(id: string, ideaId: string): Promise<void> {
    const b = await this.get(id)
    await this.store.save(id, { ...b, meta: removeIdea(b.meta, ideaId) })
  }

  /** The assistant proposes new ideas from the article, the sources and what the writer asked for. They are added as open ideas, marked with the model. */
  async suggestIdeas(id: string, request?: string, modelOverride?: string): Promise<IdeaSuggestion> {
    const b = await this.get(id)
    const { llm, onUsage } = this.opts
    const model = modelOverride ?? this.writer()
    const r = await suggestIdeas({ meta: b.meta, markdown: b.markdown, request, now: this.now(), modelName: model }, llm, model, onUsage)
    if (r.status === 'suggested' && r.added.length > 0) await this.store.save(id, { ...b, meta: r.meta })
    return r
  }

  /** Writes the chosen ideas into the article as suggestions the writer accepts; each idea is marked used when its suggestion is accepted. */
  async writeIdeasIn(id: string, ideaIds: string[], instruction?: string, modelOverride?: string): Promise<EditSuggestResult> {
    const text = instruction?.trim() || 'Write the selected ideas into the article, each where it belongs.'
    return this.suggest(id, text, modelOverride, { ideaIds })
  }

  // ---- brief and writing profile

  async setBrief(id: string, brief: Brief): Promise<void> {
    const b = await this.get(id)
    await this.store.save(id, { ...b, meta: setBrief(b.meta, brief) })
  }

  /** Saves a profile in the writer's settings (new, or replacing one with the same id). Returns it, or undefined when it has no name. */
  saveProfile(profile: { id?: string; name: string; voice?: string; terms?: { use: string; instead?: string }[] }): Promise<StyleProfile | undefined> {
    return saveProfile(this.store, profile, this.newId)
  }

  profiles(): Promise<StyleProfile[]> {
    return loadProfiles(this.store)
  }

  async deleteProfile(profileId: string): Promise<void> {
    await deleteProfile(this.store, profileId)
  }

  /** Gives the article a copy of a saved profile (null removes it). A later edit of the saved profile does not change articles that already use it until the writer applies it again. */
  async useProfile(id: string, profileId: string | null): Promise<{ ok: boolean; reason?: string }> {
    const b = await this.get(id)
    const profile = profileId === null ? null : (await loadProfiles(this.store)).find((p) => p.id === profileId)
    if (profile === undefined) return { ok: false, reason: `No profile ${profileId}.` }
    await this.store.save(id, { ...b, meta: applyProfile(b.meta, profile) })
    return { ok: true }
  }

  // ---- editing in place

  /** Renames a section by changing its heading line in the text, which is where the heading lives. The section keeps its identity. */
  async renameSection(id: string, sectionId: string, heading: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const b = await this.get(id)
    const sec = b.meta.sections.find((x) => x.id === sectionId)
    if (!sec) return { ok: false, reason: `No section ${sectionId}.` }
    if (sec.level < 1) return { ok: false, reason: 'The opening has no heading to rename.' }
    const clean = heading.split(/\s+/).filter(Boolean).join(' ')
    if (!clean) return { ok: false, reason: 'A heading cannot be empty.' }
    const lineEnd = b.markdown.indexOf('\n', sec.span.start)
    const end = lineEnd === -1 ? b.markdown.length : lineEnd
    const md = `${b.markdown.slice(0, sec.span.start)}${'#'.repeat(sec.level)} ${clean}${b.markdown.slice(end)}`
    await this.updateText(id, md, { analyze: false })
    return { ok: true }
  }

  /** The one-line purpose the outline shows under a section. An empty text removes it. */
  async setSectionPurpose(id: string, sectionId: string, purpose: string): Promise<void> {
    const b = await this.get(id)
    if (!b.meta.sections.some((x) => x.id === sectionId)) throw new Error(`No section ${sectionId}.`)
    const text = purpose.trim()
    await this.store.save(id, { ...b, meta: { ...b.meta, sections: b.meta.sections.map((x) => (x.id === sectionId ? { ...x, purpose: text || undefined } : x)) } })
  }

  async addComment(id: string, range: TextRange, text: string): Promise<{ ok: true } | { ok: false; reason: string }> {
    const b = await this.get(id)
    const r = addCommentOnText(b.meta, b.markdown, range, text, this.now())
    if (!r.ok) return r
    await this.store.save(id, { ...b, meta: r.meta })
    return { ok: true }
  }

  async editComment(id: string, commentId: string, patch: { text?: string; decision?: string }): Promise<{ ok: boolean; reason?: string }> {
    const b = await this.get(id)
    const c = b.meta.comments.find((x) => x.id === commentId)
    if (!c) return { ok: false, reason: `No comment ${commentId}.` }
    const text = patch.text !== undefined ? patch.text.trim() : c.text
    if (!text) return { ok: false, reason: 'A comment needs some text.' }
    const decision = patch.decision !== undefined ? patch.decision.trim() || undefined : c.decision
    await this.store.save(id, { ...b, meta: { ...b.meta, comments: b.meta.comments.map((x) => (x.id === commentId ? { ...x, text, decision } : x)) } })
    return { ok: true }
  }

  async deleteComment(id: string, commentId: string): Promise<void> {
    const b = await this.get(id)
    const comments = b.meta.comments.filter((x) => x.id !== commentId).map((x) => ({ ...x, conflictsWith: x.conflictsWith.filter((o) => o !== commentId) }))
    await this.store.save(id, { ...b, meta: { ...b.meta, comments } })
  }

  async editCorrection(id: string, correctionId: string, patch: { note?: string; supersedes?: string }): Promise<{ ok: boolean; reason?: string }> {
    const b = await this.get(id)
    const c = b.meta.corrections.find((x) => x.id === correctionId)
    if (!c) return { ok: false, reason: `No correction ${correctionId}.` }
    const note = patch.note !== undefined ? patch.note.trim() : c.note
    if (!note) return { ok: false, reason: 'A correction needs some text.' }
    const supersedes = patch.supersedes !== undefined ? patch.supersedes.trim() || undefined : c.supersedes
    await this.store.save(id, { ...b, meta: { ...b.meta, corrections: b.meta.corrections.map((x) => (x.id === correctionId ? { ...x, note, supersedes } : x)) } })
    return { ok: true }
  }

  /** Editing a source's passage replaces it as the writer's own new text, so checks made against the old passage stop counting until they are run again. */
  async editSource(id: string, sourceId: string, patch: { address?: string; note?: string; passage?: string }): Promise<{ ok: boolean; reason?: string }> {
    const b = await this.get(id)
    const src = b.meta.sources.find((x) => x.id === sourceId)
    if (!src) return { ok: false, reason: `No source ${sourceId}.` }
    let next = { ...src }
    if (patch.address !== undefined) next.address = patch.address.trim() || undefined
    if (patch.note !== undefined) next.note = patch.note.trim() || undefined
    if (patch.passage !== undefined && patch.passage !== src.passage) next = { ...acceptNewPassage(next, patch.passage, this.now()), fetchedPassage: undefined }
    await this.store.save(id, { ...b, meta: { ...b.meta, sources: b.meta.sources.map((x) => (x.id === sourceId ? next : x)) } })
    return { ok: true }
  }

  /** Renames a saved version. A published version is frozen, label included. */
  async renameVersion(id: string, index: number, label: string): Promise<{ ok: boolean; reason?: string }> {
    const b = await this.get(id)
    const snap = b.snapshots[index]
    if (!snap) return { ok: false, reason: `No version ${index}.` }
    if (snap.kind === 'published') return { ok: false, reason: 'A published version is frozen.' }
    const snapshots = b.snapshots.map((x, i) => (i === index ? { ...x, label: label.trim() || undefined } : x))
    await this.store.save(id, { ...b, snapshots })
    return { ok: true }
  }

  // ---- resolving issues in batches

  /** Accepts every pending suggestion in one go: one checkpoint first, then from the end of the text to the start so earlier ones keep their place. */
  async acceptAllSuggestions(id: string): Promise<{ accepted: number; skipped: number }> {
    const b = await this.get(id)
    const pending = b.meta.suggestions.filter((x) => x.state === 'pending').sort((x, y) => y.span.start - x.span.start)
    if (pending.length === 0) return { accepted: 0, skipped: 0 }
    const snapshots = addSnapshot(b.snapshots, createSnapshot('checkpoint', b.markdown, b.meta, this.now(), 'Before accepting suggested changes'))
    let meta = b.meta
    let md = b.markdown
    let accepted = 0
    let skipped = 0
    for (const sg of pending) {
      const r = acceptSuggestion(meta, md, sg.id)
      if (r.ok) { meta = r.meta; md = r.markdown; accepted++ } else skipped++
    }
    await this.store.save(id, { ...b, markdown: md, meta, snapshots })
    await this.updateText(id, md, { analyze: false })
    return { accepted, skipped }
  }

  /**
   * The one action for each category of issues (see article-issues.ts). Where the answer is a change to the text it is a set of suggestions,
   * never an edit: suggested changes are accepted (all at once) from the "suggestions" category.
   */
  async resolveCategory(id: string, category: IssueCategory, options: { model?: string } = {}): Promise<ResolveReport> {
    const b = await this.get(id)
    const meta = b.meta
    const model = options.model
    const fix = async (instruction: string, refs: { commentIds?: string[]; sectionIds?: string[] }, none: string): Promise<ResolveReport> => {
      const r = await this.suggest(id, instruction, model, refs)
      if (r.status === 'failed') return { category, done: 0, note: 'The suggestions could not be made. Nothing was changed.' }
      return { category, done: r.added.length, note: r.added.length === 0 ? none : `${r.added.length} suggested change${r.added.length === 1 ? '' : 's'} added${model ? ` (${model})` : ''}. Accept them under Suggested changes.` }
    }
    switch (category) {
      case 'suggestions': {
        const r = await this.acceptAllSuggestions(id)
        return { category, done: r.accepted, note: `${r.accepted} accepted${r.skipped > 0 ? `, ${r.skipped} no longer fit` : ''}. The text as it was is saved in History.` }
      }
      case 'stale': {
        const n = meta.suggestions.filter((x) => x.state === 'stale').length
        await this.store.save(id, { ...b, meta: { ...meta, suggestions: meta.suggestions.map((x) => (x.state === 'stale' ? { ...x, state: 'rejected' as const } : x)) } })
        return { category, done: n, note: `${n} dismissed.` }
      }
      case 'links': {
        const n = meta.links.filter((l) => l.origin === 'proposed').length
        await this.store.save(id, { ...b, meta: { ...meta, links: meta.links.map((l) => (l.origin === 'proposed' ? { ...l, origin: 'confirmed' as const } : l)) } })
        return { category, done: n, note: `${n} confirmed.` }
      }
      case 'checkable': {
        const todo = checkableClaims(meta).slice(0, 25)
        let next = meta
        let checked = 0
        const { llm, onUsage } = this.opts
        const used = model ?? this.checker()
        for (const c of todo) {
          const r = await checkClaimSupport({ meta: next, markdown: b.markdown, claimId: c.id, modelName: this.opts.modelName ?? used ?? 'model', now: this.now() }, llm, used, onUsage)
          if (r.status === 'checked') { next = r.meta; checked++ }
        }
        if (next !== meta) await this.store.save(id, { ...b, meta: next })
        return { category, done: checked, note: `${checked} of ${todo.length} checked${used ? ` (${used})` : ''}.` }
      }
      case 'comments': {
        const open = meta.comments.filter((c) => c.state === 'open' && c.conflictsWith.length === 0)
        if (open.length === 0) return { category, done: 0, note: 'No comments to act on.' }
        const lines = open.map((c) => `- ${c.label ?? c.id}${c.span ? ` (on: "${c.span.quote}")` : ''}: ${c.text}${c.decision ? ` The writer decided: ${c.decision}.` : ''}`)
        return fix(`Address these open reviewer comments with the smallest edits that do what each asks:\n${lines.join('\n')}`, { commentIds: open.map((c) => c.id) }, 'None of these comments can be addressed by editing the text.')
      }
      case 'unsupported': {
        const claims = unsupportedClaims(meta)
        if (claims.length === 0) return { category, done: 0, note: 'Nothing to fix.' }
        const lines = claims.map((c) => `- "${c.quote}"`)
        return fix(`These claims have no source, or the source does not back them. For each, suggest an edit that removes it or qualifies it so the text claims only what can be backed. Do not invent a source, a figure or a fact:\n${lines.join('\n')}`, {}, 'I found no safe way to change these without a source.')
      }
      case 'sections': {
        const secs = meta.sections.filter((x) => x.review.state === 'needs_review')
        if (secs.length === 0) return { category, done: 0, note: 'Nothing to review.' }
        const lines = secs.map((x) => `- ${x.heading || '(opening)'}: ${x.review.reason ?? 'something it depends on changed'}`)
        return fix(`These sections were flagged because something they depend on changed. Suggest the edits that bring each in line, and change nothing that does not need to change:\n${lines.join('\n')}`, { sectionIds: secs.map((x) => x.id) }, 'These sections look fine as they are.')
      }
    }
  }

  /** Every category in a sensible order, one action each. It prepares suggestions but does not apply them; `accept` also applies them at the end. */
  async resolveAll(id: string, options: { model?: string; categories?: IssueCategory[]; accept?: boolean } = {}): Promise<ResolveReport[]> {
    const order: IssueCategory[] = ['links', 'checkable', 'comments', 'unsupported', 'sections', 'stale']
    const wanted = options.categories ?? order
    const reports: ResolveReport[] = []
    for (const category of order) if (wanted.includes(category)) reports.push(await this.resolveCategory(id, category, { model: options.model }))
    if (options.accept) reports.push(await this.resolveCategory(id, 'suggestions', { model: options.model }))
    return reports
  }

  /** The writer changes the replacement text of a waiting suggestion before accepting it. */
  async editSuggestion(id: string, suggestionId: string, replacement: string): Promise<{ ok: boolean; reason?: string }> {
    const b = await this.get(id)
    const sg = b.meta.suggestions.find((x) => x.id === suggestionId)
    if (!sg) return { ok: false, reason: `No suggestion ${suggestionId}.` }
    if (sg.state !== 'pending') return { ok: false, reason: `Suggestion ${suggestionId} is ${sg.state}, not pending.` }
    await this.store.save(id, { ...b, meta: { ...b.meta, suggestions: b.meta.suggestions.map((x) => (x.id === suggestionId ? { ...x, replacement } : x)) } })
    return { ok: true }
  }

  readiness(bundle: ArticleBundle): { readiness: Readiness; problems: Problem[] } {
    return { readiness: computeReadiness(bundle.meta), problems: checkIntegrity(bundle.meta) }
  }

  /** A dated, frozen snapshot (D4). Publishing is always allowed (D3); the snapshot records the readiness counts at that moment. */
  async publish(id: string, label?: string): Promise<ArticleBundle> {
    const b = await this.get(id)
    const snapshot = createSnapshot('published', b.markdown, b.meta, this.now(), label)
    const next: ArticleBundle = { ...b, meta: { ...b.meta, status: 'published' }, snapshots: [...b.snapshots, snapshot] }
    await this.store.save(id, next)
    return next
  }

  async exportArticle(id: string): Promise<ArticleFolder> {
    return serializeArticle(await this.get(id))
  }

  /** Imports a folder under its own id. Refuses a folder it cannot read completely, and refuses to overwrite an existing article. */
  async importArticle(folder: ArticleFolder): Promise<{ ok: true; id: string } | { ok: false; reason: string }> {
    const loaded = loadArticleFolder(folder)
    if (!loaded.ok) return loaded
    const id = loaded.bundle.meta.id
    if (await this.store.load(id)) return { ok: false, reason: `An article with id ${id} already exists here.` }
    await this.store.save(id, loaded.bundle)
    return { ok: true, id }
  }
}

// ----------------------------------------------------------------------------- chat-held state stored inside the articles

const ACTIVE_KEY = 'writer:active-article'
const PENDING_KEY = 'writer:pending-ops'

/**
 * The chat-held state port backed by the article store: each article's comments and corrections live in its own
 * metadata (so they travel with an export), the active article and any held items in the store's settings.
 */
export function createArticleChatPort(store: ArticleStore): WriterChatPort {
  return {
    articles: () => store.list(),
    async openItemsText(articleId) {
      const m = (await store.load(articleId))?.meta
      return m ? renderIssuesForChat(m) : ''
    },
    async styleText(articleId) {
      const m = (await store.load(articleId))?.meta
      return m ? renderStyleGuide(m) : ''
    },
    async ideasText(articleId) {
      const open = ((await store.load(articleId))?.meta.ideas ?? []).filter((i) => i.state === 'open')
      return open.map((i) => i.text)
    },
    async captureEnabled() {
      return (await loadPermissions(store)).captureChat
    },
    async articleText(articleId) {
      return (await store.load(articleId))?.markdown
    },
    async load(): Promise<WriterChatState> {
      const state = createEmptyWriterChatState()
      for (const ref of await store.list()) {
        const b = await store.load(ref.id)
        if (!b) continue
        state.comments.push(...b.meta.comments)
        state.corrections.push(...b.meta.corrections)
      }
      return state
    },
    async save(state: WriterChatState): Promise<void> {
      for (const ref of await store.list()) {
        const b = await store.load(ref.id)
        if (!b) continue
        const comments = state.comments.filter((c) => c.articleId === ref.id)
        const corrections = state.corrections.filter((c) => c.articleId === ref.id)
        if (JSON.stringify(comments) === JSON.stringify(b.meta.comments) && JSON.stringify(corrections) === JSON.stringify(b.meta.corrections)) continue
        await store.save(ref.id, { ...b, meta: { ...b.meta, comments, corrections } })
      }
    },
    async getActive() {
      const v = await store.getSetting(ACTIVE_KEY)
      return typeof v === 'string' ? v : undefined
    },
    async setActive(articleId) {
      await store.setSetting(ACTIVE_KEY, articleId)
    },
    async getPending() {
      const v = await store.getSetting(PENDING_KEY)
      return Array.isArray(v) ? (v as CaptureOp[]) : undefined
    },
    async setPending(ops) {
      await store.setSetting(PENDING_KEY, ops && ops.length > 0 ? ops : undefined)
    },
  }
}

/** Methods that only read; they do not wait behind a long model step on the same article. */
const READ_ONLY = new Set(['get', 'list', 'readiness', 'history', 'getVersion', 'compareWithCurrent', 'changeSinceLastVersion', 'profiles', 'exportArticle'])

/**
 * The service with each article's calls run one after another. A step reads the article, waits for the model and saves, so two steps on the same
 * article at once would each save from the text they first read and the later save would erase the earlier one (found in pilot P1: three
 * source-link proposals started together left only one set of links). Calls on different articles still run together, and reads never wait.
 * The calls the service makes on itself are not queued again, so a step that calls another cannot wait on itself.
 */
export function serializeByArticle<T extends object>(service: T): T {
  const tails = new Map<string, Promise<unknown>>()
  return new Proxy(service, {
    get(target, prop) {
      const member = Reflect.get(target, prop, target) as unknown
      if (typeof member !== 'function' || typeof prop !== 'string' || READ_ONLY.has(prop)) return member
      return (...args: unknown[]): Promise<unknown> => {
        const key = typeof args[0] === 'string' ? args[0] : ''
        const run = (): unknown => (member as (...a: unknown[]) => unknown).apply(target, args)
        if (!key) return Promise.resolve(run())
        const result = (tails.get(key) ?? Promise.resolve()).then(run, run)
        tails.set(key, result.catch(() => undefined))
        return result as Promise<unknown>
      }
    },
  })
}
