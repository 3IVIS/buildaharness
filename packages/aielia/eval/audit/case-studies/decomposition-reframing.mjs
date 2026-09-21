/**
 * Case-study prose for the decomposition-reframing transcript page. See harness-vs-bare.mjs for
 * why this lives here rather than in the generated output. `findings` is deliberately absent until
 * the run lands — the section is omitted, not a placeholder.
 */
export default {
  mechanism: `<p>Every turn, the intent classifier may return <code>decomposedTasks</code>: an ordered task
  graph for a request that names several distinct parts, each description leading with its subject. The
  harness then runs one task per graph node. When the request is a single task, a separate
  <code>reframeTaskDescriptionWithLLM</code> call may rewrite that one description to lead with its
  subject, but only for a non-low-risk, coding-fact-shaped message. Both shape the task graph the
  harness verifies; every task in a graph is executed against the same single draft reply.</p>`,

  hypothesis: `<p>Breaking a multi-part request into a task graph up front, and reframing tasks so they lead
  with their subject, completes more of the requested parts than treating the request as one task, at
  acceptable extra cost.</p>`,

  testDesign: `<p>Arms: <code>decompositionOff</code> vs <code>flagOn</code>. The flag makes the turn take the
  single-task path: the classifier's <code>decomposedTasks</code> is ignored and no reframe call is made.
  The classifier call itself is unchanged. Eight single-turn tasks over a fixture workspace: six ask for
  three to five distinct deliverables (values from one or several files, a computed summary, a five-part
  incident write-up), each graded individually so a dropped part is a measurable miss; two are single-part
  controls where decomposition is pure overhead, so any difference there is the cost and latency tax.
  Caveats: because every task executes against one draft reply, decomposition changes what is verified
  more than what is generated, so a null quality differential is plausible. The fixture tasks are
  read-only and low-risk, so they mostly exercise decomposition rather than the reframe call.</p>`,
}
