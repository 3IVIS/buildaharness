# @buildaharness/harness

TypeScript implementation of the 11-layer harness — World Model, Evidence,
Hypothesis, Contradiction, Diagnostics, Control State, Planning, Execution,
Verification, Recovery, Reviewer Pass. It mirrors the state shapes of the
Python harness (`adapter/harness/`) field-for-field, and — since the
HarnessRuntime rewrite — is also a real, resumable execution engine, not just
a set of types.

This package has **zero runtime/browser dependencies** (only `zod`). It runs
anywhere JS runs — browser, Node, edge — and knows nothing about storage;
persistence is left entirely to the caller (see `@buildaharness/runtime` for
IndexedDB/Dexie-backed implementations).

## Running a harness

```ts
import { HarnessRuntime } from '@buildaharness/harness'

const runtime = new HarnessRuntime()

const outcome = await runtime.run(
  'Fix the failing test',
  ['tests pass'],
  {
    initialTasks: [{
      id: 'fix-test',
      description: 'Fix the failing test',
      status: 'PENDING',
      risk_level: 'MEDIUM',
      depends_on: [],
      parallel_write_domains: [],
      abstraction_level: 1,
      assigned_strategy: null,
    }],
    max_steps: 20,
    toolExecutors: { default: () => runMyTool() },
  },
)

if (outcome.status === 'complete') {
  console.log(outcome.result.finalResult, outcome.result.stepsUsed)
}
```

A run either resolves `{ status: 'complete', result: HarnessRunResult }`, or
throws `EscalationHalt` when the control-state resolver halts for human input
(budget exhausted, cannot-make-progress, a review failure, etc.) — catch it
and inspect `err.blocker`.

## Pausing and resuming a run

`run()`/`resume()` are async and internally drive a generator that yields a
serializable `HarnessCheckpoint` after every main-loop iteration that makes
task progress. Use `onCheckpoint` to persist checkpoints as they happen, and
`shouldPause` to stop the run early instead of running to completion:

```ts
import { HarnessRuntime, type HarnessCheckpoint } from '@buildaharness/harness'

const runtime = new HarnessRuntime()
let lastCheckpoint: HarnessCheckpoint | undefined

const outcome = await runtime.run(objective, successCriteria, {
  initialTasks,
  runId: 'my-run-id',              // used to key persisted checkpoints; auto-generated if omitted
  onCheckpoint: (checkpoint) => { lastCheckpoint = checkpoint },
  shouldPause: (checkpoint) => checkpoint.progress.stepsUsed >= 3, // stop after 3 steps
})

if (outcome.status === 'paused') {
  // Persist outcome.checkpoint (it's plain JSON — JSON.stringify/parse round-trips it)
  // and continue it later, even in a different process:
  const resumed = await runtime.resume(outcome.checkpoint, {
    toolExecutors: { default: () => runMyTool() }, // live objects aren't serialized — re-supply them
  })
}
```

Live objects — `experienceStore`, `updateChannel`, `toolExecutors` — are never
part of a checkpoint. Re-supply them to `resume()`, the same way Python's
`state_store` expects a fresh `db_session_factory` after `load()`.

`saveHarnessCheckpoint`/`loadHarnessCheckpoint`/`deleteHarnessCheckpoint` persist
a checkpoint by `runId` against any object shaped like `{ get, set, delete }`
(a `CheckpointStore`) — `@buildaharness/runtime`'s `InMemoryAdapter` and
`IndexedDBAdapter` both satisfy this without any adapter code:

```ts
import { saveHarnessCheckpoint, loadHarnessCheckpoint } from '@buildaharness/harness'
import { IndexedDBAdapter } from '@buildaharness/runtime'

const store = new IndexedDBAdapter({ namespace: 'my-app-checkpoints' })
await saveHarnessCheckpoint(store, outcome.checkpoint)
const reloaded = await loadHarnessCheckpoint(store, 'my-run-id')
```

## Cross-run learning (ExperienceStore)

`ExperienceStore` (strategy weights, learned decompositions, verification
plans, recovery sequences) is a separate, fully synchronous interface — it's
called mid-loop by `HarnessRuntime`, so implementations can't do async I/O
inline. This package ships two:

- `InMemoryExperienceStore` — in-process, resets every run. The default.
- `UnavailableExperienceStore` — every method is a no-op; `available` is
  `false`. Used when no store is supplied — a run behaves identically to one
  with no learning layer at all.

For an implementation that survives a page reload, see `DexieExperienceStore`
in `@buildaharness/runtime`.

## Relationship to the Python harness (`adapter/harness/`)

State shapes are mirrored 1:1 (all 13 structures round-trip via
`toJSON()`/`fromJSON()`, matching Python's `to_dict()`/`from_dict()`). Storage
is not mirrored 1:1 by design — Python's `state_store.py` and
`experience_store.py` are Postgres-backed because the Python harness runs
server-side; this package stays storage-agnostic so it can run fully
client-side. The one thing that *is* now equivalent in capability (not
implementation) is pause/resume: Python gets it from an async graph runtime
with DB-backed checkpoints, this package gets it from the async-generator
`HarnessRuntime` described above.

## Package structure

| Path | Contents |
|---|---|
| `src/state/` | The 13 state structures (`WorldModel`, `TaskGraph`, `ControlState`, `Diagnostics`, `EvidenceStore`, `HypothesisSet`, `MemoryState`, `StrategyState`, `FailureDiagnostics`, `OutputContract`, `CallerState`, `ExperienceStore`) |
| `src/nodes/` | One file per harness node (`gather-evidence.ts`, `resolve-control-state.ts`, `execute.ts`, `verify.ts`, `reviewer-pass.ts`, etc.) |
| `src/harness-runtime.ts` | `HarnessRuntime` — the resumable main loop |
| `src/harness-checkpoint.ts` | `HarnessCheckpoint`/`CheckpointStore` types + save/load/delete helpers |
| `src/harness-run-state.ts` | `HarnessRunState` — serializes/deserializes all 13 structures together |
| `src/process-concept.ts`, `process-registry.ts` | Reusable task-graph seeding "process concepts" |

## Commands

```bash
npm run build --workspace=packages/harness
npm test --workspace=packages/harness
npm run typecheck --workspace=packages/harness
```
