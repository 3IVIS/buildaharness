// Cross-runtime checkpoint conformance, TS side (driven by compare-checkpoint.mjs via `npx tsx`).
//   run-ts-checkpoint.mts pause  <pauseKind>          -> prints the checkpoint the TS runtime pauses at
//   run-ts-checkpoint.mts resume <checkpoint.json>    -> resumes it and prints a projection of the outcome
// pauseKind: "proposal" (before the first execute) | "iteration" (end of the first iteration).
import { readFileSync } from 'node:fs'
import { HarnessRuntime } from '../../packages/harness/src/harness-runtime.js'

const OBJECTIVE = 'cross-runtime checkpoint'
const CRITERIA = ['first criterion', 'second criterion']

const [mode, arg] = process.argv.slice(2)
const runtime = new HarnessRuntime()

function project(outcome: any) {
  if (outcome.status !== 'complete') return { status: outcome.status }
  const r = outcome.result
  return {
    status: 'complete',
    finalResult: r.finalResult,
    taskStatuses: r.initResult.taskGraph.tasks.map((t: any) => [t.id, t.status]),
    nodeExecutionOrderTail: r.nodeExecutionOrder.slice(-1),
  }
}

if (mode === 'pause') {
  const pauseKind = arg
  const outcome: any = await runtime.run(OBJECTIVE, CRITERIA, {
    runId: 'xrun-1',
    skipReviewerPass: true,
    shouldPause: (cp: any) =>
      pauseKind === 'proposal'
        ? cp.progress.pendingProposal?.kind === 'proposal'
        : !cp.progress.pendingProposal && cp.progress.stepsUsed === 1,
  })
  if (outcome.status !== 'paused') throw new Error('expected a paused outcome')
  process.stdout.write(JSON.stringify(outcome.checkpoint))
} else if (mode === 'resume') {
  const checkpoint = JSON.parse(readFileSync(arg, 'utf8'))
  const outcome = await runtime.resume(checkpoint, { skipReviewerPass: true })
  process.stdout.write(JSON.stringify(project(outcome)))
} else if (mode === 'baseline') {
  const outcome = await runtime.run(OBJECTIVE, CRITERIA, { runId: 'xrun-1', skipReviewerPass: true })
  process.stdout.write(JSON.stringify(project(outcome)))
}
