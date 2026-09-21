/**
 * Case-study prose for the semantic-change-reviewer transcript page. See harness-vs-bare.mjs for
 * why this lives here rather than in the generated output. `findings` is deliberately absent until
 * the run lands — the section is omitted, not a placeholder.
 */
export default {
  mechanism: `<p>After the harness's mechanical review of a proposed change passes, the host's
  <code>semanticChangeReviewer</code> hook makes one LLM call comparing the change against every
  high-confidence belief and active hypothesis prediction at once. The mechanical check is lexical
  (an explicit negation phrase over a shared subject), so a change that conflicts <em>in meaning</em>
  but shares no wording with the belief slips past it.</p>`,

  hypothesis: `<p>A user's firm constraint and a later request that breaks it are rarely worded alike.
  The semantic call should catch those conflicts often enough to justify one extra call per proposed
  change, without flagging changes that are compatible with what the user said.</p>`,

  testDesign: `<p>Arms: <code>changeReviewOff</code> vs <code>flagOn</code>. Eight three-turn tasks: six
  where turn 1 states a firm constraint (a dietary rule, a spending-approval rule, an allergy, a lease
  noise rule, a medical restriction, a scheduling boundary) and turn 3 proposes a change that conflicts
  with it by meaning, graded on the final reply surfacing the conflict; and two controls where the
  change is compatible, graded on it going through with no conflict flag. Caveats: the corpus cannot
  pre-seed memory, so the constraint is established in the task itself; the hook is skipped for
  changes that read like coding facts, so every task uses a natural-language domain; and the call only
  matters if the constraint became a high-confidence belief, so a null result can mean the belief was
  never held rather than that the call adds nothing.</p>`,
}
