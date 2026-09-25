/**
 * Case-study prose for the probe-semantic-contradiction probe page (AL1c of plans/adaptive_layer_selection_plan.html).
 * `findings` is deliberately absent: this cell is queued, not run — the section is omitted, not a placeholder.
 */
export default {
  mechanism: `<p>The semantic contradiction check (<code>checkForContradictions</code>) compares newly stated beliefs against the held belief set with one LLM call, catching conflicts by meaning (paraphrase, unit or currency change, cross-language restatement, a value shifted across the belief trail) that the always-on lexical negation-pair check cannot see.</p>`,

  hypothesis: `<p>This is a probe, not a verdict run: it certifies that the corpus can show the layer's value at all — the layer engages on the stress tasks, the layer-off arm has headroom, and calm controls (a legitimate change over time) stay quiet.</p>`,

  testDesign: `<p>Arms: <code>contradictionOff</code> vs <code>flagOn</code>, 1 seed. Sixteen multi-turn stress tasks in four families (paraphrase, unit-currency, temporal-crosslang, belief-trail) and six calm controls that must not be flagged.</p>`,
}
