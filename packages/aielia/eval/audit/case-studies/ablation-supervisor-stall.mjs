/**
 * Case-study prose for the ablation-supervisor-stall cell (AL11a of plans/adaptive_layer_selection_plan.html).
 * `findings` is deliberately absent: this cell is queued, not run — the section is omitted, not a placeholder.
 */
export default {
  mechanism: `<p>Ablation (AL11a): supervisor re-measure on the rebuilt stall slices. See the plan's AL11a/AL11b phases.</p>`,

  hypothesis: `<p>F7 re-measure: the trajectory supervisor's advantage on stalled work (previously graded lexically, no transcripts) reproduces with a semantic judge, transcripts and 5 seeds on a freshly rebuilt harness dist.</p>`,

  testDesign: `<p>Arms: <code>supervisorOff</code> vs <code>flagOn</code>, 5 seeds, judge claude-opus-5-5, transcripts on. Existing stall slices (single-turn pivot/lookup, ASK_USER conversation, mid-task stall). Rebuild packages/harness/dist before running and record the commit in the report header.</p>`,
}
