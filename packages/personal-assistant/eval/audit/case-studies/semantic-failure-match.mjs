/**
 * Case-study prose for the semantic-failure-match transcript page. See harness-vs-bare.mjs for
 * why this lives here rather than in the generated output.
 */
export default {
  mechanism: `<p><code>FailureModeLibrary.match()</code> looks for an exact-string match against a
  library of known failure patterns. <code>checkSemanticFailureMatch</code> adds an LLM call
  whenever that lexical match returns nothing, to recognize a known failure mode described in
  different words and route to the right recovery strategy.</p>`,

  hypothesis: `<p>Real tool failures get described in enough different phrasings that the
  exact-match library alone misses genuine matches often enough that the per-miss LLM call earns
  its cost and improves recovery routing.</p>`,

  testDesign: `<p>Arms: <code>failureMatchOff</code> vs <code>flagOn</code>. An 8-task slice with
  an injected failure symptom worded differently from the library's exact strings, isolating the
  classifier itself; whether better classification improves recovery is measured as a compressed
  proxy (a bounded re-answer loop), not full multi-turn recovery. 3 seeds, LLM judge on.</p>`,

  findings: `<p>Task success moved 25.0% &rarr; 37.5%, a 12.5-point gap — but the confidence
  interval is &plusmn;28 points on an 8-task slice, so the gap isn't distinguishable from noise.
  Cost rose 48% per turn and latency 15%. As with harness-vs-bare, the direction is positive but
  unproven, and the proven part is that it costs more.</p>`,
}
