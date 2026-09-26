/**
 * Case-study prose for the adaptive-vs-alwayson-probes-a cell (part 1/2 of the AL1 probe slices, split from the original single cell) (AL11a of plans/adaptive_layer_selection_plan.html).
 * `findings` is deliberately absent: this cell is queued, not run — the section is omitted, not a placeholder.
 */
export default {
  mechanism: `<p>Adaptive policy vs always-on (AL1 probe slices, part 1/2). See the plan's AL11a/AL11b phases.</p>`,

  hypothesis: `<p>layerPolicyMode=adaptive (AL10 v1 rules) is measured against flagOn: the D2 bar vs always-on: success non-inferior (lower CI >= -3pt) and cost >= 25% lower, with no per-category regression (notably ambiguity and injection). Rules encode hypothesised regimes; AL11b applies the bar.</p>`,

  testDesign: `<p>Arms: <code>flagOn</code> vs <code>adaptivePolicy</code>, 5 seeds, judge claude-opus-5-5, transcripts on. AL1c-AL1e probe slices, part 1/2 (stress plus calm controls); 5 seeds, judge claude-opus-5-5, transcripts on. Slices without a passing AL1f certificate are reported UNTESTED by AL11b, not scored.</p>`,
}
