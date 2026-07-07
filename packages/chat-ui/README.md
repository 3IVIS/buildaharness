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
not a modal — covering Provider (LLM backend picker + whatever fields that
backend needs, see below), Web Search (enable, ddg/brave, Brave API key),
Shell (enable, timeout), and, on the Tauri desktop build only, Workspace (a
native folder picker, via the Rust `pick_workspace_directory` command in
`packages/desktop/src-tauri`).

The Provider section's backend picker (`llmBackend`) offers five values —
`proxy`, `claude-cli`, `anthropic`, `openai`, `openrouter` — with `claude-cli`
only listed as an option on the desktop build (a plain browser tab has no way
to spawn `claude -p`; see `App.tsx`'s `createLlmClient`). Fields below the
picker change per backend: Proxy URL + Auth token only for `proxy`; a single
masked API key field (plus a plaintext-storage warning, same styling as the
`dangerouslySkipPermissions` callout) for `anthropic`/`openai`/`openrouter`;
nothing beyond the picker itself for `claude-cli`, which relies on the host's
already-authenticated `claude` session. A free-text Model field is always
shown, with a backend-specific placeholder (e.g. `gpt-4o-mini` for `openai`) —
leaving it blank falls through to that backend's own hardcoded default rather
than writing a value into the form.

This used to be a `Connection` section that was hidden outright on desktop
(desktop could only ever run `claude-cli`, unconditionally, regardless of
`config.llmBackend`) — `createLlmClient` (`App.tsx`) is now shared between
the plain-browser and desktop build paths, so desktop can use any of the 5
backends, and the three direct-API ones (`anthropic`/`openai`/`openrouter`)
behave identically on both surfaces since they're just `fetch()` calls to the
provider, which works the same inside Tauri's webview as in a browser tab.

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

**Known limitation**: `enableWeb`/`searchBackend`/`braveApiKey` are shown and
persisted for schema consistency with the CLI, but chat-ui has no
`web_search`/`fetch_url` wiring of its own yet (see `App.tsx`'s doc comment) —
that toggle doesn't change behavior here until the capability is added
separately. `enableShell` *is* wired on the desktop build (Tauri's
`run_shell_command` command, gated the same way the CLI gates it) — see
`packages/desktop/README.md`'s Shell section; it remains a no-op in a plain
browser tab, which has no way to execute anything at all. Secrets
(`authToken`, `apiKey`, `braveApiKey`) are stored in plaintext (`localStorage`
or an unencrypted JSON file), same trust boundary as the CLI's `config.json`
— not an OS keychain. `apiKey` is a real Anthropic/OpenAI/OpenRouter
provider key rather than a self-hosted proxy token, so that plaintext-storage
tradeoff is materially bigger here than for `authToken` — the Settings screen
says so next to the field.

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
documents: real cost only for the `claude-cli` backend (`claude`'s own
accounting) — every other backend, including `proxy` and now the three
direct-API ones, gets the same static-table estimate (`estimateCostUsd`, from
`model-pricing.ts`). This is keyed off `config.llmBackend` directly, not
`isTauri()` — desktop is no longer synonymous with claude-cli, see
`App.tsx`'s `withCostEstimate`. See the personal-assistant README's
"`/cost` and real vs. estimated dollar figures" section for the full
explanation.

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
