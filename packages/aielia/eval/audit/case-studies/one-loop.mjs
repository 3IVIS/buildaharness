/**
 * Case-study prose for the one-loop transcript page. See harness-vs-bare.mjs for why this lives
 * here (source-controlled, survives page regeneration) rather than in the generated output.
 */
export default {
  mechanism: `<p>Under <code>ASSISTANT_ONE_LOOP</code>, the harness's own <code>driveMainLoop</code>
  calls the tool-calling machinery one iteration at a time, so the 11-layer harness genuinely
  drives each tool call as it happens. The pre-rewire path ran the tool loop to completion first
  and then ran the harness once afterward, purely as bookkeeping over an already-finished
  reply.</p>`,

  hypothesis: `<p>Driving tool calls in-loop, where the harness can act on each result as it
  arrives, should beat reviewing a reply after the fact — retroactively validating the
  2026-09-06 default flip to <code>ASSISTANT_ONE_LOOP=enabled</code>.</p>`,

  testDesign: `<p>Arms: <code>baseline</code> (post-hoc bookkeeping) vs <code>flagOn</code>
  (in-loop). Same 76-task corpus, 3 seeds, LLM judge on. Like harness-vs-bare, a first pass was
  withdrawn for the same reason — an injected-failure task fired for one arm and not the other —
  and this is the corrected re-run.</p>`,

  findings: `<p>Task success moved 81.0% &rarr; 81.5% — essentially flat, well inside the
  confidence interval. Cost actually came in 18% lower for the in-loop arm; latency was flat. So
  this run is genuinely inconclusive on quality: it doesn't prove the in-loop rewire changed task
  outcomes either way, though it didn't cost more to run it that way.</p>`,
}
