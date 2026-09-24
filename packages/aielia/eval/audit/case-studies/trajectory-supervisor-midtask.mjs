/**
 * Case-study prose for the trajectory-supervisor-midtask transcript page. Runs: 3 seeds, claude-sonnet-5, LLM judge on.
 */
export default {
  mechanism: `<p>A slow-loop meta-controller that wakes up only when a run has stopped making progress. It reads a digest of the failure trajectory and returns one directive: redirect the strategy, reframe the plan, gather evidence, ask the user a targeted question, or stop. Between those moments it stays out of the way.</p>`,

  hypothesis: `<p>Our earlier single-turn run of this feature came out negative, but that corpus stalled on turn one with no context behind it. The bet here is narrower: when a stall hits late in a multi-turn task, after the assistant has already done useful work, a targeted directive recovers runs that would otherwise fail, and costs almost nothing on tasks that never stall.</p>`,

  testDesign: `<p>Eight multi-turn tasks. Six have a persistent tool failure injected on a later turn (a pointer chain to follow, a file that only points elsewhere, a nested lookup, a stale newer-file override, a transitive import, and one where the user has to supply a missing detail on the following turn). Two are clean controls with no stall, where the supervisor should never fire. The control arm is the same assistant with the supervisor switched off.</p>`,

  findings: `<p>With a stall injected late in a multi-turn task, the supervisor recovered runs that otherwise failed. Task success rose from 37.5% to 62.5% (+25 points; all three seeds gave the same outcomes, so the interval is zero). Two of the six stalled tasks were recovered only with the supervisor on: the one where a newer file overrides the obvious answer, and the one where the named file only points elsewhere. The task where the user supplies the missing detail on the next turn was recovered by both arms. Three tasks were recovered by neither: the pointer chain, the nested lookup and the transitive import, where the injected failure lasted two or three iterations.</p>
<p>The price is real. Cost per task rose 43% ($0.0094 to $0.0134), latency 33% (13.5 s to 17.8 s) and tokens 41%. On the two clean controls the supervisor was never consulted and both arms scored 100%.</p>
<p>Two caveats. The stalls are simulated: a persistent tool failure is injected for a fixed number of iterations, so this measures recovery from that kind of stall, not stalls that occur on their own. And an earlier single-turn run of this feature came out negative (about +2 points at +22% cost), so the result depends on the task shape: it helped where a stall arrived after work was already under way and a redirect had something to act on.</p>`,
}
