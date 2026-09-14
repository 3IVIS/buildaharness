// Loads an ask-question conformance fixture and runs its `op` through the TS
// harness's own ask-question / escalation primitives, printing a normalised JSON
// result on stdout. Invoked by compare-ask-question.mjs via `npx tsx
// run-ts-ask-question.mts <fixture.json>` — the companion to run_py_ask_question.py.
//
// Unlike the Python twin, `resolveAskMode`/`buildAskBlocker` here take an already-
// resolved `globalEnabled` boolean rather than reading an env var (packages/harness
// is framework-agnostic) — fixture.global_enabled is fed straight in rather than via
// process.env, but the three-tier INV-29 semantics are identical.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import type { AskAnswer, AskQuestion, AskResponse, EscalationReason } from '../../packages/harness/src/nodes/escalate.js'
import {
  batchQuestions,
  makeQuestionsBatch,
  refineDeferredBatch,
  validateAskAnswer,
  validateAskQuestion,
  validateAskResponse,
} from '../../packages/harness/src/nodes/escalate.js'
import { buildAskBlocker, resolveAskMode } from '../../packages/harness/src/ask-question.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const fixturePath = process.argv[2]
if (!fixturePath) {
  console.error('usage: tsx run-ts-ask-question.mts <fixture.json>')
  process.exit(2)
}

const fixture = JSON.parse(readFileSync(resolve(__dirname, fixturePath), 'utf-8'))

function run(op: string, fixture: Record<string, unknown>): Record<string, unknown> {
  switch (op) {
    case 'validate_ask_question': {
      try {
        validateAskQuestion(fixture.question as AskQuestion)
        return { threw: false }
      } catch {
        return { threw: true }
      }
    }
    case 'make_questions_batch': {
      try {
        const result = makeQuestionsBatch(fixture.questions as AskQuestion[])
        return { threw: false, count: result.length }
      } catch {
        return { threw: true }
      }
    }
    case 'validate_ask_answer': {
      try {
        validateAskAnswer(fixture.answer as AskAnswer)
        return { threw: false }
      } catch {
        return { threw: true }
      }
    }
    case 'validate_ask_response': {
      try {
        validateAskResponse(fixture.questions as AskQuestion[], fixture.response as AskResponse)
        return { threw: false }
      } catch {
        return { threw: true }
      }
    }
    case 'resolve_ask_mode': {
      const effective = resolveAskMode({
        globalEnabled: fixture.global_enabled as boolean,
        sessionAskMode: fixture.session_ask_mode as boolean | undefined,
        structured: (fixture.structured as boolean | undefined) ?? true,
      })
      return { effective }
    }
    case 'build_ask_blocker': {
      const blocker = buildAskBlocker((fixture.questions as AskQuestion[] | undefined) ?? [], {
        globalEnabled: fixture.global_enabled as boolean,
        sessionAskMode: fixture.session_ask_mode as boolean | undefined,
        structured: (fixture.structured as boolean | undefined) ?? true,
        reason: (fixture.reason as EscalationReason | undefined) ?? 'cannot_make_progress',
        missingInfo: (fixture.missing_info as string[] | undefined) ?? [],
        currentTaskSummary: (fixture.current_task_summary as string | undefined) ?? '',
      })
      const { escalated_at: _escalated_at, ...rest } = blocker
      return rest
    }
    case 'batch_questions': {
      const { batch, deferred } = batchQuestions(
        fixture.candidates as AskQuestion[],
        (fixture.cap as number | undefined) ?? 4,
      )
      return { batch: batch.map((q) => q.id), deferred: deferred.map((q) => q.id) }
    }
    case 'refine_deferred_batch': {
      const mootIds = new Set((fixture.moot_ids as string[] | undefined) ?? [])
      const result = refineDeferredBatch(
        fixture.deferred as AskQuestion[],
        (q) => mootIds.has(q.id),
        (fixture.cap as number | undefined) ?? 4,
      )
      return { result: result.map((q) => q.id) }
    }
    case 'surface_blocker_roundtrip': {
      const blocker = fixture.blocker as Record<string, unknown>
      const questions = (blocker.questions as AskQuestion[] | undefined) ?? undefined
      const out: Record<string, unknown> = {
        reason: blocker.reason,
        missing_info: blocker.missing_info,
        current_task_summary: blocker.current_task_summary,
      }
      if (blocker.question !== undefined) out.question = blocker.question
      if (blocker.options !== undefined) out.options = blocker.options
      if (questions !== undefined) out.questions = makeQuestionsBatch(questions)
      return out
    }
    default:
      throw new Error(`unknown op: ${op}`)
  }
}

console.log(JSON.stringify(run(fixture.op, fixture)))
