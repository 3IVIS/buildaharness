/**
 * Case-study prose for the ablation-failure-match cell (AL11a of plans/adaptive_layer_selection_plan.html).
 * `findings` is deliberately absent: this cell is queued, not run — the section is omitted, not a placeholder.
 */
export default {
  mechanism: `<p>Ablation (AL11a): failure match on its regime slice. See the plan's AL11a/AL11b phases.</p>`,

  hypothesis: `<p>ABLATION (AL11a): failure match changes the judged target metric on its AL1 stress slice(s) by more than it costs, and the effect concentrates in an identifiable regime of the per-turn TurnSignals (discovered in AL11b, not assumed). Scored only if the slice's AL1f certificate holds on this run; otherwise UNTESTED.</p>`,

  testDesign: `<p>Arms: <code>failureMatchOff</code> vs <code>flagOn</code>, 5 seeds, judge claude-opus-5-5, transcripts on. AL11a ablation over the AL1 probe slice(s) probe_failure_match (stress tasks plus calm controls), 5 seeds, judge claude-opus-5-5, transcripts on. Per-turn TurnSignals kept for regime discovery (AL11b). Read only after the AL11b certificate re-check.</p>`,
}
