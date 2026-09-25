/**
 * Case-study prose for the probe-change-review probe page (AL1c of plans/adaptive_layer_selection_plan.html).
 * `findings` is deliberately absent: this cell is queued, not run — the section is omitted, not a placeholder.
 */
export default {
  mechanism: `<p>After the mechanical review passes, <code>semanticChangeReviewer</code> makes one LLM call comparing a proposed change against held high-confidence beliefs, catching conflicts that share no wording with the constraint.</p>`,

  hypothesis: `<p>A probe, not a verdict run: it certifies engagement, headroom and breadth for the change-review layer before any adaptive policy relies on it.</p>`,

  testDesign: `<p>Arms: <code>changeReviewOff</code> vs <code>flagOn</code>, 1 seed. Twelve stress tasks (dietary, schedule, policy-budget; constraint on turn 1, conflicting change on turn 3) and six compatible-change calm controls.</p>`,
}
