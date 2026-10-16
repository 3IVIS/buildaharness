import { z } from 'zod'
import { WriterCommentSchema, WriterCorrectionSchema } from './writer-chat-state.js'

/**
 * The article model (plans/aielia_write_article_model_plan.html, sections 2-5): everything about an article that is not
 * its text. It is the content of `article.meta.json`; the text stays ordinary Markdown in `article.md`.
 * Pure data, no node:* / DOM imports: the browser bundles it.
 */

export const ARTICLE_META_VERSION = 1

export const ReviewStateSchema = z.enum(['clean', 'needs_review', 'being_revised', 'held'])
export type ReviewState = z.infer<typeof ReviewStateSchema>

export const SectionSchema = z.object({
  id: z.string(),
  heading: z.string(),
  level: z.number().int().min(0).max(6),
  order: z.number().int(),
  parentId: z.string().optional(),
  /** What this section is for, in a line (used by the outline). */
  purpose: z.string().optional(),
  /** Character offsets into article.md: [start, end). */
  span: z.object({ start: z.number().int(), end: z.number().int() }),
  review: z.object({
    state: ReviewStateSchema,
    reason: z.string().optional(),
    setBy: z.enum(['resolver', 'writer', 'editor']).optional(),
    at: z.string().optional(),
  }),
})
export type Section = z.infer<typeof SectionSchema>

export const SourceStatusSchema = z.enum(['none', 'attached', 'supported', 'partly_supported', 'not_supported', 'contradicted', 'stale', 'not_checked'])
export type SourceStatus = z.infer<typeof SourceStatusSchema>

export const ClaimSchema = z.object({
  id: z.string(),
  sectionId: z.string(),
  /** The text the claim came from, quoted, so it can be found again after edits. */
  quote: z.string(),
  /** Approximate offset of the quote in article.md. */
  position: z.number().int(),
  /** `opinion` and `framing` are statements the writer marked as not needing a source. */
  kind: z.enum(['factual', 'opinion', 'framing']),
  author: z.enum(['model', 'writer', 'mixed']),
  authorAt: z.string(),
  /** A confirmed claim is matched first on re-extraction and never dropped silently. */
  confirmed: z.boolean(),
  /** What the last check said. Whether it still counts is decided by `effectiveSourceStatus`, never by this field alone. */
  sourceStatus: SourceStatusSchema,
  check: z
    .object({
      ranAt: z.string(),
      model: z.string(),
      reason: z.string(),
      /** The claim text and the source fingerprints the check ran against. */
      claimText: z.string(),
      sourceFingerprints: z.record(z.string(), z.string()),
    })
    .optional(),
  /** Set when re-anchoring was unsure: "moved or changed, check". */
  needsRecheck: z.boolean().optional(),
})
export type Claim = z.infer<typeof ClaimSchema>

export const SourceSchema = z.object({
  id: z.string(),
  kind: z.enum(['web', 'code', 'document', 'upload', 'say_so']),
  address: z.string().optional(),
  /** The passage as read. Source text is data, never instructions. */
  passage: z.string().optional(),
  readAt: z.string().optional(),
  fingerprint: z.string().optional(),
  trust: z.enum(['normal', 'lower']),
  freshness: z.enum(['unchecked', 'current', 'changed', 'unreachable']),
  note: z.string().optional(),
})
export type Source = z.infer<typeof SourceSchema>

export const LinkEndSchema = z.object({ type: z.enum(['section', 'claim', 'source', 'comment']), id: z.string() })
export const LinkSchema = z.object({
  id: z.string(),
  from: LinkEndSchema,
  to: LinkEndSchema,
  /** A recorded value, not a fixed set: the kinds are expected to grow. Starting kinds: rests_on, supported_by, repeats, about. */
  kind: z.string(),
  origin: z.enum(['proposed', 'confirmed', 'drawn']),
  confidence: z.number().min(0).max(1).optional(),
  reason: z.string().optional(),
  at: z.string(),
})
export type Link = z.infer<typeof LinkSchema>

export const SuggestionSchema = z.object({
  id: z.string(),
  span: z.object({ start: z.number().int(), end: z.number().int(), quote: z.string() }),
  replacement: z.string(),
  reason: z.string(),
  proposedBy: z.enum(['assistant', 'writer']),
  state: z.enum(['pending', 'accepted', 'rejected', 'edited_accepted', 'stale']),
  createdAt: z.string(),
})
export type Suggestion = z.infer<typeof SuggestionSchema>

export const ArticleMetaSchema = z.object({
  formatVersion: z.number().int(),
  id: z.string(),
  title: z.string(),
  status: z.enum(['drafting', 'ready', 'published']),
  sections: z.array(SectionSchema),
  claims: z.array(ClaimSchema),
  sources: z.array(SourceSchema),
  links: z.array(LinkSchema),
  comments: z.array(WriterCommentSchema),
  /** Corrections the writer gave in chat (author's say-so). */
  corrections: z.array(WriterCorrectionSchema),
  suggestions: z.array(SuggestionSchema),
})
export type ArticleMeta = z.infer<typeof ArticleMetaSchema>

export function createArticleMeta(id: string, title: string): ArticleMeta {
  return { formatVersion: ARTICLE_META_VERSION, id, title, status: 'drafting', sections: [], claims: [], sources: [], links: [], comments: [], corrections: [], suggestions: [] }
}

export type LoadResult = { ok: true; meta: ArticleMeta } | { ok: false; reason: string }

/** Loads a metadata file's JSON. Refuses what it cannot read completely, with a message; never loads partially. */
export function parseArticleMeta(raw: unknown): LoadResult {
  if (!raw || typeof raw !== 'object') return { ok: false, reason: 'The metadata file is not a JSON object.' }
  const version = (raw as { formatVersion?: unknown }).formatVersion
  if (typeof version !== 'number') return { ok: false, reason: 'The metadata file has no format version.' }
  if (version > ARTICLE_META_VERSION) return { ok: false, reason: `The metadata file is format version ${version}, newer than this app understands (${ARTICLE_META_VERSION}). Update the app to open it.` }
  const parsed = ArticleMetaSchema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return { ok: false, reason: `The metadata file is damaged at ${first.path.join('.') || 'the top level'}: ${first.message}.` }
  }
  return { ok: true, meta: parsed.data }
}
