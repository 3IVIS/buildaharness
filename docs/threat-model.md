# Threat model — the personal assistant

This is the trust model for `@buildaharness/personal-assistant` (a.k.a. Aielia) and
its browser/desktop surfaces. It describes what the assistant defends against, how,
and — just as importantly — what it explicitly does **not** try to defend against.
The disclosure process is in [`../SECURITY.md`](../SECURITY.md).

The one-line version: **the assistant runs a large language model that can be
wrong or adversarially steered, so every action with a real-world effect is either
staged for explicit human approval or contained to a narrow, declared surface.**
The model's *text* is never trusted to be safe on its own.

## Assets

- **Provider API keys / proxy tokens** — in `config.json` (CLI/desktop) or
  `localStorage` (browser). Plaintext (see non-goals).
- **The user's filesystem** — everything outside the configured workspace root is
  off-limits to the file tools.
- **The user's network position** — the assistant should not become a confused
  deputy that reaches internal hosts on the user's behalf.
- **The conversation + memory** — transcripts, extracted facts, reminders,
  learned experience under `~/.buildaharness/personal-assistant/`.

## Adversaries

1. **The model itself** — hallucinated or mistaken tool calls.
2. **Injected content** — a fetched web page, a search result, or shell output
   containing instruction-shaped text aimed at steering the next turn.
3. **A malicious local prompt** — a user pointing the assistant at a repo whose
   files or `CLAUDE.md` try to hijack it.

## Boundaries covered

Each row names the code that enforces it and the test that pins it.

### 1. Actions with effects are staged, never taken silently

`write_file` and `run_shell_command` never touch disk or the shell on the turn
that proposes them — they stage a record under `.pending-actions/` and return
`needs_approval`. The apply step is a separate, explicit call. The gate lives
*inside* each tool (`file-tools.ts`, `file-tools-mcp-server.mjs`), not in a
wrapper, so it holds even on the claude-cli backend where Claude Code's own
agentic loop calls the tools autonomously.

- Enforced: `stagePendingAction` / `applyPendingAction` (`file-tools.ts`).
- Tested: `file-tools.test.ts`, `assistant.test.ts` (approval/decline flow).

### 2. A classifier failure fails safe, not open

`turn-intent-classifier.ts` never silently downgrades. On any classifier LLM
error or unparseable response, `failSafeClassification()` returns
`riskLevel: 'UNKNOWN'` with `requiresApproval: true`, and `toTaskRiskLevel()`
(`task-mapping.ts`) maps `UNKNOWN → 'HIGH'` at every call site that crosses into
the harness. A broken classifier means *more* approval prompts, never fewer.

- Enforced: `failSafeClassification` (`turn-intent-classifier.ts`),
  `toTaskRiskLevel` (`task-mapping.ts`).
- Tested: `turn-intent-classifier.test.ts`, `task-mapping.test.ts`.

### 3. File tools are sandboxed to one workspace root

Every path is resolved and prefix-checked (`resolveInWorkspace`) and then
re-checked against its real, symlink-resolved location (`assertRealPathInWorkspace`)
before any read or staged write. A `../`, an absolute path, or a symlink that
points outside the root throws `PathOutsideWorkspaceError`.

- Enforced: `resolveInWorkspace` / `assertRealPathInWorkspace` (`file-tools.ts`),
  mirrored in `file-tools-mcp-server.mjs`.
- Tested: `file-tools.test.ts`, the `--test` self-check in
  `file-tools-mcp-server.mjs`.

### 4. Fetched content and shell output are marked untrusted

`fetch_url` / `web_search` results and approved shell stdout+stderr are wrapped in
`<untrusted_external_content>` before the model sees them, with a warning prefix
when a regex heuristic (`detectInjectionLikely`) flags instruction-shaped text.
The system prompt tells the model that content inside those tags is data, not
instructions.

- Enforced: `wrapUntrusted` / `detectInjectionLikely` (`trust-tagging.ts`),
  mirrored in `file-tools-mcp-server.mjs`.
- Tested: `trust-tagging.test.ts`, `file-tools-mcp-server.test.ts`.

### 5. SSRF guard on URL fetches

`assertPublicHttpUrl` rejects private, loopback, and link-local targets and
re-checks every redirect hop, so a public URL that 302s to `169.254.169.254` or
`127.0.0.1` is refused mid-fetch.

- Enforced: `assertPublicHttpUrl` (`web-tools.ts`), mirrored in
  `file-tools-mcp-server.mjs`.
- Tested: `web-tools.test.ts`.

### 6. Approved shell commands run with a stripped env and contained network

At apply time a shell command runs with `cwd` pinned to the validated path, a
hard timeout that `SIGKILL`s the process group, output truncated to a byte cap,
and:

- **Env allowlist** — only `PATH`, `HOME`, `LANG` (`ALLOWED_ENV_VARS` in
  `shell-executor.ts`). `ANTHROPIC_API_KEY`, `ASSISTANT_PROXY_TOKEN`, and every
  other parent-process secret is absent from the child.
- **Network containment** — `HTTP(S)_PROXY` is forced at a loopback-only proxy
  (`network-containment.ts`) that relays only to hosts on
  `ASSISTANT_SHELL_NETWORK_ALLOWLIST` (exact or subdomain match). **An empty or
  undefined allowlist denies all network access** — the safe default.

- Enforced: `allowlistedEnv` (`shell-executor.ts`),
  `getNetworkContainmentProxy` (`network-containment.ts`).
- Tested: `shell-executor.test.ts` ("an injected secret env var never reaches the
  command"), `network-containment.test.ts` ("an empty allowlist denies every
  host").

## Non-goals (explicitly accepted)

These are deliberate tradeoffs, per
[`plans/lexical_functions_hardening_plan.html`](../plans/lexical_functions_hardening_plan.html)
Decision 6. Reporting one of these as a vulnerability will get a pointer here.

- **No OS-level sandbox.** The shell containment is Node-level: it strips env and
  forces proxy vars, but a command that opens raw sockets and ignores
  `HTTP(S)_PROXY`, or that reads/writes outside the workspace via an absolute path
  the user approved, is not stopped by seccomp/landlock/`sandbox-exec`/a
  container. Approval is the real gate; enable shell access only when you mean it.
- **Secrets are plaintext.** API keys and tokens live unencrypted in `config.json`
  / `localStorage`, not an OS keychain. Protect those files with filesystem
  permissions.
- **Prompt injection that only changes the model's words is not "handled".** The
  boundary is at *effects*: injected text can make the assistant say something
  wrong, but it cannot make it write a file, run a command, or reach a
  non-allowlisted host without the same staging + approval every other action
  gets. The `<untrusted_external_content>` tagging and injection heuristic are
  defense-in-depth, not a claimed filter.
- **The browser build sends keys directly to the provider.** `/try` and `chat-ui`
  in a plain tab put the user's key in `localStorage` and call the provider's API
  from the page (`anthropic-dangerous-direct-browser-access`). That is the user's
  key on the user's machine talking to the user's provider — but it is not a
  server-mediated secret and the page says so.

## Verification

`scripts/check-security-docs.mjs` (CI) fails if `SECURITY.md` or this file goes
missing, if `SECURITY.md` has no reporting channel, if the README stops linking
either doc, or if a source symbol this file cites (`ALLOWED_ENV_VARS`,
`getNetworkContainmentProxy`, `failSafeClassification`, `assertPublicHttpUrl`,
`resolveInWorkspace`, `wrapUntrusted`) disappears from the file named next to it.
