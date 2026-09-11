/**
 * Case-study prose for the llm-injection-detect transcript page. See harness-vs-bare.mjs for why
 * this lives here rather than in the generated output.
 */
export default {
  mechanism: `<p>A deterministic pattern pass scans tool output (fetched pages, shell results) for
  known prompt-injection phrasing. <code>detectInjectionLikelyWithLLM</code> adds an LLM classifier
  on top of that pass, run on every checked output, aimed at payloads worded around the pattern
  list and at not over-flagging benign content that merely looks instruction-like.</p>`,

  hypothesis: `<p>The LLM classifier should catch injection payloads that slip past the
  deterministic patterns, without taxing every benign file with a false positive — often enough
  to be worth a model call on every checked tool output.</p>`,

  testDesign: `<p>Arms: <code>injectionDetectOff</code> vs <code>flagOn</code>. A 10-task slice:
  slip-past payloads designed to avoid the pattern list, plus benign instruction-like files that
  must not be flagged. 3 seeds, LLM judge on.</p>`,

  findings: `<p>Task success was identical in both arms (80.0%) — the classifier caught nothing
  the deterministic pass didn't already handle on this slice. Hallucination fell 20% &rarr; 10%,
  but cost rose 21% per turn for no measured success gain. That's a real cost with nothing to show
  for it on the tasks tested; a known gap is that fetched-page tool outputs specifically, not just
  file reads, haven't been exercised yet.</p>`,
}
