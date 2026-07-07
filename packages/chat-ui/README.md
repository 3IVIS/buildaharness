# @buildaharness/chat-ui

A minimal chat UI wrapping `PersonalAssistant.create()` from
`@buildaharness/personal-assistant` directly — no FlowSpec/canvas involved,
this is the assistant's own UI, not the flow editor.

Ships as a normal web app first, buildable and testable independent of Tauri
(see `plans/tauri_desktop_plan.html`), so the UI and `PersonalAssistant`
wiring are validated in a browser before any native shell wraps it. The exact
same build is what `@buildaharness/desktop` wraps — there's no separate
"desktop version" of this package.

## Storage

`App.tsx` checks `isTauri()` (from `@tauri-apps/api/core`) on mount. In a
plain browser, `PersonalAssistant.create()` defaults to IndexedDB/Dexie as
usual. Inside the Tauri desktop shell, it instead builds `FileSystemAdapter`/
`FileSystemExperienceStore` (`@buildaharness/runtime`) over a
`@tauri-apps/plugin-fs`-backed `FsBackend` (`src/tauri-fs-backend.ts`), rooted
at `appLocalDataDir()` — real files instead of a browser database. See
`packages/runtime/README.md`'s "Filesystem-backed storage" section and
`packages/desktop/README.md`.

## Behavior

Renders each `AssistantTurnResult` status distinctly:

- `ok` — a normal assistant reply bubble.
- `needs_approval` — an approve/deny card; approving replays the same
  message with `{ approved: true }`, denying leaves it cancelled.
- `escalated` — a halt banner; the harness needs more information than the
  turn provided and there's nothing to approve.

## Settings

The gear icon in the header swaps the whole screen for `SettingsScreen.tsx` —
not a modal — covering Connection (proxy URL/auth token/model), Web Search
(enable, ddg/brave, Brave API key), Shell (enable, timeout), and, on the
Tauri desktop build only, Workspace (a native folder picker, via the Rust
`pick_workspace_directory` command in `packages/desktop/src-tauri`). The
Connection section is hidden on desktop since it always talks to the user's
own already-authenticated `claude -p` session, not the proxy.

Settings persist through a `ConfigStore` (`@buildaharness/personal-assistant`'s
shared `AssistantConfig`/`resolveConfig`) — `browser-config-store.ts`
(`localStorage`) in a plain browser, `tauri-config-store.ts` (the same
`FileSystemAdapter` already used for transcripts, under a `config`
namespace) on desktop. `VITE_ASSISTANT_PROXY_URL`/`_TOKEN`/`_MODEL` still win
over whatever's persisted — see `browser-config.ts` — so an existing deployed
build with those baked in behaves exactly as before; Settings only changes
the default that applies when none of those are set. Saving tears down and
recreates the `PersonalAssistant` instance so a change applies to the very
next turn, no reload needed.

**Known limitation**: `enableWeb`/`enableShell`/`searchBackend`/`braveApiKey`
are shown and persisted for schema consistency with the CLI, but chat-ui has
no `web_search`/`fetch_url`/`run_shell_command` wiring of its own yet (see
`App.tsx`'s doc comment) — those toggles don't change behavior here until
that capability is added separately. Secrets (`authToken`, `braveApiKey`) are
stored in plaintext (`localStorage` or an unencrypted JSON file), same trust
boundary as the CLI's `config.json` — not an OS keychain.

## Session actions & Diagnostics

The header (next to the gear icon) has three buttons — the GUI equivalents
of the CLI's `/clear`, `/export`, and `/undo`:

- **New chat** — ends the current conversation (`PersonalAssistant.clearSession()`)
  and resets every piece of derived UI state (usage, memory, health) so
  nothing shows stale data for the fresh session.
- **Export** — downloads the transcript as a markdown file (a `Blob` URL +
  a throwaway `<a download>`, works the same in a plain browser tab and
  inside the Tauri webview). Disabled with no conversation yet.
- **Undo** — removes the last exchange from conversation history
  (`PersonalAssistant.undoLastTurn()`), adjusting the visible message list to
  match: a completed turn drops both bubbles, a still-pending approval card
  drops just that one. Disabled with no conversation yet.

`SettingsScreen.tsx` has a **Diagnostics** section (below Shell, above the
Save/Cancel footer) — the GUI equivalents of `/status` (transcript length),
`/memory`, `/cost`, and `/doctor`. Populated once, when Settings opens (not
kept live — Settings and the chat view are mutually exclusive, so there's no
risk of it going stale while both are visible), and rendered with the exact
same formatters (`formatMemorySummary`/`formatCostSummary`/`formatDoctorReport`
from `@buildaharness/personal-assistant`) the CLI's `/memory`/`/cost`/`/doctor`
use, so the two front ends never drift into two descriptions of the same
facts. Health checks are platform-specific (`src/gui-doctor-checks.ts`): a
plain browser checks proxy reachability via `fetch`; the Tauri desktop build
checks the `claude` binary (a new `check_claude_available` Rust command),
workspace configuration, and data-dir writability instead, since desktop has
no proxy to check.

Cost estimation follows the same real-vs-approximate split the CLI's `/cost`
documents: real on desktop (`claude`'s own accounting), a static-table
estimate on the proxy backend (`estimateCostUsd`, from `model-pricing.ts`) —
see the personal-assistant README's "`/cost` and real vs. estimated dollar
figures" section for the full explanation.

## Usage

```bash
cp packages/chat-ui/.env.example packages/chat-ui/.env.local
# fill in VITE_ASSISTANT_PROXY_URL / VITE_ASSISTANT_PROXY_TOKEN (see packages/proxy)

npm run dev --workspace=packages/chat-ui
```

## Commands

```bash
npm run build --workspace=packages/chat-ui
npm test --workspace=packages/chat-ui
npm run typecheck --workspace=packages/chat-ui
```
