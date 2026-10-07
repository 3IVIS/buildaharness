# Threat model — the personal assistant

This is the trust model for `@buildaharness/aielia` (a.k.a. Aielia) and
its browser/desktop surfaces. It describes what the assistant defends against, how,
and — just as importantly — what it explicitly does **not** try to defend against.
The disclosure process is in [`../SECURITY.md`](../SECURITY.md).

The one-line version: **the assistant runs a large language model that can be
wrong or adversarially steered, so every action with a real-world effect is either
staged for explicit human approval or contained to a narrow, declared surface.**
The model's *text* is never trusted to be safe on its own.

## Assets

- **Provider API keys / proxy tokens** — in `config.json` (CLI, written
  owner-only, mode 0600), the OS keychain (desktop provider API key) or
  `localStorage` (browser). Plaintext on the CLI and in the browser (see non-goals).
- **The proxy's provider keys** — `@buildaharness/proxy` holds the Anthropic/OpenAI
  (and optionally Brave) keys server-side and hands callers only short-lived tokens.
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
   files, including any project instruction files, try to hijack it.
4. **Hostile output reaching the display** — model, tool or web text carrying
   terminal escape sequences (CLI) or markup (chat-ui) meant to spoof the UI or
   leak data through a URL.
5. **A network caller of the proxy** — someone guessing the proxy secret, abusing a
   token to reach internal hosts through `/web/fetch`, or running up the shared keys.
6. **Another local process** — anything on the same machine that can open a loopback
   TCP connection while an assistant turn is running (see open limitations).

## Boundaries covered

Each row names the code that enforces it and the test that pins it.

### 1. Actions with effects are staged, never taken silently

`write_file` and `run_shell_command` never touch disk or the shell on the turn
that proposes them — they stage a record under `.pending-actions/` and return
`needs_approval`. The apply step is a separate, explicit call. The gate lives
*inside* each tool (`file-tools.ts`, `file-tools-mcp-server.mjs`), not in a
wrapper, so it holds regardless of which backend drives the tool loop.

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
`<untrusted_external_content>` before the model sees them, and a warning prefix is
added when the content is flagged as instruction-shaped. The system prompt tells the
model that content inside those tags is data, not instructions. The wrapping is
unconditional; the *flagging* is a speed bump, not a filter:

- the regex heuristic (`detectInjectionLikely`) belongs to the `injection` lexical
  family, which is **off by default** (every lexical family is; see
  `lexical/lexical-mode.ts`) and only runs when switched on;
- the default detector is one bounded LLM classification call
  (`detectInjectionLikelyWithLLM`, `AUDIT_LLM_INJECTION_DETECT`, default on). It is
  itself an LLM reading hostile text, and on any error or unparseable reply it
  returns "not flagged".

Content is always still returned to the model, flagged or not.

- Enforced: `wrapUntrusted` / `detectInjectionLikely` (`trust-tagging.ts`),
  mirrored in `file-tools-mcp-server.mjs`.
- Tested: `trust-tagging.test.ts`, `file-tools-mcp-server.test.ts`.

### 5. SSRF guard on URL fetches

`assertPublicHttpUrl` (implemented in `web-fetch-core.ts`, re-exported from
`web-tools.ts`) rejects, before any DNS call, non-http(s) schemes, URLs with
credentials, ports other than 80/443 and raw IP literals; it then resolves the
hostname and refuses private, loopback, link-local, carrier-grade-NAT, multicast
and cloud-metadata addresses, including IPv4-mapped/NAT64 IPv6 forms. Every
redirect hop is re-checked (a public URL that 302s to `169.254.169.254` or
`127.0.0.1` is refused mid-fetch), redirects are capped, and the body size,
content type and total time are bounded. The desktop HTTP plugin is told not to
follow redirects itself (`maxRedirections: 0`) so it cannot skip the per-hop
check. The same guard (kept in sync by hand) runs in `@buildaharness/proxy`'s
`/web/fetch`, and the claude-cli MCP server has its own mirrored copy.

The check and the connection resolve DNS separately, so a hostname that answers
publicly to the guard and privately to the connection (DNS rebinding) is **not**
caught; see the open limitations below.

- Enforced: `assertPublicHttpUrl` (`web-tools.ts`, `web-fetch-core.ts`), mirrored in
  `file-tools-mcp-server.mjs` and `packages/proxy/src/web-fetch-core.ts`.
- Tested: `web-tools.test.ts`, `web-fetch-core.test.ts` (aielia and proxy).

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
- **Desktop** — the Rust port of the executor strips the env the same way
  (`PATH`/`HOME`/`USERPROFILE`/`LANG`) but has no containment proxy: it points the
  `HTTP(S)_PROXY`/`ALL_PROXY` variables at a closed loopback port, so proxy-aware
  clients fail closed, and `shellNetworkAllowlist` is not honoured there.

- Enforced: `allowlistedEnv` (`shell-executor.ts`),
  `getNetworkContainmentProxy` (`network-containment.ts`).
- Tested: `shell-executor.test.ts` ("an injected secret env var never reaches the
  command"), `network-containment.test.ts` ("an empty allowlist denies every
  host").

### 7. The proxy authenticates callers and bounds what they can reach

`@buildaharness/proxy` keeps provider keys server-side. `POST /auth/token` compares the
submitted secret in constant time, throttles failed attempts per client IP
(`AUTH_FAILS_PER_HOUR`, default 10, then 429) and issues a 1-hour JWT; every other route
requires it. Client identity for throttling is the TCP peer address (or
`CF-Connecting-IP` on the Cloudflare Worker); `X-Forwarded-For`/`X-Real-IP` are honoured
only when the operator sets `TRUST_PROXY_HEADERS`, so a spoofed header cannot dodge the
limits. Anthropic requests authenticate upstream with `x-api-key`. `/web/*` routes have
per-token, per-IP, per-host, byte, concurrency and daily Brave ceilings, `/web/fetch`
only fetches URLs carrying a short-lived HMAC `fetchTag` (issued by `/web/search` or
`/web/grant`), and `/web/grant` structurally pre-checks the URL with the same SSRF guard
before signing it. chat-ui requests a grant only for a URL the user typed.

- Enforced: `packages/proxy/src/index.ts`, `auth.ts`, `web-quota-middleware.ts`,
  `web-grant.ts`, `web-fetch-tag.ts`.
- Tested: `index.test.ts`, `client-ip-node.test.ts`, `rate-limit.test.ts`,
  `web-fetch-tag.test.ts`.

### 8. What reaches the screen and the disk is constrained

- **Terminal output** — CLI output paths strip terminal escape and control sequences
  from model, tool, web and stored text (`stripTerminalControls`), and `proxyUrl`
  credentials are masked when printed.
- **chat-ui** — markdown images in assistant replies are never loaded (a data-exfiltration
  channel through the URL); links open in a new context with `noopener noreferrer nofollow`.
- **Desktop webview** — a restrictive Content-Security-Policy (`default-src 'self'`, no
  remote scripts or objects, and the page cannot be framed) so injected markup cannot load remote resources.
  The provider API key is held in the OS keychain, not the config file.
- **Files** — `config.json` and the activity log are written owner-only (0600/0700);
  undo-log ids that could climb out of `.undo-log/` are rejected.

### 9. Self-update refuses unverified binaries

`aielia update` only accepts https URLs (and refuses a download redirected onto http),
downloads to a fresh exclusive temp file (it will not write through a planted symlink),
requires a sha256 from the manifest (a different origin from the binary) or a sidecar
file, and re-hashes the file on disk immediately before replacing the binary.

- Enforced: `self-update.ts`. Tested: `self-update.test.ts`.

## Non-goals (explicitly accepted)

These are deliberate tradeoffs, per
the internal plan
Decision 6. Reporting one of these as a vulnerability will get a pointer here.

- **No OS-level sandbox.** The shell containment is Node-level: it strips env and
  forces proxy vars, but a command that opens raw sockets and ignores
  `HTTP(S)_PROXY`, or that reads/writes outside the workspace via an absolute path
  the user approved, is not stopped by seccomp/landlock/`sandbox-exec`/a
  container. Approval is the real gate; enable shell access only when you mean it.
- **Secrets are plaintext on the CLI and in the browser.** API keys and tokens live
  unencrypted in `config.json` (mode 0600) / `localStorage`, not an OS keychain; only
  the desktop app uses the keychain for the provider API key. Protect those files
  with filesystem permissions.
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

## Open limitations (known gaps, not accepted as "fine")

These are known weaknesses in the current code that we have not closed. Treat them as
real when deciding how to deploy.

- **DNS rebinding in the SSRF guards.** `assertPublicHttpUrl` resolves the hostname to
  check it, then the HTTP client resolves it again to connect. A hostname whose DNS
  answers publicly to the first lookup and privately to the second passes the guard.
  The guards do not pin the connection to the checked address. This applies to
  `fetch_url` in aielia (CLI, browser, desktop) and to the proxy's `/web/fetch`.
- **The desktop shell has no real network allowlist.** Unlike the CLI there is no
  containment proxy on desktop: network denial relies on proxy-aware clients honouring
  a closed-port proxy variable, and `shellNetworkAllowlist` is ignored. Any client that
  ignores proxy variables has full network access once the user approves the command.
- **The browser build keeps keys in `localStorage`.** Any script that runs in the page
  origin (including a successful XSS) can read the provider key or proxy token.
  Markdown images are blocked, but that is one exfiltration channel closed, not a
  guarantee.
- **The claude-cli tool-gate server has no per-call secret.** `startToolGateServer`
  listens on an ephemeral port on `127.0.0.1`, passed to the MCP subprocess as
  `TOOL_GATE_PORT`. Any local process that finds the port during a turn can send gate
  requests: it can read an `allow` decision, report fabricated tool results into the
  turn's evidence, or ask the parent to execute `fetch_url`/`web_search`. The gate also
  fails open on any error by design, so it is defense-in-depth on top of the staging
  and sandbox boundaries above, not a boundary itself.
- **The claude-cli backend runs with `--dangerously-skip-permissions`.** The `claude`
  subprocess is started with its own built-in tools disabled (`--tools ''`) and only
  the Aielia MCP server enabled (`--strict-mcp-config`), so the effective tool surface
  is Aielia's; but a headless run cannot answer permission prompts, so the boundary is
  that tool list, not a prompt.
- **Lexical gates are speed bumps.** Regex and keyword checks over natural language
  (the injection heuristic, fact markers, risk keywords, task-cancel phrases and the
  rest of the lexical families) are trivially evaded by rephrasing, so they are off by
  default and none of the boundaries above depends on them. Where a semantic (LLM)
  check replaces one, that check is itself steerable by hostile content and fails open
  on error.
- **The proxy is not a per-user quota system.** `/llm/chat` has no spend or request
  limit of its own (the quota middleware covers `/web/*`), tokens from `/auth/token` all
  carry the same subject, and rate-limit state is in memory per process or isolate. Anyone
  holding the proxy secret or a valid token can spend the configured provider keys.
- **`ASSISTANT_DANGEROUSLY_SKIP_PERMISSIONS=1` disables approval prompts** for staged
  actions by design. Do not set it outside a throwaway environment.

## Verification

`scripts/check-security-docs.mjs` (CI) fails if `SECURITY.md` or this file goes
missing, if `SECURITY.md` has no reporting channel, if the README stops linking
either doc, or if a source symbol this file cites (`ALLOWED_ENV_VARS`,
`getNetworkContainmentProxy`, `failSafeClassification`, `assertPublicHttpUrl`,
`resolveInWorkspace`, `wrapUntrusted`) disappears from the file named next to it. It does not check the proxy, desktop, update or display claims in boundaries 7-9 or the open limitations; those are maintained by hand.
