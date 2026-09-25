/**
 * Case-study prose for the probe-model-inferred-facts probe page (AL1c of plans/adaptive_layer_selection_plan.html).
 * `findings` is deliberately absent: this cell is queued, not run — the section is omitted, not a placeholder.
 */
export default {
  mechanism: `<p>The classifier's <code>statesDurableFacts</code> path records facts it infers from wording the lexical pass misses, gated by confidence before promotion to durable memory.</p>`,

  hypothesis: `<p>A probe, not a verdict run: it certifies that the corpus separates the arms — the fact is implied early and needed later — and that hypothetical, retracted and third-party statements are not remembered as the user's own.</p>`,

  testDesign: `<p>Arms: <code>modelInferredFactsOff</code> vs <code>flagOn</code>, 1 seed. Twelve stress tasks in three families (household, work-status, sensory-limits) and six calm controls. The raw transcript stays in context for both arms, so headroom is the open question.</p>`,
}
