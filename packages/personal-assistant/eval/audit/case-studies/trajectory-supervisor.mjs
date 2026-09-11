/**
 * Case-study prose for the trajectory-supervisor transcript page — migrated here from
 * harness-evaluation.html's shared summary page (which special-cased this one feature with a
 * full narrative while the other 5 only got a table row). See harness-vs-bare.mjs for why this
 * lives in the source repo rather than the generated output.
 *
 * `history` covers three real rounds, in order: RUN 1 (2026-09-06, neutral — inert by
 * construction), the fix that made the supervisor able to actually act, RUN 2 (2026-09-07,
 * negative — the regression that took HARNESS_TRAJECTORY_SUPERVISOR off by default), and RUN 3
 * (the later corpus-expanded re-run, once a supervisor_conversation slice existed that could
 * actually exercise its ASK_USER directive across a follow-up turn). RUN 3's numbers are the ones
 * behind this page's own "N-seed numbers" table above — keep them in sync with
 * eval/reports/audit/trajectory-supervisor/trajectory-supervisor.multiseed.json if that report is
 * ever re-run.
 */
export default {
  mechanism: `<p>A slow-loop meta-controller that wakes up only when the run has measurably
  stopped making progress. It reads a digest of the failure trajectory and returns one directive —
  redirect the strategy, reframe the plan, spawn a bounded read-only investigation, ask the user a
  targeted question, or abort. Between those moments it stays out of the way: the main agent keeps
  every tactical decision.</p>`,

  hypothesis: `<p>In August 2026 NVIDIA published
  <a href="https://developer.nvidia.com/blog/nvidia-avo-reaches-100-on-arc-agi-3-demonstrating-a-frontier-level-general-purpose-architecture-for-long-horizon-autonomous-agents/">AVO</a>,
  an agent architecture that scored a perfect 100.00 across all 25 ARC-AGI-3 environments and ran a
  seven-day GPU-kernel optimisation that beat cuDNN and FlashAttention-4. Their writeup credits two
  components for sustaining that kind of long-horizon autonomy: a <strong>supervisor</strong> that
  "monitors the broader trajectory for stagnation or repeated unproductive cycles and can redirect
  the main agent toward alternative strategies," and a <strong>persistent trajectory memory</strong>
  that lets the agent "resume from the current state rather than repeatedly reconstructing the
  search."</p>
  <p>That shape mapped almost one-to-one onto our own recovery path — except ours was a blind
  ladder: on a stall it just advanced to the next strategy archetype without reading <em>why</em>
  it was stuck. Making that branch intelligent looked like free upside.</p>
  <p>One caveat we wrote down before starting: AVO's report contains <strong>no controlled
  ablation</strong> of the supervisor — the authors say plainly that their experiment "does not
  isolate its individual contribution." A perfect score on a seven-day task is a strong signal for
  the architecture as a whole, not evidence that this one part carries its weight. Which is exactly
  what our benchmark is for. The bet: a stalled run recovers more often, or more cheaply, with a
  targeted directive than by blindly advancing to the next strategy archetype in a fixed
  ladder.</p>`,

  testDesign: `<p>The arm is the assistant with the supervisor flag on versus off — nothing else
  changes. The original stress corpus was six lookup and pivot tasks that inject a persistent tool
  failure, so the run is forced to the stall edge where the supervisor is actually consulted
  (later expanded — see the timeline below). Everything is graded mechanically and re-run across
  three independent seeds with an LLM judge on.</p>`,

  history: `<h3>RUN 1 &middot; 2026-09-06 — neutral, and inert by construction</h3>
  <p>Task success moved +2.8% (CI &plusmn;10.9%) — noise. Worse, the supervisor <em>couldn't</em>
  have helped: its two commonest directives can't re-queue a single-node task graph, so on a
  one-shot assistant turn there was nothing for them to act on. The measurement apparatus, not the
  idea, was the blocker.</p>

  <h3>Fix &middot; 2026-09-07 — made it genuinely able to act</h3>
  <p>Four changes: the recovery path now re-queues a failed leaf task after a redirect or an
  investigation; the investigation sub-agent can now read workspace files (it was limited to web
  search); its findings are spliced into the model's context; and the failure-injection harness
  allows a real second attempt over the new evidence. Now the supervisor runs a full recovery
  cycle on every stall.</p>

  <h3>RUN 2 &middot; 2026-09-07 — negative</h3>
  <p>With the supervisor able to act: task success 72.2% &rarr; 68.5% (&Delta; &minus;3.7%, CI
  &plusmn;3.6% — just outside the band). Latency +34%, cost +32%, tokens +48%, all far outside
  their intervals. And <strong>zero</strong> additional stalls recovered — the assistant already
  recovers one of the six on its own, and routing that recovery through the supervisor's extra
  model call converts none.</p>
  <table class="cmp-table"><thead><tr><th>Metric</th><th>&Delta; (RUN 2)</th></tr></thead><tbody>
  <tr><td>Task success</td><td class="num">&minus;3.7%</td></tr>
  <tr class="regressed"><td>Stall recoveries</td><td class="num">0 extra</td></tr>
  <tr class="regressed"><td>Mean latency</td><td class="num">+34%</td></tr>
  <tr class="regressed"><td>Mean cost</td><td class="num">+32%</td></tr>
  <tr class="regressed"><td>Tokens per turn</td><td class="num">+48%</td></tr>
  </tbody></table>
  <p class="model-line">Per-seed task success — off: 72.2 / 72.2 / 72.2; on: 72.2 / 66.7 / 66.7. No
  change in hallucination or unauthorized actions on either arm.</p>

  <h3>RUN 3 &middot; corpus expanded — re-run</h3>
  <p>The 6 lookup/pivot -stall tasks were joined by a new <code>supervisor_conversation</code>
  slice (6 tasks, 2 turns) — turn 1 stalls, the supervisor asks the user a targeted question, turn
  2 the user answers and the run should recover — a shape the original 12-task slice couldn't
  exercise (<code>ASK_USER</code> just ends a turn with no follow-up). Re-run across all 18 tasks,
  3 seeds: task success 64.8% &rarr; 66.7% (a small, unproven gain — CI &plusmn;3.6pt), cost
  +22%/turn, latency +40%. Even with a task shape built for the supervisor's most distinctive
  move, it still didn't clear its cost — this is the run behind the numbers table above.</p>`,

  findings: `<p>The idea didn't transfer. AVO's supervisor earns its keep across a seven-day search
  with thousands of actions and long plateaus to detect. An assistant turn resolves in one or two
  iterations — there is almost nothing for a stagnation monitor to monitor, and when a stall
  <em>is</em> forced, the deterministic recovery already handles the one case in six that's
  recoverable at all. Adding a model call on top of that bought nothing and cost a third more per
  turn — and it didn't change even after giving the supervisor's most distinctive move, asking the
  user, a task shape where it could actually pay off. <code>HARNESS_TRAJECTORY_SUPERVISOR</code>
  stays off by default; the code stays merged and flag-gated. One open question remains — a
  decomposed, multi-step planning path, closer to AVO's own setting, where a redirect or a
  re-framed plan has downstream tasks to affect — and that needs its own benchmark slice before
  the idea is closed for good.</p>`,
}
