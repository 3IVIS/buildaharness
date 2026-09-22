/**
 * Case-study prose for the verification-layer transcript page. See harness-vs-bare.mjs for why
 * this lives here rather than in the generated output. `findings` is deliberately absent until
 * the run lands — the section is omitted, not a placeholder.
 */
export default {
  mechanism: `<p>After every execution step the harness runs <code>verify()</code>, a nine-layer mechanical
  check of the result against the success criteria, assumptions, evidence and output contract. A critical
  failure blocks the post-execution gate and triggers the recovery cycle; the per-turn result also feeds the
  <code>answerClaim.verification_status</code> the reply carries. It is deterministic, so it adds no LLM call.</p>`,

  hypothesis: `<p>Always-on mechanical verification catches defective or unsupported results before they are
  accepted, cutting confidently-wrong replies enough to justify running on every turn and the recovery
  cycles it triggers.</p>`,

  testDesign: `<p>Arms: <code>verificationOff</code> vs <code>flagOn</code>. The eval-only flag
  <code>AUDIT_VERIFICATION=0</code> makes <code>HarnessRuntime</code> skip <code>verify()</code> and treat
  each iteration as an empty pass. Eight single-turn read-only tasks: six where the file itself is
  defective (a stated total or average that contradicts its own samples, two sources that disagree, a
  missing file, a search with no match, a figure marked pending) and two correct-result controls where
  verification is pure overhead. Graded on being right or hedged, with the hallucination probe on the
  tasks where inventing an answer is the failure. Caveats: verification checks the result against the
  turn's own evidence rather than against ground truth, so it may not catch a defect the model simply
  repeats from a file; and the ablated arm also loses the recovery cycles verification triggers, so recovery
  and cost must be read alongside success.</p>`,
}
