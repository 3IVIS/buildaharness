/**
 * Case-study prose for the harness-vs-bare transcript page (Plan A-something / feature value
 * audit). Read by gen-transcript-pages.mjs and spliced into the generated index.html — this file
 * is hand-authored and lives in the source repo precisely so it survives a page regeneration
 * (the generator deletes and rebuilds the whole harness-evaluation/<feature>/ output directory on
 * every run). Keep prose here, not in the generated output.
 */
export default {
  mechanism: `<p>The 11-layer harness — a world model, evidence and contradiction tracking,
  control-state gating, up-front planning, a 9-layer verification pass, and a reviewer pass — runs
  on every turn, wrapping the same underlying model with staging, self-checks and recovery logic
  that a plain tool-calling loop skips entirely.</p>`,

  hypothesis: `<p>All that machinery should produce measurably better task outcomes than letting
  the model call tools directly with nothing in front of it — enough to justify running the whole
  subsystem, and the extra latency and tokens it costs, on every single turn.</p>`,

  testDesign: `<p>Arms: <code>bare</code> (a plain ReAct-style tool loop, no harness) vs
  <code>flagOn</code> (the full harness). 76-task corpus, 3 seeds, LLM judge on. A first pass was
  withdrawn: its injected-failure tasks fired only for the harness arm, not <code>bare</code>, so
  the harness was stress-tested while the control ran clean. This run drops those tasks and
  measures ordinary, non-failure task quality only — recovery-under-failure for the bare arm is a
  separate, still-open coverage gap.</p>`,

  findings: `<p>Every quality metric favored the harness — task success 67.6% &rarr; 83.8% (a
  16.2-point gap), hallucination 3.2% &rarr; 1.4%, unauthorized effects 3.7% &rarr; 0% — but none
  of it clears its confidence interval at 3 seeds; the noise is wider than the gap. What
  <em>is</em> proven: cost is 77% higher per turn and latency is 88% higher. So the honest read is
  narrower than either "it helps" or "it doesn't": this run can't yet prove the harness improves
  outcomes on ordinary, non-failure tasks, and it can prove the harness costs meaningfully more to
  run them.</p>`,
}
