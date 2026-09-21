/**
 * Case-study prose for the model-inferred-facts transcript page. See harness-vs-bare.mjs for
 * why this lives here rather than in the generated output. `findings` is deliberately absent until
 * the run lands — the section is omitted, not a placeholder.
 */
export default {
  mechanism: `<p>Every turn, the intent classifier also returns <code>statesDurableFacts</code>: a free-form
  read of facts the message states or implies about the user. These are recorded with source
  <code>model_inferred</code> and gated by confidence: <code>high</code> and durable is promoted to
  durable memory, <code>medium</code> is queued for <code>/memory confirm</code>, and <code>low</code>
  stays session-scoped, rendered with an &ldquo;(unconfirmed)&rdquo; suffix. The lexical pass
  (<code>user_asserted</code>) only catches facts phrased in a handful of fixed shapes, so a fact that is
  implied rather than stated reaches memory only through this path.</p>`,

  hypothesis: `<p>Facts the classifier infers should be recalled correctly on later turns often enough to
  justify recording them, without a wrong-memory tax from hypotheticals and retracted statements.</p>`,

  testDesign: `<p>Arms: <code>modelInferredFactsOff</code> vs <code>flagOn</code>. The flag drops the
  classifier's facts where they are merged into the turn's fact list; the classifier call itself and the
  lexical pass are unchanged. Eight three-turn tasks: six where turn 1 only implies a fact (a wheelchair,
  a dog, pharmacology finals, night shifts, vegetarianism, left-handedness) in wording the lexical pass
  does not catch, turn 2 is unrelated, and turn 3 is a choice that turns on the fact; and two controls
  where the implication is a hypothetical or is retracted, graded on the reply not treating it as true.
  Caveats: the corpus is within-session only, and the raw transcript is still in context on turn 3, so a
  null result can mean the transcript already carried the fact rather than that model-inferred facts add
  nothing. Cross-session persistence and the <code>/memory confirm</code> queue are not exercised.</p>`,
}
