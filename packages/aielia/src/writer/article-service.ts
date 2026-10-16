import type { ILLMClient, TokenUsage } from '@buildaharness/runtime'
import { extractClaims, type ExtractionResult } from './article-claims.js'
import { serializeArticle, loadArticleFolder, type ArticleBundle, type ArticleFolder } from './article-folder.js'
import { createArticleMeta, type ArticleMeta, type Claim, type Link, type Source } from './article-model.js'
import { resolveChange, type ResolveResult } from './article-resolver.js'
import { checkIntegrity, computeReadiness, createSnapshot, type Problem, type Readiness } from './article-rules.js'
import { reconcileSections } from './article-sections.js'
import { createSource } from './article-sources.js'
import { refreshSuggestions } from './article-suggestions.js'
import { checkClaimSupport, needsAutoCheck, type SupportCheck } from './article-support.js'
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
      return [...bundles.entries()].map(([id, b]) => ({ id, title: b.meta.title }))
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
  /** Model for the structural and checking calls. */
  llm: ILLMClient
  model?: string
  /** The name stored with a check result ("which model ran it"). */
  modelName?: string
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
}

function sectionText(markdown: string, s: { span: { start: number; end: number } }): string {
  return markdown.slice(s.span.start, s.span.end)
}

const clip = (t: string, n = 400): string => (t.length > n ? `${t.slice(0, n)}…` : t)

export class ArticleService {
  private readonly store: ArticleStore
  private readonly now: () => string
  private readonly newId: () => string

  constructor(private readonly opts: ArticleServiceOptions) {
    this.store = opts.store
    this.now = opts.now ?? ((): string => new Date().toISOString())
    this.newId = opts.newId ?? ((): string => `a-${crypto.randomUUID().slice(0, 8)}`)
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
    await this.store.save(id, { markdown, meta: { ...meta, sections }, snapshots: [] })
    return id
  }

  /**
   * The writer's text changed. Structure first (no model): re-anchor sections and refresh suggestions, then save. Then, unless
   * `analyze` is false, the model judgements: extract claims, run the automatic checks on text the model wrote, and judge what
   * the edit means for the other sections. A failed model step leaves its part as it was and is reported in the outcome.
   */
  async updateText(id: string, markdown: string, options: { analyze?: boolean } = {}): Promise<UpdateOutcome> {
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

    let meta = refreshSuggestions({ ...before.meta, sections: rec.sections }, markdown)
    let bundle: ArticleBundle = { ...before, markdown, meta }
    await this.store.save(id, bundle)
    const outcome: UpdateOutcome = { bundle, changedSectionIds, removedSections: rec.removed.map((s) => s.heading), autoChecks: [] }
    if (options.analyze === false || changedSectionIds.length === 0) return outcome

    meta = await this.extractAndCheck(meta, markdown, outcome)

    const { llm, model, onUsage } = this.opts
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

    bundle = { ...before, markdown, meta }
    await this.store.save(id, bundle)
    outcome.bundle = bundle
    return outcome
  }

  /** Claim extraction and the automatic checks over the whole article: the first pass for a new article, or on request. Model steps that fail are reported and leave their part as it was. */
  async analyze(id: string): Promise<UpdateOutcome> {
    const b = await this.get(id)
    const outcome: UpdateOutcome = { bundle: b, changedSectionIds: b.meta.sections.map((x) => x.id), removedSections: [], autoChecks: [] }
    const meta = await this.extractAndCheck(b.meta, b.markdown, outcome)
    outcome.bundle = { ...b, meta }
    await this.store.save(id, outcome.bundle)
    return outcome
  }

  private async extractAndCheck(start: ArticleMeta, markdown: string, outcome: UpdateOutcome): Promise<ArticleMeta> {
    const { llm, model, onUsage } = this.opts
    let meta = start
    const extraction = await extractClaims({ markdown, sections: meta.sections, claims: meta.claims, now: this.now() }, llm, model, onUsage)
    outcome.extraction = extraction
    if (extraction.status === 'extracted') meta = { ...meta, claims: extraction.claims }
    for (const claimId of [...extraction.added, ...extraction.matched]) {
      const claim = meta.claims.find((c) => c.id === claimId)
      if (!claim || !needsAutoCheck(claim) || (claim.sourceStatus === 'supported' && claim.check)) continue
      const check = await checkClaimSupport({ meta, markdown, claimId, modelName: this.opts.modelName ?? this.opts.model ?? 'model', now: this.now() }, llm, model, onUsage)
      outcome.autoChecks.push({ claimId, status: check.status })
      meta = check.meta
    }
    return meta
  }

  async addSource(id: string, input: { kind: Source['kind']; address?: string; passage?: string; note?: string }): Promise<string> {
    const b = await this.get(id)
    let n = b.meta.sources.length + 1
    while (b.meta.sources.some((s) => s.id === `src${n}`)) n++
    const source = createSource({ id: `src${n}`, ...input, now: this.now() })
    await this.store.save(id, { ...b, meta: { ...b.meta, sources: [...b.meta.sources, source] } })
    return source.id
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

  async checkClaim(id: string, claimId: string): Promise<SupportCheck> {
    const b = await this.get(id)
    const { llm, model, onUsage } = this.opts
    const check = await checkClaimSupport({ meta: b.meta, markdown: b.markdown, claimId, modelName: this.opts.modelName ?? model ?? 'model', now: this.now() }, llm, model, onUsage)
    if (check.meta !== b.meta) await this.store.save(id, { ...b, meta: check.meta })
    return check
  }

  /** The writer confirms a claim (and may change its kind). A confirmed claim is matched first on re-extraction and never dropped silently. */
  async confirmClaim(id: string, claimId: string, kind?: Claim['kind']): Promise<void> {
    const b = await this.get(id)
    if (!b.meta.claims.some((c) => c.id === claimId)) throw new Error(`No claim ${claimId}.`)
    const claims = b.meta.claims.map((c): Claim => (c.id === claimId ? { ...c, confirmed: true, needsRecheck: undefined, kind: kind ?? c.kind, author: c.author === 'model' ? 'mixed' : c.author } : c))
    await this.store.save(id, { ...b, meta: { ...b.meta, claims } })
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
