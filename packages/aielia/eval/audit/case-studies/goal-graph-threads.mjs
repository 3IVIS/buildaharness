/**
 * Case-study prose for the goal-graph-threads transcript page. Runs: 3 seeds, claude-sonnet-5, LLM judge on.
 */
export default {
  mechanism: `<p>Each goal you work on becomes a thread in a persistent graph. A cross-turn matcher decides whether a new message continues an open thread or starts a new one, and one thread is kept in focus per turn, so evidence and constraints stay attached to the goal they belong to.</p>`,

  hypothesis: `<p>The bet is that when several goals interleave, thread tracking keeps the right facts and the right constraints on the right goal, in a way a flat conversation history does not. One caution we wrote down first: both arms keep the raw history, so plain recall is not expected to separate them. Any gain has to come from scoping and disambiguation.</p>`,

  testDesign: `<p>Eight multi-turn sessions with no mid-turn messages, so thread tracking is isolated from live steering. They cover returning to a goal after a detour, two similar goals that must not mix, a format constraint that belongs to one goal only, a constraint that must not leak into a new topic, a correction that has to survive a detour, three similar projects updated out of order over eight turns, three goals with alternating output formats, and a three-goal synthesis, plus one linear single-goal control. Graded mechanically on the final reply.</p>`,

  findings: `<p>No measurable difference, because this corpus could not separate the two arms. Both scored 100% on all eight sessions in all three seeds. Cost was 7% lower with the graph on, latency and tokens identical, all within noise.</p>
<p>That is a ceiling effect, not evidence that the graph does nothing. Both arms keep the raw conversation history, and at seven turns of a few lines each, plain history was enough to return to an earlier goal, keep three projects apart, hold a format constraint to the right topic, and apply a correction after a detour. Showing a benefit would need sessions where the history no longer fits or gets compacted, or goals whose evidence lives in long tool output. Until we have run those, the honest position is that the goal graph is not proven useful by this evidence.</p>`,
}
