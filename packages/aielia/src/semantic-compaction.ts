import type { ChatMessage, ILLMClient, TokenUsage } from '@buildaharness/runtime'
import { parseModelJson } from './model-json.js'
import { shortenForCheck } from './task-completion-check.js'

const SUMMARY_SCHEMA = {
  type: 'object',
  properties: { summary: { type: 'string' } },
  required: ['summary'],
}

const SYSTEM_PROMPT =
  'You condense the earlier part of a conversation between a user and an assistant so the assistant can keep ' +
  'working from it. You are given JSON with "messages" (oldest first; one may be an earlier "[Earlier conversation ' +
  'summary]" — fold it in, do not repeat it). Respond with JSON only: {"summary": string}. Keep everything a later ' +
  'question could depend on: names, numbers, dates, amounts, decisions and their reasons, constraints and ' +
  'preferences the user stated, what the assistant actually produced or recommended (the content, not just that it ' +
  'did), and anything still open. Keep details from pasted documents or long messages that were discussed or could ' +
  'be asked about. Drop greetings, repetition and filler. Write short plain sentences or bullets, no more than about ' +
  '500 words. Never add anything that is not in the messages. A long message may be shortened in the middle (marked ' +
  '"[... omitted ...]"): say only what you can see.'

/**
 * `AUDIT_SEMANTIC_COMPACTION` gate. Default **OFF**: once a transcript is long, transcript-compaction.ts keeps the
 * first 200 characters of each older message and nothing else, so a detail deep in an earlier message (a pasted
 * document, a long answer) is gone from what the model sees — and the model has no tool to search the message index.
 * On, ONE bounded call writes the summary instead (see summarizeOlderMessages); any failure falls back to the
 * truncated form. Costs one call each time the thresholds trip. A truthy value (`1` / `true` / `on` / `yes` /
 * `enabled`) enables it. Read at exactly one site: assistant.ts.
 */
export function semanticCompactionEnabled(env?: Record<string, string | undefined>): boolean {
  const source = env ?? (typeof process !== 'undefined' ? process.env : {})
  const raw = String(source.AUDIT_SEMANTIC_COMPACTION ?? '').trim().toLowerCase()
  return ['1', 'true', 'on', 'yes', 'enabled'].includes(raw)
}

/** More than this after shortening each message means the input is not one this call can take; use the free form. */
const MAX_INPUT_CHARS = 80_000
const MAX_SUMMARY_CHARS = 8_000

/**
 * One bounded LLM call: the older messages of a long conversation, condensed with their specifics kept. Returns null
 * — the caller then uses the truncated form — on any error, an empty or unparseable answer, or input too large.
 */
export async function summarizeOlderMessages(
  older: ChatMessage[],
  llmClient: ILLMClient,
  model?: string,
  onUsage?: (usage: TokenUsage) => void,
): Promise<string | null> {
  if (older.length === 0) return null
  const messages = older.map((m) => ({ role: m.role, content: shortenForCheck(m.content) }))
  if (messages.reduce((sum, m) => sum + m.content.length, 0) > MAX_INPUT_CHARS) return null
  try {
    const response = await llmClient.callChatStructured(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({ messages }) },
      ],
      undefined,
      { model, onUsage, structuredOutput: { schema: SUMMARY_SCHEMA } },
    )
    const parsed = parseModelJson(response.content) as { summary?: unknown }
    if (typeof parsed.summary !== 'string') return null
    const summary = parsed.summary.trim()
    return summary === '' ? null : summary.slice(0, MAX_SUMMARY_CHARS)
  } catch {
    return null
  }
}
