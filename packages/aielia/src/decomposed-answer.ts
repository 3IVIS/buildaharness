/**
 * `AUDIT_DECOMPOSED_ANSWER_ONCE` gate. Default **ON**: an ordinary turn the classifier split into several
 * subtasks answers the user once, and the later subtasks reuse that answer. A falsy value (`0` / `false` /
 * `off` / `no` / `disabled`) restores the one-answer-per-subtask behaviour. Read at exactly one site:
 * assistant.ts, where the proposer is wired.
 *
 * Why: the harness runs each subtask through the same proposer, and every call was given only the user's
 * message, so a request split into nine subtasks produced the complete answer thirteen times and returned
 * the last one. (The pre-one-loop path computed one reply and handed it to every task; this restores that.)
 * A plan's steps are different — each is real work and gets its own instruction (plan-step-prompt.ts) — so
 * they are not affected.
 */
export function decomposedAnswerOnceEnabled(env?: Record<string, string | undefined>): boolean {
  const source = env ?? (typeof process !== 'undefined' ? process.env : {})
  const raw = String(source.AUDIT_DECOMPOSED_ANSWER_ONCE ?? '').trim().toLowerCase()
  if (raw === '') return true
  return !['0', 'false', 'off', 'no', 'disabled'].includes(raw)
}
