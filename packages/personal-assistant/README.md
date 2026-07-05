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

## File access via tools

`PersonalAssistant` can give the model real `read_file`/`list_directory`/`write_file`
tools, scoped to a single sandboxed workspace directory, by passing a `fileTools`
option:

```ts
const assistant = new PersonalAssistant({
  llmClient,
  fileTools: { backend, workspaceRoot: '/path/to/workspace' }, // any FsBackend — node:fs/promises, @tauri-apps/plugin-fs, etc.
})
```

Absent by default — without it, `turn()` behaves exactly as before this option
existed (a single plain chat call, no tools).

Every path a tool call requests is resolved and validated against `workspaceRoot`
before any I/O: `../` traversal, an absolute path outside the root, and a symlink
*inside* the root that points outside it are all rejected (see `file-tools.ts`'s
`resolveInWorkspace`/`assertRealPathInWorkspace`). A rejected or errored tool call
is reported back to the model as a clear decline, never a silent no-op dressed up
as success.

**`write_file` never executes inline.** It always stages a proposal — `{ path,
content, stagedAt }` — as JSON under `<workspaceRoot>/.pending-writes/<id>.json`,
and the turn returns `status: 'needs_approval'` with a `pendingWriteId`, the same
shape `needs_approval` already has for a HIGH-risk message, just triggered by the
tool call itself rather than a regex over the user's words (a request like
"organize my notes into a summary file" doesn't trip the message-level risk
gate, yet it performs a real write once the model decides to call `write_file`).
Resume it by ID rather than re-asking the model:

```ts
const staged = await assistant.turn('Summarize this into notes.md')
// { status: 'needs_approval', reason: '...', pendingWriteId: '...' }

await assistant.turn('Summarize this into notes.md', { approved: true, pendingWriteId: staged.pendingWriteId })
// applies the exact staged content directly via FsBackend — no second LLM call
// { status: 'ok', reply: 'Wrote "notes.md".' }
```

Declining (`{ approved: false, pendingWriteId }`) discards the staged record
without writing. A pending write left over from a crashed/abandoned turn sits
in `.pending-writes/` indefinitely — harmless (never applied without an explicit
`approved: true` with the matching ID) but not currently auto-swept.

Both backends enforce the same "never write inline" rule, by different
mechanisms:

- **Proxy/Anthropic backend** (`LLMClient`): `PersonalAssistant`'s tool loop
  (capped at 5 iterations) calls `callChatStructured` directly, executes
  non-mutating tool calls for real, and intercepts `write_file` itself before
  it ever reaches `file-tools.ts`'s staging code.
- **Claude CLI backend** (`ClaudeCliLLMClient`): Claude Code's own agentic loop
  calls a `file-tools` MCP server (`file-tools-mcp-server.mjs`) autonomously
  within a single `claude -p` invocation — there's no outer TS loop to
  intercept each call, so the gate lives inside the MCP server's `write_file`
  handler instead, which stages exactly the same `.pending-writes/<id>.json`
  record. `ClaudeCliLLMClient` still always passes `--tools ""` (Claude Code's
  own built-in Read/Write/Bash stay off) and adds `--mcp-config`,
  `--strict-mcp-config` (ignore any ambient project `.mcp.json`), and
  `--dangerously-skip-permissions` (headless `-p` mode has no way to answer an
  interactive tool-permission prompt) only when `fileTools` is configured.

v1 is deliberately read/list/write only — no delete/move tool (higher
consequence than a write, no "undo" via re-approval) and no Bash/exec tool
(a much larger risk surface than file I/O). One workspace root per assistant
instance; no multi-root or per-request override. chat-ui doesn't have a
write-approval UI yet — file tools are CLI/desktop-only for now.

## CLI

```bash
ASSISTANT_PROXY_URL=http://localhost:8787 ASSISTANT_PROXY_TOKEN=... npm run cli --workspace=packages/personal-assistant
```

Set `ASSISTANT_WORKSPACE_DIR` to sandbox the file tools to a specific directory
(defaults to the CLI's current working directory, mirroring how `claude` itself
defaults to the launch directory):

```bash
ASSISTANT_WORKSPACE_DIR=/path/to/workspace npm run cli --workspace=packages/personal-assistant
```

When the model calls `write_file`, the CLI prints the proposed path and a
content preview and asks for confirmation before the turn is resumed with
`{ approved, pendingWriteId }` — declining discards the staged write; nothing
is ever written without an explicit yes.

Set `ASSISTANT_LLM_BACKEND=claude-cli` to skip the proxy entirely and run turns
through a local `claude -p` subprocess instead, using your already-authenticated
Claude Code CLI session rather than an API key (`CLAUDE_PATH` overrides the
`claude` binary path if it's not on `PATH`):

```bash
ASSISTANT_LLM_BACKEND=claude-cli npm run cli --workspace=packages/personal-assistant
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
