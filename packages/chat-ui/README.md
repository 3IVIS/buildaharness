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
