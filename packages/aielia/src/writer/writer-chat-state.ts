import { z } from 'zod'

/**
 * State the writer gives in chat (T13, plans/aielia_write_article_model_plan.html section 8): reviewer comments,
 * the writer's decisions about them, conflicts between comments, and corrections to facts or sources. It belongs to
 * the article, not to the conversation, so work that resumes in a new session still has it.
 *
 * Pure data and pure functions only (no node:* / DOM imports): the browser bundles this module.
 */

export const WRITER_CHAT_STATE_VERSION = 1

export const WriterCommentSchema = z.object({
  id: z.string(),
  articleId: z.string(),
  /** The label the writer or reviewer uses ("C1", "G2"), when there is one. Not unique across articles. */
  label: z.string().optional(),
  reviewer: z.string().optional(),
  text: z.string(),
  /** `open` covers "decided but not carried out": a decision is recorded, but the comment is only `addressed` once the text shows it. */
  state: z.enum(['open', 'addressed', 'dismissed']),
  decision: z.string().optional(),
  /** Ids of comments that cannot be followed together with this one. Always mutual. */
  conflictsWith: z.array(z.string()),
  origin: z.enum(['reviewer', 'writer', 'assistant']),
  /** Where the comment applies, when it is tied to one section or claim (article model, "about" link). */
  anchor: z.object({ type: z.enum(['section', 'claim']), id: z.string() }).optional(),
  /** The stretch of text the writer highlighted when commenting. Found again by the quote after the text changes. */
  span: z.object({ start: z.number().int(), end: z.number().int(), quote: z.string() }).optional(),
  /** The text the comment was on no longer exists as it was. The comment is kept. */
  outdated: z.boolean().optional(),
  /** The suggestion that addressed it, if any. */
  suggestionId: z.string().optional(),
  capturedAt: z.string(),
})
export type WriterComment = z.infer<typeof WriterCommentSchema>

/** A correction the writer states in chat. It is the "author's say-so" source kind (D2): lower-trust, and it supersedes what it names. */
export const WriterCorrectionSchema = z.object({
  id: z.string(),
  articleId: z.string(),
  kind: z.literal('say_so'),
  trust: z.literal('lower'),
  /** What is now true, in the writer's terms ("p99 latency is 41 ms after a re-run"). */
  note: z.string(),
  /** The earlier value or source it replaces, when the writer names one. */
  supersedes: z.string().optional(),
  capturedAt: z.string(),
})
export type WriterCorrection = z.infer<typeof WriterCorrectionSchema>

export const WriterChatStateSchema = z.object({
  formatVersion: z.literal(WRITER_CHAT_STATE_VERSION),
  comments: z.array(WriterCommentSchema),
  corrections: z.array(WriterCorrectionSchema),
})
export type WriterChatState = z.infer<typeof WriterChatStateSchema>

export interface ArticleRef {
  id: string
  title: string
  /** The short name shown in the header; the title is shown when there is none. */
  name?: string
}

export function createEmptyWriterChatState(): WriterChatState {
  return { formatVersion: WRITER_CHAT_STATE_VERSION, comments: [], corrections: [] }
}

/** One change the capture step proposes. `ref` is a comment id, or the label of a comment in the same article. */
export type CaptureOp =
  | { op: 'add_comment'; label?: string; reviewer?: string; text: string; origin?: 'reviewer' | 'writer' }
  | { op: 'decide'; ref: string; decision: string }
  | { op: 'conflict'; refs: string[] }
  | { op: 'set_state'; ref: string; state: 'addressed' | 'dismissed' }
  | { op: 'add_correction'; note: string; supersedes?: string }

export interface ApplyResult {
  state: WriterChatState
  /** One short line per change that was made. */
  applied: string[]
  /** One short line per op that could not be applied (unknown reference, empty text). Never silent. */
  skipped: string[]
}

function nextId(prefix: string, existing: readonly { id: string }[]): string {
  let n = existing.length + 1
  while (existing.some((e) => e.id === `${prefix}${n}`)) n++
  return `${prefix}${n}`
}

function findComment(comments: readonly WriterComment[], articleId: string, ref: string): WriterComment | undefined {
  const byId = comments.find((c) => c.id === ref && c.articleId === articleId)
  if (byId) return byId
  const wanted = ref.trim().toLowerCase()
  // Several comments can share a label across revisions of the same article; the latest one wins.
  return [...comments].reverse().find((c) => c.articleId === articleId && c.label?.trim().toLowerCase() === wanted)
}

/** Applies ops to the state for one article. Pure: returns a new state; the input is untouched. */
export function applyCaptureOps(state: WriterChatState, articleId: string, ops: readonly CaptureOp[], now: string): ApplyResult {
  const comments = state.comments.map((c) => ({ ...c, conflictsWith: [...c.conflictsWith] }))
  const corrections = [...state.corrections]
  const applied: string[] = []
  const skipped: string[] = []

  for (const op of ops) {
    if (op.op === 'add_comment') {
      if (!op.text.trim()) {
        skipped.push('comment with no text')
        continue
      }
      const id = nextId('wc', comments)
      comments.push({ id, articleId, label: op.label?.trim() || undefined, reviewer: op.reviewer?.trim() || undefined, text: op.text.trim(), state: 'open', conflictsWith: [], origin: op.origin ?? 'reviewer', capturedAt: now })
      applied.push(`added comment ${op.label ?? id}`)
    } else if (op.op === 'decide') {
      const c = findComment(comments, articleId, op.ref)
      if (!c || !op.decision.trim()) {
        skipped.push(`decision for unknown comment "${op.ref}"`)
        continue
      }
      c.decision = op.decision.trim()
      // The writer's choice ends a conflict this comment was in, on both sides: it is no longer one the writer has yet to settle.
      for (const other of comments) if (other.id === c.id || other.conflictsWith.includes(c.id)) other.conflictsWith = other.conflictsWith.filter((x) => x !== c.id && other.id !== c.id)
      applied.push(`recorded decision on ${c.label ?? c.id}`)
    } else if (op.op === 'set_state') {
      const c = findComment(comments, articleId, op.ref)
      if (!c) {
        skipped.push(`state change for unknown comment "${op.ref}"`)
        continue
      }
      c.state = op.state
      applied.push(`${c.label ?? c.id} marked ${op.state}`)
    } else if (op.op === 'conflict') {
      const found = op.refs.map((r) => findComment(comments, articleId, r))
      const real = found.filter((c): c is WriterComment => c !== undefined)
      if (real.length < 2 || real.length !== found.length) {
        skipped.push(`conflict between ${op.refs.join(', ')} (a comment is unknown)`)
        continue
      }
      for (const a of real) for (const b of real) if (a.id !== b.id && !a.conflictsWith.includes(b.id)) a.conflictsWith.push(b.id)
      applied.push(`marked ${real.map((c) => c.label ?? c.id).join(' and ')} as in conflict`)
    } else if (op.op === 'add_correction') {
      if (!op.note.trim()) {
        skipped.push('correction with no content')
        continue
      }
      corrections.push({ id: nextId('wx', corrections), articleId, kind: 'say_so', trust: 'lower', note: op.note.trim(), supersedes: op.supersedes?.trim() || undefined, capturedAt: now })
      applied.push('recorded a correction')
    }
  }
  return { state: { ...state, comments, corrections }, applied, skipped }
}

/**
 * The block added to the assistant's system prompt on every call: only the article under discussion, so work on one
 * article never leaks into another. Empty when there is nothing to say.
 */
export function renderWriterChatBlock(state: WriterChatState, articleId: string | undefined, articles: readonly ArticleRef[]): string {
  if (!articleId) return ''
  const comments = state.comments.filter((c) => c.articleId === articleId)
  const corrections = state.corrections.filter((c) => c.articleId === articleId)
  if (comments.length === 0 && corrections.length === 0) return ''
  const title = articles.find((a) => a.id === articleId)?.title ?? articleId
  const name = (c: WriterComment): string => c.label ?? c.id
  const lines: string[] = []
  for (const c of comments) {
    const who = c.reviewer ? ` (${c.reviewer})` : ''
    const conflict = c.conflictsWith.length > 0 ? `; IN CONFLICT with ${c.conflictsWith.map((id) => name(comments.find((x) => x.id === id) ?? c)).join(', ')}, the writer has not chosen` : ''
    const decision = c.decision ? `; writer decided: ${c.decision}` : c.state === 'open' && c.conflictsWith.length === 0 ? '; writer has not decided' : ''
    lines.push(`- comment ${name(c)}${who} [${c.state}]: ${c.text}${decision}${conflict}`)
  }
  for (const c of corrections) {
    lines.push(`- correction from the writer: ${c.note}${c.supersedes ? ` (replaces: ${c.supersedes})` : ''}`)
  }
  return (
    `\n\n[What the writer has told you in chat about the article "${title}", kept by the system across sessions. ` +
    'A correction from the writer outranks a source file that was not updated: use it, and tell the writer if the file now disagrees instead of reverting it. ' +
    'Comments marked open are still open, and so are comments in conflict: list them as open when asked what remains, and never pick a side in a conflict yourself. ' +
    'A decision records what the writer chose, not that it was carried out: check the article text before saying a comment is done.]\n' +
    lines.join('\n')
  )
}
