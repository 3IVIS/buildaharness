/**
 * Case-study prose for the probe-supervisor probe page (AL1e of plans/adaptive_layer_selection_plan.html).
 * `findings` is deliberately absent: this cell is queued, not run — the section is omitted, not a placeholder.
 */
export default {
  mechanism: `<p>Probe for the <code>verification</code> mechanism; see <code>docs/layer_mechanisms.md</code> for its hypothesised regime and target metric.</p>`,

  hypothesis: `<p>A probe, not a verdict run: it certifies engagement, headroom and breadth for the trajectory supervisor layer before any adaptive policy relies on it.</p>`,

  testDesign: `<p>Arms: <code>supervisorOff</code> vs <code>flagOn</code>, 1 seed. See the corpus note for the task families.</p>`,
}
