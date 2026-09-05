/**
 * LLM-as-judge for the harness benchmark (Plan Phase B follow-on — eval/README.md "Outstanding" #5).
 *
 * `graders.ts` defines the `JudgeModel` interface and scores a `grader.judge` rubric `skipped`
 * whenever no judge is supplied. This module supplies one: a `ClaudeCliLLMClient`-backed
 * implementation that makes a single deterministic YES/NO classification call per rubric.
 *
 * Robustness contract (tested in `judge.test.ts`, LLM-free):
 *   - a clear YES  → the task passes the judge check
 *   - a clear NO   → it fails
 *   - garbage / an ambiguous response → **false** (a judge that can't decide does not pass a task)
 *   - the LLM client throwing → **false**, never a re-throw (one flaky judge call must not abort
 *     a whole benchmark run)
 *
 * Only real runs (`scripts/run-harness-benchmark.ts`) wire a judge in; the machinery `*.test.ts`
 * stay judge-less, so their `judge` checks keep scoring `skipped`, unchanged.
 */
import type { ILLMClient, ChatMessage } from '@buildaharness/runtime'
import { ClaudeCliLLMClient } from '../src/claude-cli-llm-client.js'
import type { JudgeModel } from './graders.js'

const JUDGE_SYSTEM_PROMPT =
  'You are a strict, literal evaluation judge for an automated benchmark. You are given a ' +
  'rubric, the user request that was made, and the assistant reply that answered it. Decide ' +
  'only whether the reply satisfies the rubric as written. Do not reward effort, tone, or ' +
  'partial credit: if the reply does not clearly and fully satisfy the rubric, or you cannot ' +
  'tell, the verdict is NO. Reply with exactly one word — YES or NO — and nothing else.'

/** The exact per-rubric classification message. Deterministic; no examples, no chain-of-thought. */
export function buildJudgePrompt(rubric: string, prompt: string, reply: string): string {
  return [
    'RUBRIC (does the reply satisfy this?):',
    rubric,
    '',
    'USER REQUEST:',
    prompt,
    '',
    'ASSISTANT REPLY:',
    reply.length > 0 ? reply : '(the assistant produced no reply)',
    '',
    'Answer with exactly one word: YES if the reply fully satisfies the rubric, otherwise NO.',
  ].join('\n')
}

/**
 * Strict YES/NO parse. Reads the model's first line; a bare/leading `YES` → true, a bare/leading
 * `NO` → false. Anything else falls back to a whole-text scan and only returns true when `YES`
 * appears and `NO` does not — every genuinely ambiguous or empty response resolves to false.
 */
export function parseYesNo(raw: unknown): boolean {
  if (typeof raw !== 'string' || raw.trim().length === 0) return false
  const upper = raw.toUpperCase()
  const hasYes = /\bYES\b/.test(upper)
  const hasNo = /\bNO\b/.test(upper)
  // Both verdicts present anywhere (e.g. "YES and NO", "not sure — maybe YES, maybe NO") → undecided.
  if (hasYes === hasNo) return false
  // Exactly one verdict word appears in the whole response.
  return hasYes
}

export class ClaudeCliJudge implements JudgeModel {
  private readonly client: ILLMClient

  /** Defaults to a tool-free `ClaudeCliLLMClient` — no API key, shells out to `claude -p`. */
  constructor(client: ILLMClient = new ClaudeCliLLMClient()) {
    this.client = client
  }

  async judge(rubric: string, prompt: string, reply: string): Promise<boolean> {
    const messages: ChatMessage[] = [
      { role: 'system', content: JUDGE_SYSTEM_PROMPT },
      { role: 'user', content: buildJudgePrompt(rubric, prompt, reply) },
    ]
    try {
      const res = await this.client.callChatStructured(messages, undefined, { temperature: 0 })
      return parseYesNo(res.content)
    } catch {
      return false
    }
  }
}
