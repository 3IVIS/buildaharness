/**
 * Case-study prose for the semantic-criterion-coverage transcript page. See harness-vs-bare.mjs for
 * why this lives here rather than in the generated output. `findings` is deliberately absent until
 * the run lands — the section is omitted, not a placeholder.
 */
export default {
  mechanism: `<p>The reviewer pass's implementer lens checks each plan success criterion against the
  world model's beliefs with a plain substring match. <code>checkSemanticCriterionCoverage</code>
  adds one LLM call per criterion the substring check could not match, asking whether some belief
  establishes the criterion in different words &mdash; so a paraphrase is not reported as an
  uncovered gap.</p>`,

  hypothesis: `<p>Criteria and the beliefs that satisfy them are rarely worded alike, so the
  substring check raises false &ldquo;criterion not covered&rdquo; findings. The semantic call should
  remove those often enough to justify one extra call per unmatched criterion.</p>`,

  testDesign: `<p>Arms: <code>criterionCoverageOff</code> vs <code>flagOn</code>. An 8-task slice: six
  multi-step tasks whose prompt states &ldquo;Done when&rdquo; criteria that a correct reply meets in
  different words, and two controls where a criterion is genuinely unmet. One caveat matters for
  reading the result: the shipped assistant passes only a non-checkable default criterion to the
  harness run (plan criteria never reach this hook), so on the product path the call is skipped
  without an LLM request. The slice therefore measures whether the arm differs at all, not
  paraphrase recognition on real plan criteria.</p>`,
}
