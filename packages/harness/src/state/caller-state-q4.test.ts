import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

import { CallerState, describeAskAnswer } from './caller-state.js'
import type { AskQuestion, AskAnswer } from '../nodes/escalate.js'

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'dist') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (full.endsWith('.ts') && !full.endsWith('.test.ts')) out.push(full)
  }
  return out
}

// ─── Q4: answer shapes threaded into applyConstraintChangePropagation ──────────
// (via CallerState.updateConstraints's new `clarification_answers` handling)

const questions: AskQuestion[] = [
  { id: 'q1', question: 'Which environment?', options: [{ label: 'staging' }, { label: 'prod' }] },
  { id: 'q2', question: 'Any caveats?', options: [{ label: 'None' }, { label: 'Rate limit' }] },
  { id: 'q3', question: 'Anything else we should know?' },
]

const answers: AskAnswer[] = [
  { questionId: 'q1', kind: 'selected', selectedLabels: ['staging'] },
  { questionId: 'q2', kind: 'selected_with_edit', selectedLabels: ['Rate limit'], editText: 'only above 100rps' },
  { questionId: 'q3', kind: 'free_text', freeText: 'Ping me before deploying' },
]

describe('describeAskAnswer', () => {
  it('renders each kind distinctly — no flattening into one joined string', () => {
    const rendered = answers.map((a) => describeAskAnswer(questions.find((q) => q.id === a.questionId), a))
    expect(rendered[0]).toBe('Selected — Which environment?: staging')
    expect(rendered[1]).toBe('Selected with note — Any caveats?: Rate limit (note: only above 100rps)')
    expect(rendered[2]).toBe('Free-text answer — Anything else we should know?: Ping me before deploying')
    // Every rendering is distinct — none collapse into the same shape.
    expect(new Set(rendered).size).toBe(3)
  })

  it('falls back to the bare questionId when no question is supplied', () => {
    expect(describeAskAnswer(undefined, answers[0])).toBe('Selected — q1: staging')
  })
})

describe('no remaining code path flattens a populated `questions` batch answer into one joined string', () => {
  it('no ask-question-answer-consuming source file joins distinct answers/options with " / " the way the old single-question escalated-reason string did', () => {
    const roots = [join(import.meta.dirname, '..'), join(import.meta.dirname, '..', '..', '..', 'personal-assistant', 'src')]
    const offenders: string[] = []
    for (const root of roots) {
      for (const file of walk(root)) {
        if (file.endsWith('caller-state.ts') || file.endsWith('response-service.ts')) continue // legacy single-question join; out of scope, see Q4 note below
        const content = readFileSync(file, 'utf-8')
        if (/\$\{[^}]*\}\s*\(\$\{[^}]*\.join\(' \/ '\)\}\)/.test(content)) {
          offenders.push(file)
        }
      }
    }
    expect(offenders).toEqual([])
  })
})

describe('CallerState.updateConstraints — clarification_answers', () => {
  it('appends one distinguishable current_constraints entry per answer, preserving kind', () => {
    const callerState = new CallerState({ current_constraints: ['existing constraint'] })
    callerState.updateConstraints({ clarification_answers: answers, ask_questions: questions })

    expect(callerState.current_constraints).toEqual([
      'existing constraint',
      'Selected — Which environment?: staging',
      'Selected with note — Any caveats?: Rate limit (note: only above 100rps)',
      'Free-text answer — Anything else we should know?: Ping me before deploying',
    ])
    expect(callerState.constraints_changed).toBe(true)
  })

  it('still records the raw structured payload in clarification_history untouched (kind intact)', () => {
    const callerState = new CallerState()
    callerState.updateConstraints({ clarification_answers: answers, ask_questions: questions })
    const recorded = callerState.clarification_history[0].clarification_answers as AskAnswer[]
    expect(recorded.map((a) => a.kind)).toEqual(['selected', 'selected_with_edit', 'free_text'])
  })

  it('works without an ask_questions list, falling back to questionId labels', () => {
    const callerState = new CallerState()
    callerState.updateConstraints({ clarification_answers: [answers[2]] })
    expect(callerState.current_constraints).toEqual(['Free-text answer — q3: Ping me before deploying'])
  })

  it('a plain current_constraints replacement is untouched by this new branch (no clarification_answers key)', () => {
    const callerState = new CallerState({ current_constraints: ['old'] })
    callerState.updateConstraints({ current_constraints: ['new'] })
    expect(callerState.current_constraints).toEqual(['new'])
  })
})
