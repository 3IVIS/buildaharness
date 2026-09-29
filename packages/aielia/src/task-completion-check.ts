import type { ILLMClient, TokenUsage } from '@buildaharness/runtime'
import { parseModelJson } from './model-json.js'

export interface TaskCompletionResult {
  /** `false` only when the check positively judged the output did not accomplish the task. */
  done: boolean
  reason?: string
}

const TASK_COMPLETION_SCHEMA = {
  type: 'object',
  properties: {
    done: { type: 'boolean' },
    reason: { type: 'string' },
  },
  required: ['done'],
}

const SYSTEM_PROMPT =
  'You judge whether an assistant actually accomplished a task. You are given JSON with "task" (what the ' +
  'task asked for) and "output" (what the assistant produced for it). Respond with JSON only: ' +
  '{"done": boolean, "reason": string}. "done" is true only if the output does what the task asked — it ' +
  'contains the requested deliverable, decision or result, or clearly reports having done the thing. It is ' +
  'false when the output refuses, says it cannot do the task, asks the user a question instead of doing it, ' +
  'only offers options or promises to do it later, or is about something else. An output that does the task ' +
  'while noting a caveat is still done. A long output may be shortened in the middle (marked "[... omitted ...]"): judge ' +
  'on what you can see and never treat the omission marker as missing content. "reason" is one short sentence ' +
  'saying what is missing when done is false.'

/**
 * `AUDIT_SEMANTIC_TASK_COMPLETION` gate. Default **OFF**: the harness marks a plan task COMPLETE as
 * soon as the reply is produced, exactly as before. A truthy value (`1` / `true` / `on` / `yes` /
 * `enabled`) turns on the per-task check for a durable plan's execution. Unlike the other semantic
 * hooks this one changes plan behaviour (a task judged not done fails instead of completing), so it
 * ships off until a benchmark shows it helps. Read at exactly one site: harness-bridge.ts.
 */
export function semanticTaskCompletionEnabled(env?: Record<string, string | undefined>): boolean {
  const source = env ?? (typeof process !== 'undefined' ? process.env : {})
  const raw = String(source.AUDIT_SEMANTIC_TASK_COMPLETION ?? '').trim().toLowerCase()
  return ['1', 'true', 'on', 'yes', 'enabled'].includes(raw)
}

// A real step deliverable (a risk register, a schedule, a draft) runs to thousands of characters; cutting it
// at the end made the check call a complete answer unfinished. Keep the start and the end, drop the middle.
const OUTPUT_HEAD_CHARS = 9000
const OUTPUT_TAIL_CHARS = 3000
const OMISSION_MARKER = '\n[... omitted ...]\n'

export function shortenForCheck(text: string): string {
  if (text.length <= OUTPUT_HEAD_CHARS + OUTPUT_TAIL_CHARS) return text
  return text.slice(0, OUTPUT_HEAD_CHARS) + OMISSION_MARKER + text.slice(-OUTPUT_TAIL_CHARS)
}

/**
 * One bounded LLM call: did this output accomplish the task? Fails open — any error, empty output or
 * unparseable response is `done: true`, so a broken check can never strand a plan that would have
 * completed today; only a positive "not done" changes anything.
 */
export async function checkTaskCompletion(
  input: { taskDescription: string; output: unknown },
  llmClient: ILLMClient,
  model?: string,
  onUsage?: (usage: TokenUsage) => void,
): Promise<TaskCompletionResult> {
  const text = typeof input.output === 'string' ? input.output : JSON.stringify(input.output ?? '')
  if (!text || !text.trim()) return { done: true }
  try {
    const response = await llmClient.callChatStructured(
      [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({ task: input.taskDescription, output: shortenForCheck(text) }) },
      ],
      undefined,
      { model, onUsage, structuredOutput: { schema: TASK_COMPLETION_SCHEMA } },
    )
    const parsed = parseModelJson(response.content) as { done?: unknown; reason?: unknown }
    if (parsed.done === false) return { done: false, reason: typeof parsed.reason === 'string' ? parsed.reason : undefined }
    return { done: true }
  } catch {
    return { done: true }
  }
}
