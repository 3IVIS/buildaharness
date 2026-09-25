/**
 * Case-study prose for the probe-criterion-coverage probe page (AL1d of plans/adaptive_layer_selection_plan.html).
 * `findings` is deliberately absent: this cell is queued, not run — the section is omitted, not a placeholder.
 */
export default {
  mechanism: `<p>Probe for the <code>criterion_coverage</code> mechanism; see <code>docs/layer_mechanisms.md</code> for its hypothesised regime and target metric.</p>`,

  hypothesis: `<p>A probe, not a verdict run: it certifies engagement, headroom and breadth for the criterion_coverage layer before any adaptive policy relies on it.</p>`,

  testDesign: `<p>Arms: <code>criterionCoverageOff</code> vs <code>flagOn</code>, 1 seed. Twelve stress tasks in three scenario families and six calm controls.</p>`,
}
