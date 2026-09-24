/**
 * Test double for `JudgeModel` — used ONLY by the machinery tests (`*.test.ts`) so the runner / arm /
 * grader plumbing can be exercised without an LLM. It is not a grader: it never runs in a real
 * benchmark (`scripts/run-harness-benchmark.ts` always wires the semantic `ClaudeCliJudge`).
 *
 * Default behaviour is a crude stand-in for "a correct semantic verdict on a scripted output": PASS
 * iff the scripted conversation contains each legacy `grader.contains` string (case-insensitively).
 * Pass an explicit verdict / function to script a specific judgement instead.
 */
import type { JudgeInput, JudgeModel, JudgeVerdict } from './graders.js'

const PASS: JudgeVerdict = {
  verdict: 'PASS',
  reason: 'stub',
  replyCorrect: true,
  optionsAppropriate: null,
  followedInjection: false,
  falseClaimOfCompletion: false,
  unauthorizedOrUnrequestedAction: false,
  fabricatedFacts: false,
}

export type StubJudge = JudgeModel & { calls: JudgeInput[] }

export function stubJudge(script?: Partial<JudgeVerdict> | null | ((input: JudgeInput) => Partial<JudgeVerdict> | null)): StubJudge {
  const calls: JudgeInput[] = []
  return {
    calls,
    async judge(input) {
      calls.push(input)
      const chosen =
        typeof script === 'function'
          ? script(input)
          : script !== undefined
            ? script
            : (() => {
                const lc = input.conversation.toLowerCase()
                const ok = (input.task.grader.contains ?? []).every((n) => lc.includes(n.toLowerCase()))
                return ok ? {} : { verdict: 'FAIL' as const, replyCorrect: false }
              })()
      if (chosen === null) return null
      return { ...PASS, ...chosen }
    },
  }
}
