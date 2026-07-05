# @buildaharness/personal-assistant

A general-purpose, everyday-use chat assistant that runs on the full 11-layer
harness (`@buildaharness/harness`) every turn — light enough for "what's the
weather" and consequential enough to gate "send that email" behind approval.

## Design

Where a heavy autonomous agent decomposes an objective into a multi-task plan,
this assistant treats every chat message as **one objective, one task**. That
keeps `HarnessRuntime.run()` cheap per turn (no LLM calls inside the harness
loop itself — it's synchronous state-machine bookkeeping) while still walking
every layer: World Model, Evidence, Hypothesis, Control State, Planning
(trivial one-task graph), Execution, Verification, Recovery path, Memory
(context compression), Learning (`ExperienceStore`), and the Reviewer Pass +
output validation at the end.

Three things live *outside* a single harness run, deliberately:

- **Conversation history** — each turn's `WorldModel`/`TaskGraph`/etc. are
  scratch state for that turn only, the same way they are for any harness run.
  The transcript is kept in a `MemoryAdapter` (in-memory by default; swap in
  `IndexedDBAdapter` from `@buildaharness/runtime` for browser persistence) and
  fed to the LLM call directly.
- **Risk classification** — `risk-classifier.ts` is a cheap keyword heuristic
  that flags consequential requests (send/delete/pay/post/...) *before* the
  harness — and before the one real network call — ever runs. A `HIGH` risk
  turn returns `status: 'needs_approval'` with zero LLM calls spent; call
  `turn(message, { approved: true })` to proceed after the caller confirms.
- **Learning across turns** — `ExperienceStore` (strategy weights, learned
  decompositions, recovery sequences) is in-memory by default; swap in
  `DexieExperienceStore` from `@buildaharness/runtime` so it survives a page
  reload.

### Checkpointing and resume

`HarnessRuntime.run()`/`.resume()` are async and can suspend mid-loop, yielding
a serializable `HarnessCheckpoint` after each iteration that makes task
progress. `PersonalAssistant` uses this to survive a crash or reload *during*
a turn, not just between them: every turn writes its checkpoint to a
`checkpointStore` (in-memory by default; swap in `IndexedDBAdapter` for
persistence) keyed by `turn:<sessionId>`, and deletes it once the turn
finishes (normally or via escalation). If `turn()` is called again for a
session that still has a leftover checkpoint — because the previous call never
reached that cleanup — it resumes the interrupted harness run instead of
silently starting over.

Net effect: one real LLM call per ordinary turn, zero for a blocked one, and
every layer of the harness touched on the ones that do run — matching what
[buildaharness.com/harness-comparison](https://buildaharness.com/harness-comparison)
calls out as missing from Hermes Agent, Kilo Code, and OpenClaw: none of them
ships a formal Control State resolver *and* a Reviewer/output gate together.

## Usage

```ts
import { LLMClient } from '@buildaharness/runtime'
import { PersonalAssistant } from '@buildaharness/personal-assistant'

const assistant = new PersonalAssistant({
  llmClient: new LLMClient({ proxyUrl, authToken }),
})

const result = await assistant.turn('What time zone is Tokyo in?')
// { status: 'ok', reply: '...', riskLevel: 'LOW', controlState: {...}, stepsUsed: 1 }

const gated = await assistant.turn('Send an email to my boss saying I quit.')
// { status: 'needs_approval', reason: '...', riskLevel: 'HIGH' } — no LLM call made

await assistant.turn('Send an email to my boss saying I quit.', { approved: true })
// proceeds and runs the harness normally
```

In a browser, use `PersonalAssistant.create()` instead of `new PersonalAssistant()`
to default transcript, learning, and checkpoint storage to their IndexedDB/Dexie-backed
implementations, so all three survive a page reload:

```ts
const assistant = await PersonalAssistant.create({
  llmClient: new LLMClient({ proxyUrl, authToken }),
})
```

`create()` only supplies a default for storage the caller didn't already pass
in — outside a browser it falls back to the same in-memory defaults as the
plain constructor *unless* the caller passes its own `memory`/`experienceStore`/
`checkpointStore`, which is exactly what the CLI and the Tauri desktop app do
(see "Front ends" below) to get real persistence without either of them
needing a browser.

## Front ends

Three front ends share this one package and harness underneath — none is more
"real" than the others, and each picks the storage backend that fits where it
runs:

| Front end | Where | Storage |
|---|---|---|
| This package's `PersonalAssistant` class | Any Node/browser code | In-memory by default; bring your own `MemoryAdapter`/`ExperienceStore` |
| CLI (`cli.ts`, below) | Terminal | `FileSystemAdapter`/`FileSystemExperienceStore` (`@buildaharness/runtime`) over `node:fs/promises`, under `~/.buildaharness/personal-assistant/` |
| `@buildaharness/chat-ui` | Browser | `IndexedDBAdapter`/`DexieExperienceStore` via `PersonalAssistant.create()` (best-effort — see `packages/runtime/README.md`'s persistence section) |
| `@buildaharness/desktop` | Native window (Tauri, wraps chat-ui) | Same `FileSystemAdapter`/`FileSystemExperienceStore` classes as the CLI, but over `@tauri-apps/plugin-fs` instead of `node:fs`, under `appLocalDataDir()` |

Both filesystem backends are the *same* `FileSystemAdapter`/`FileSystemExperienceStore`
classes — see `packages/runtime/README.md`'s "Filesystem-backed storage"
section for how the file-I/O seam that makes that possible works.

## CLI

```bash
ASSISTANT_PROXY_URL=http://localhost:8787 ASSISTANT_PROXY_TOKEN=... npm run cli --workspace=packages/personal-assistant
```

Transcript, learned experience, and any in-flight turn's checkpoint persist as
real files under `~/.buildaharness/personal-assistant/` (`transcripts/`,
`experience/`, `checkpoints/`), so conversation history and learning survive
between runs — quit and restart the CLI and it remembers.

## Commands

```bash
npm run build --workspace=packages/personal-assistant
npm test --workspace=packages/personal-assistant
npm run typecheck --workspace=packages/personal-assistant
```
