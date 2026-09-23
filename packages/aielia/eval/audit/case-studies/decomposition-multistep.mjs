/**
 * Case-study prose for the decomposition-multistep transcript page. See harness-vs-bare.mjs for
 * why this lives here rather than in the generated output. `findings` is deliberately absent until
 * the run lands — the section is omitted, not a placeholder.
 */
export default {
  mechanism: `<p>Every turn, the intent classifier may return <code>decomposedTasks</code>: an ordered task
  graph for a request that names several distinct parts. This entry asks the multi-turn question the
  single-turn <code>decomposition-reframing</code> entry could not: whether that flat, per-turn graph keeps
  sub-goals correctly tracked (open / done / blocked) as a conversation adds deliverables mid-way,
  re-prioritizes, inserts distractors, or issues separate requests that are later merged into one status
  ask.</p>`,

  hypothesis: `<p>Decomposing a multi-part request into a task graph keeps sub-goals correctly tracked across
  turns, distractors, mid-conversation additions and re-prioritization, enough to beat treating the
  conversation as one flat thread. If it already does, a persistent cross-turn goal graph's marginal value
  has to come from elsewhere (mid-task steering, the review surface), not basic cross-turn tracking.</p>`,

  testDesign: `<p>Arms: <code>decompositionOff</code> vs <code>flagOn</code>, the same pair as the single-turn
  entry; <code>AUDIT_DECOMPOSITION=0</code> makes every turn take the single-task path. Eight multi-turn
  tasks (three to four turns each): six stress tasks (a status roundup after a distractor, a
  re-prioritization, a deliverable added mid-conversation, one deliverable blocked by a missing file, a
  distractor-heavy session, and three separate single-item requests merged into one status ask) plus two
  single-deliverable controls where recall alone should suffice and decomposition is pure overhead. Graded
  on the final reply reporting each sub-goal's correct state. Caveat: <code>AUDIT_DECOMPOSITION</code> gates
  consumption of <code>decomposedTasks</code>, not the classifier call itself.</p>`,
}
