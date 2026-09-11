/**
 * Case-study prose for the semantic-contradiction transcript page. See harness-vs-bare.mjs for
 * why this lives here rather than in the generated output.
 */
export default {
  mechanism: `<p>An always-on lexical pass catches contradictions that are simple negation pairs
  ("X is true" vs "X is not true"). <code>checkForContradictions</code> adds one LLM call on top
  of that, run whenever the belief set grows, to catch contradictions that are paraphrased or
  reframed rather than a literal negation.</p>`,

  hypothesis: `<p>Real conversations restate beliefs in different words often enough that the
  lexical-only check misses genuine contradictions — enough that the extra per-belief-set-growth
  LLM call pays for itself.</p>`,

  testDesign: `<p>Arms: <code>contradictionOff</code> vs <code>flagOn</code>. A 14-task slice built
  specifically for this: a belief stated one turn, unrelated beliefs in between, then a paraphrased
  or cross-framed contradiction on a later turn — plus control tasks (a legitimate change over
  time) that must not be false-flagged. 3 seeds, LLM judge on.</p>`,

  findings: `<p>Task success went 85.7% &rarr; 92.9%, a 7.1-point gain whose confidence interval
  clears zero — the one result in this audit that's proven, not just suggested. Cost went up 29%
  per turn with latency flat. The gain is real and it clears the cost: this is the one feature
  kept on by default so far.</p>`,
}
