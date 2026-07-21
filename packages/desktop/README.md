# @buildaharness/desktop

Tauri v2 shell around `@buildaharness/chat-ui`. This package has no frontend
of its own — `src-tauri/tauri.conf.json` points `devUrl` at chat-ui's Vite
dev server (`http://localhost:3010`) and `frontendDist` at its built
`../../chat-ui/dist`, and runs chat-ui's own `dev`/`build` scripts as
`beforeDevCommand`/`beforeBuildCommand` (with `cwd` set to the repo root, since
npm workspace commands need to run from there).

Storage is filesystem-backed, not Dexie/IndexedDB: `packages/chat-ui/src/App.tsx`
detects `isTauri()` and, if true, builds `FileSystemAdapter`/`FileSystemExperienceStore`
(from `@buildaharness/runtime`) over a `@tauri-apps/plugin-fs`-backed `FsBackend`
(`packages/chat-ui/src/tauri-fs-backend.ts`), rooted at `appLocalDataDir()` — on
macOS that's `~/Library/Application Support/com.buildaharness.assistant/`. The
`fs` plugin is registered in `src-tauri/src/lib.rs` and scoped in
`src-tauri/capabilities/default.json` via the `fs:allow-applocaldata-*-recursive`
permission sets. See Phase 3 of `plans/tauri_desktop_plan.html`.

## Commands

```bash
npm run dev --workspace=packages/desktop     # opens the native window against chat-ui's dev server
npm run build --workspace=packages/desktop   # release binary + installers under src-tauri/target/release
```

Requires a Rust toolchain (`rustup`) — Tauri 2.11's dependencies need
`rustc >= 1.88`.

## Settings and the workspace picker

chat-ui's gear-icon Settings screen (see `packages/chat-ui/README.md`) is
identical here, plus a desktop-only Workspace section: "Choose…" opens a
native folder-picker dialog via the `pick_workspace_directory` Tauri command
(`src-tauri/src/lib.rs`, backed by `tauri-plugin-dialog`, permissioned via
`dialog:allow-open` in `src-tauri/capabilities/default.json`). The chosen
path persists through `tauri-config-store.ts` (the same `FileSystemAdapter`
already used for transcripts) and becomes `fileTools`' `workspaceRoot` for
`read_file`/`list_directory`/`write_file`, taking over from
`get_dev_workspace_root()` — the compile-time monorepo root, dev-mode-only —
which remains the fallback until a user picks a real directory.

**Fixed bug**: `run_claude_prompt_with_file_tools` used to call
`dev_workspace_root()` itself, unconditionally, instead of accepting the
resolved workspace root as a parameter — so picking a directory in Settings
changed what `fileTools`/`shellTools` used for *applying* an approved write or
shell command, but the model's `read_file`/`list_directory`/`write_file`/
`run_shell_command` calls during the turn itself stayed scoped to the
monorepo root regardless, since the MCP server config's `WORKSPACE_ROOT` env
var was always derived from the ignored value. `App.tsx` now passes
`workspaceRoot` through `TauriClaudeCliLLMClient` to the Tauri command
explicitly, so both sides of a turn agree on the same directory.

## LLM backend

The desktop build supports all 5 `llmBackend` values now, not just
`claude-cli` — `App.tsx`'s `createLlmClient()` is shared between the
plain-browser and desktop build paths, and picks the `ILLMClient` from
`config.llmBackend` the same way on both. `claude-cli` remains desktop-only
(it's `TauriClaudeCliLLMClient`, a Rust command that spawns `claude -p` on
the host — see above); the other four behave identically to the browser
build:

- `proxy` — `LLMClient`, talks to a self-hosted `@buildaharness/proxy`
  deployment, same as chat-ui's plain-browser build.
- `anthropic`/`openai`/`openrouter` — `AnthropicLLMClient`/
  `OpenAICompatibleLLMClient` (`@buildaharness/runtime`), calling the
  provider directly with a user-supplied API key. These are plain `fetch()`
  calls, which work the same inside Tauri's webview as in a browser tab — no
  Rust command involved, and no CORS issue in practice, since
  `tauri.conf.json`'s `security.csp` is unset. Set the key and pick a
  backend from the Provider section in Settings (see
  `packages/chat-ui/README.md`).

Before this, `createTauriBackedAssistant` unconditionally constructed a
`TauriClaudeCliLLMClient` and never read `config.llmBackend` at all — picking
a different backend in Settings had no effect on desktop. That's the one
part of this app where the fix genuinely changed desktop's behavior, not
just added new options to it.

## Shell

Turning "Shell" on in Settings (`config.enableShell`) does two things on the
desktop build: `run_claude_prompt_with_file_tools` passes `enable_shell_tools:
true`, which sets `ENABLE_SHELL_TOOLS=1` on the file-tools MCP server's env so
it registers `run_shell_command` (`file-tools-mcp-server.mjs`) alongside
read/list/write; and `App.tsx` wires `shellTools.executeCommand` to
`tauri-shell-executor.ts`, which invokes a new `run_shell_command` Tauri
command (`src-tauri/src/lib.rs`) — a Rust port of personal-assistant's
`shell-executor.ts`, since the webview can't spawn processes itself. A
proposed command is always staged first via the same pending-action flow
`write_file` already uses — nothing runs until the user approves it in the
UI. The Rust executor caps output at 20 000 bytes, reduces the child's env to
`PATH`/`HOME`/`USERPROFILE`/`LANG`, and on timeout (`config.shellTimeoutMs`,
default 30 s) kills the whole process group, not just the top-level shell —
parity with `shell-executor.ts`'s Node implementation (`detached` + a
negative-pid signal). On Unix, the child is spawned via `process_group(0)`
(making it the leader of its own new process group) and killed via
`kill -KILL -<pgid>`, reaching a backgrounded/unwaited grandchild the same
way the CLI's negative-pid kill does. On Windows, which has no
process-group-signal equivalent, `taskkill /F /T /PID <pid>` walks and
force-kills the whole descendant tree instead — the closest available
guarantee.

## Diagnostics health check

Settings' Diagnostics > Health section (see `packages/chat-ui/README.md`)
checks the `claude` binary here via a new `check_claude_available` Tauri
command (`src-tauri/src/lib.rs`) — the desktop equivalent of the CLI's
`/doctor` running `claude --version`. Returns `Ok(false)` rather than an
error for "not found"/non-zero exit, since that's an expected health-check
outcome, not an internal failure; no hard timeout on a hung binary (accepted
simplification vs. the CLI's 3s-timeout version — see that command's doc
comment).

## Distribution

Tagged releases (`git tag desktop-v0.1.0 && git push origin desktop-v0.1.0`)
build installers for macOS (universal), Linux (`.deb`/`.rpm`/`.AppImage`), and
Windows (`.msi`/`.exe`) via `.github/workflows/build-desktop.yml`, attached as
a draft GitHub Release.

**These builds are unsigned.** No Apple notarization, no Windows code-signing
cert — that's a distribution/cost decision deferred past getting a working
build into contributors' hands (see Phase 4 of `plans/tauri_desktop_plan.html`).
In practice:

- **macOS**: Gatekeeper blocks the app as "damaged" or "from an unidentified
  developer." Right-click → Open, or `xattr -d com.apple.quarantine
  /Applications/buildaharness-assistant.app` once downloaded.
- **Windows**: SmartScreen warns on first run. "More info" → "Run anyway."
- **Linux**: no warning — nothing to bypass.

## This is one of three front ends

The browser build (`@buildaharness/chat-ui` on its own, Dexie/IndexedDB
storage), this desktop app (same chat-ui, filesystem storage), and the CLI
(`@buildaharness/personal-assistant`'s `cli.ts`, also filesystem storage) all
run the identical `PersonalAssistant`/harness underneath — see that package's
README for the full comparison table.
