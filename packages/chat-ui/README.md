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
