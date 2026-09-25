/**
 * Case-study prose for the adaptive-vs-alwayson smoke cell (AL10 of plans/adaptive_layer_selection_plan.html).
 * `findings` is deliberately absent: this cell is queued, not run — the section is omitted, not a placeholder.
 */
export default {
  mechanism: `<p>The adaptive layer policy (<code>layerPolicyMode=adaptive</code>) with the AL10 v1 trigger rules in <code>packages/harness/src/layer-policy-rules.ts</code>: each escalation layer is skipped or escalated per turn from non-linguistic signals.</p>`,

  hypothesis: `<p>Adaptive selection keeps task success non-inferior to the always-on control while running fewer escalation LLM calls on routine turns. The rules encode hypothesised regimes; no layer has a certified result yet.</p>`,

  testDesign: `<p>Arms: <code>flagOn</code> (always-on control) vs <code>adaptivePolicy</code>, 1 seed, on one probe slice. A smoke cell for the new arm; AL11a registers the full matrix.</p>`,
}
