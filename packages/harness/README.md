# @buildaharness/harness

TypeScript implementation of the 11-layer harness — World Model, Evidence,
Hypothesis, Contradiction, Diagnostics, Control State, Planning, Execution,
Verification, Recovery, Reviewer Pass — a governance and reliability control
plane around an autonomous agent: the agent proposes, the harness decides
what's allowed to happen next, evidence decides whether the result is
accepted (see ADR-003, harness consolidation, for the 5-primitive
model every layer here implements). Its pure-data constants (thresholds, the
recovery-dependency table, `LAYER_TIER`) are generated from one shared source
with the Python harness (`adapter/harness/`) rather than hand-copied
field-for-field — see "Relationship to the Python harness" below. Since the
HarnessRuntime rewrite it's also a real, resumable execution engine, not just
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

## Suspend point: propose → gate → execute

`driveMainLoop` has a second, earlier pause point in addition to the
end-of-iteration checkpoint above: it yields immediately after
`action_gate` produces a decision (`PASS` / `BLOCK` / `ESCALATE`) but
*before* `execute()` runs, stashing the proposal as `ctx.pendingProposal`
(`{ taskId, gateResult, shouldGatherEvidence }`) on the checkpoint's
`HarnessRunProgressData`. This lets a caller inject a real approval step —
"the LLM proposed this action, a human/policy layer needs to approve it" —
between the harness deciding what it wants to do and actually doing it,
instead of only being able to observe an action after it already ran.

A `shouldPause` callback that wants to stop here specifically (rather than
at the default post-execution checkpoint) can key off the last pushed node
being `'action_gate'`. Nothing stops on this point by default — supplying
no `shouldPause` reproduces the pre-existing end-to-end run behavior
unchanged. On resume, if `ctx.pendingProposal` is present, `driveMainLoop`
re-derives the same task/decision from the stored data instead of
re-running task selection, risk estimation, and VOI evaluation a second
time (which would double-count `stepsUsed` and re-mutate diagnostics).

**Known scope boundary:** resuming after a real process restart (not just
an in-memory pause) loses `select_task`'s opportunistic concurrent-task
parallel-execution candidate — the resumed task executes serially. A
same-process pause/resume never hits this, since the concurrent-task
candidate only exists within the run that already selected it.

This suspend-point *contract* — propose, gate, then execute, with the
option to pause between the two — is shared conceptually with Python's
`loop.py` (both implement the same five-tier `resolve_control_state()` /
`resolveControlState()` decision before any execution happens), but as of
this writing the contract is not yet cross-referenced from `loop.py`'s own
docs/ADR, and Python's loop has no equivalent mid-iteration yield — it is
synchronous, not a resumable generator. Treat this section as the
TypeScript-side suspend point specifically, not a claim of a mirrored
Python suspend point.

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

**Shared semantic core.** The pure-data constants both languages' resolvers
read — `CRITICAL_THRESHOLD`/`CAUTION_THRESHOLD`, the recovery-dependency
tables, `LAYER_TIER` — are generated from one file, `spec/harness-core.json`,
by `spec/gen-harness-core.mjs`, into `adapter/harness/_core_generated.py` and
this package's `src/_core-generated.ts`. Neither generated file is
hand-edited (each is stamped "DO NOT EDIT" at the top); CI fails if either is
stale relative to the source. The `~150`-line resolver *algorithm*
(`resolve-control-state.ts` here, `control_state.py` in Python) is still
hand-mirrored, not generated — the conformance run
(`scripts/harness-conformance/`, 53 resolver fixtures + committed goldens)
found the two implementations already byte-identical, so generating the
algorithm too would solve a problem that doesn't exist. That fixture suite is
the actual equivalence contract, run against both interpreters on every PR; it
replaced an earlier field-by-field sync-checking script. See ADR-004 (shared
semantic core).

**Verification's validator-list model.** `verify.ts` (mirroring Python's
`verification.py`) is a typed list of validators, each classified into one of
three epistemic tiers via the shared `LAYER_TIER` map — `mechanical` (a real
subprocess-backed check, e.g. syntax/unit tests), `environmental` (a real
state inspection, e.g. consistency), or `model` (an LLM judgment). A `model`
tier result is never counted as independent confirmation of a `mechanical`
one — `VerificationResult.critical_failure_tiers` names which tiers
contributed a FAIL, and a structural check enforces it's non-empty if and
only if `has_critical_failure` is true. `verify()` has its own TS/Python
conformance pair (`compare-verify.mjs`, 25 fixtures) comparing the per-layer
status projection; it surfaced that `output_contract_partial` inspects
different contract fields on each runtime (TS `required_sections` vs Python
`required_interface_fields`), now a tracked discrepancy rather than an
invisible one.

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
