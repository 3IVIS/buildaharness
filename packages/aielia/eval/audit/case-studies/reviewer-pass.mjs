/**
 * Case-study prose for the reviewer-pass transcript page. See harness-vs-bare.mjs for why this
 * lives here rather than in the generated output. `findings` is deliberately absent until the
 * run lands — the section is omitted, not a placeholder.
 */
export default {
  mechanism: `<p>After the main loop finishes, the harness runs a 3-lens self-review over the turn: an
  implementer lens checks the draft against the stated success criteria, a reviewer lens checks it against
  the world model's held beliefs and open contradictions, and an adversarial lens (run only on a
  non-LOW-risk or multi-task turn) does a bounded BFS over beliefs looking for a challenge the draft didn't
  account for. A HIGH/MEDIUM finding can reopen a task and trigger a second, bounded review pass
  (<code>reviewer_pass_2</code>). The semantic criterion-coverage call (C1) and the semantic change-reviewer
  call (C2) are sub-mechanisms invoked from inside this pass.</p>`,

  hypothesis: `<p>The 3-lens reviewer pass finds real defects the earlier layers missed and improves the
  final reply often enough to justify its per-turn latency and the second review round it can trigger.</p>`,

  testDesign: `<p>Arms: <code>reviewerPassOff</code> vs <code>flagOn</code>. The eval-only flag
  <code>AUDIT_REVIEWER_PASS=0</code> makes <code>HarnessRuntime</code> skip <code>reviewerPass()</code> (and
  any <code>reviewer_pass_2</code> re-run) entirely — this also disables C1/C2's marginal LLM calls, since
  they live inside this pass, so this entry prices the whole pass and C1/C2 price their marginal cost on top
  of it. Eight single-turn, workspace-backed tasks: two per lens (two sources that disagree for the
  consistency/reviewer lens, a request answered at the wrong abstraction level for the stated goal, and an
  embedded adversarial instruction the draft could accept uncritically), plus two clean-draft controls where
  the review pass is pure overhead. Graded on the final reply being correct rather than carrying the defect
  (or, for the controls, on whether review adds a needless second round).</p>`,
}
