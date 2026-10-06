var __defProp = Object.defineProperty;
var __defNormalProp = (obj, key, value) => key in obj ? __defProp(obj, key, { enumerable: true, configurable: true, writable: true, value }) : obj[key] = value;
var __publicField = (obj, key, value) => __defNormalProp(obj, typeof key !== "symbol" ? key + "" : key, value);
import { createInterface } from "node:readline";
import { rename, stat, realpath, readdir, mkdir, unlink, writeFile, readFile } from "node:fs/promises";
import { existsSync, mkdirSync, writeFileSync, renameSync, rmSync, createWriteStream, chmodSync, readFileSync, realpathSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { OPENROUTER_DEFAULT_MODEL, OPENAI_DEFAULT_MODEL, ANTHROPIC_DEFAULT_MODEL, InMemoryReminderStore, FileSystemAdapter, FileSystemExperienceStore, LLMClient, OpenAICompatibleLLMClient, OPENROUTER_EXTRA_HEADERS, OPENROUTER_BASE_URL, OPENAI_BASE_URL, AnthropicLLMClient } from "@buildaharness/runtime";
import { X as buildClaudePrompt, bH as stripJsonCodeFence, bm as recallToolEnabled, aX as lexicalOffEnvValue, a as ALREADY_STAGED_ACTION_TOOL, bG as stagedActionInput, bg as parseClaudeCliOutput, bI as stripMcpToolPrefix, b3 as memoryStatusChecks, bf as normalizePlanNodes, P as PROVIDER_SETUP, a3 as cleanApiKey, Z as checkApiKeyFormat, af as envOverridesFromProcessEnv, bp as resolveConfig, bE as shouldLaunchTuiApp, Q as applyLayerSettings, bC as sanitizeLayerChoices, bL as testApiKey, bO as validateConfig, c as ConfigValidationError, aF as formatSpendCapStatus, aS as isPlanGraphEnabled, z as PersonalAssistant, aP as isGoalGraphSuggestEnabled, aO as isGoalGraphEnabled, bl as planToSnapshot, V as braveSearch, a7 as createSmtpSender, a6 as createResendSender, aU as isQuitCommand, x as LiveSteeringChannel, aC as formatNextSteps, _ as classifyError, b6 as nodeToLayer, L as LAYER_DISPLAY_NAME, b5 as nodeDisplayName, ah as estimateCostUsd, ao as formatConfigListing, aN as isConfigKey, C as CONFIG_KEYS, E as ENV_VAR_FOR_CONFIG_KEY, bh as parseConfigValue, d as ConfigValueParseError, aq as formatDoctorReport, ap as formatCostSummary, as as formatGoalGraphState, aE as formatSearchResults, ax as formatMemoryHistory, aA as formatMemoryStatus, az as formatMemoryPendingOutcome, av as formatMemoryArchive, aI as formatUndoLogListing, aa as defaultExportFilename, aH as formatTranscriptMarkdown, aG as formatStatus, at as formatHelp, q as LAYER_ORDER, au as formatLayerListing, bP as withLayerChoice, w as LayerSettingError, ay as formatMemoryInjection, Y as buildWhyChain, s as LAYER_SHORT_CODE, ab as defaultMemoryExportFilename, aw as formatMemoryExport, b2 as memoryAuditLogEnabled, aB as formatMemorySummary } from "./provider-setup-ecltIdus.js";
import { spawn } from "node:child_process";
import { createServer, connect } from "node:net";
import { createRequire } from "node:module";
import { randomBytes, createHash } from "node:crypto";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
function isEnoent$1(err) {
  return (err == null ? void 0 : err.code) === "ENOENT";
}
function createNodeFsBackend() {
  return {
    async readTextFile(path) {
      try {
        return await readFile(path, "utf-8");
      } catch (err) {
        if (isEnoent$1(err)) return void 0;
        throw err;
      }
    },
    async writeTextFile(path, contents) {
      await writeFile(path, contents, "utf-8");
    },
    async removeFile(path) {
      try {
        await unlink(path);
      } catch (err) {
        if (!isEnoent$1(err)) throw err;
      }
    },
    async mkdir(path) {
      await mkdir(path, { recursive: true });
    },
    async readDir(path) {
      try {
        return await readdir(path);
      } catch (err) {
        if (isEnoent$1(err)) return [];
        throw err;
      }
    },
    async realpath(path) {
      return realpath(path);
    },
    async stat(path) {
      try {
        const info = await stat(path);
        return { isDirectory: info.isDirectory(), size: info.size };
      } catch (err) {
        if (isEnoent$1(err)) return void 0;
        throw err;
      }
    },
    async rename(from, to) {
      await rename(from, to);
    }
  };
}
const CLI_VERSION = "0.3.5";
function seaCacheDir(version, home = homedir()) {
  return join(home, ".buildaharness", "personal-assistant", "sea-cache", version);
}
function extractAssetOnce(dir, fileName, read) {
  const target = join(dir, fileName);
  if (existsSync(target)) return target;
  mkdirSync(dir, { recursive: true });
  const tmp = `${target}.${process.pid}.tmp`;
  const data = read();
  writeFileSync(tmp, typeof data === "string" ? data : new Uint8Array(data));
  renameSync(tmp, target);
  return target;
}
const MCP_SERVER_FILE_NAME = "file-tools-mcp-server.mjs";
const MCP_SERVER_PATTERN_FILES = ["injection-patterns.json", "fact-markers.json", "risk-patterns.json"];
function loadSea() {
  try {
    const sea = createRequire(import.meta.url)("node:sea");
    return sea.isSea() ? sea : null;
  } catch {
    return null;
  }
}
function resolveMcpServerPath(seaOverride, home) {
  const sea = loadSea();
  if (sea) {
    const dir = seaCacheDir(CLI_VERSION, home);
    for (const name of MCP_SERVER_PATTERN_FILES) {
      const key = `lexical/patterns/${name}`;
      extractAssetOnce(join(dir, "lexical", "patterns"), name, () => sea.getRawAsset(key));
    }
    return extractAssetOnce(dir, MCP_SERVER_FILE_NAME, () => sea.getRawAsset(MCP_SERVER_FILE_NAME));
  }
  return fileURLToPath(new URL(MCP_SERVER_FILE_NAME, import.meta.url));
}
const EMPTY_MCP_CONFIG = JSON.stringify({ mcpServers: {} });
function invokeClaude(claudePath, args) {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(claudePath, args, { cwd: tmpdir(), stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `claude exited with code ${code}`));
        return;
      }
      resolvePromise(parseClaudeCliOutput(stdout));
    });
  });
}
function invokeClaudeStreaming(claudePath, args, onToolStep) {
  return new Promise((resolvePromise, reject) => {
    const proc = spawn(claudePath, args, { cwd: tmpdir(), stdio: ["ignore", "pipe", "pipe"] });
    let buffer = "";
    let stderr = "";
    let finalResultLine;
    proc.stdout.on("data", (chunk) => {
      var _a;
      buffer += chunk.toString("utf-8");
      let newlineIndex;
      while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, newlineIndex);
        buffer = buffer.slice(newlineIndex + 1);
        if (!line.trim()) continue;
        let event;
        try {
          event = JSON.parse(line);
        } catch {
          continue;
        }
        if (event.type === "assistant" && onToolStep) {
          for (const block of ((_a = event.message) == null ? void 0 : _a.content) ?? []) {
            if (block.type !== "tool_use") continue;
            const toolUse = block;
            onToolStep({ tool: stripMcpToolPrefix(toolUse.name), input: toolUse.input ?? {} });
          }
        } else if (event.type === "result") {
          finalResultLine = line;
        }
      }
    });
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    proc.on("error", reject);
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `claude exited with code ${code}`));
        return;
      }
      resolvePromise(parseClaudeCliOutput(finalResultLine ?? ""));
    });
  });
}
function startToolGateServer(onToolProposal, onToolResult, onToolExecute) {
  return new Promise((resolvePromise, reject) => {
    const server = createServer((socket) => {
      let buffer = "";
      socket.on("data", (chunk) => {
        buffer += chunk.toString("utf-8");
        let newlineIndex;
        while ((newlineIndex = buffer.indexOf("\n")) !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (!line.trim()) continue;
          void (async (requestLine) => {
            let request;
            try {
              request = JSON.parse(requestLine);
            } catch {
              socket.write(`${JSON.stringify({ decision: "allow" })}
`);
              return;
            }
            if (request.kind === "execute") {
              let reply = { handled: false };
              try {
                if (onToolExecute && typeof request.tool === "string") {
                  const text = await onToolExecute(request.tool, request.input ?? {});
                  if (text !== void 0) reply = { handled: true, text };
                }
              } catch (err) {
                reply = { handled: true, error: err instanceof Error ? err.message : String(err) };
              }
              socket.write(`${JSON.stringify(reply)}
`);
              return;
            }
            if (request.kind === "result") {
              try {
                if (onToolResult && typeof request.tool === "string" && typeof request.text === "string") {
                  await onToolResult(request.tool, request.input ?? {}, request.text, request.ok !== false, request.notFound === true);
                }
              } catch (err) {
                console.error("claude-cli tool gate: onToolResult threw — ignoring:", err);
              }
              socket.write(`${JSON.stringify({ decision: "allow" })}
`);
              return;
            }
            let decision;
            try {
              decision = onToolProposal && typeof request.tool === "string" ? await onToolProposal(request.tool, request.input ?? {}) : { decision: "allow" };
            } catch (err) {
              console.error("claude-cli tool gate: onToolProposal threw — failing open:", err);
              decision = { decision: "allow" };
            }
            socket.write(`${JSON.stringify(decision)}
`);
          })(line);
        }
      });
    });
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        reject(new Error("tool gate server failed to bind to a loopback TCP port"));
        return;
      }
      resolvePromise({ server, port: address.port });
    });
  });
}
class ClaudeCliLLMClient {
  constructor(options = {}) {
    __publicField(this, "claudePath");
    __publicField(this, "fileTools");
    __publicField(this, "remindersFile");
    __publicField(this, "shellTools");
    __publicField(this, "webTools");
    __publicField(this, "actionTools");
    __publicField(this, "model");
    /**
     * The concrete model id the last `claude -p` call actually reported running against (read from
     * the response's own `model` field, not the CLI alias). `undefined` until a call resolves one.
     * Plan A1 records this into the benchmark report so a published table can name the model.
     */
    __publicField(this, "resolvedModelId");
    this.claudePath = options.claudePath ?? process.env.CLAUDE_PATH ?? "claude";
    this.fileTools = options.fileTools;
    this.remindersFile = options.remindersFile;
    this.shellTools = options.shellTools;
    this.webTools = options.webTools;
    this.actionTools = options.actionTools;
    this.model = options.model;
  }
  async *callChat(messages, options = {}) {
    yield await this.callChatSync(messages, options);
  }
  async callChatSync(messages, options = {}) {
    var _a;
    const { systemPrompt, prompt } = buildClaudePrompt(messages);
    const args = [
      "--print",
      "--output-format",
      "json",
      "--tools",
      "",
      "--no-session-persistence",
      "--system-prompt",
      systemPrompt,
      "--mcp-config",
      EMPTY_MCP_CONFIG,
      "--strict-mcp-config"
      // ignore any ambient project/user MCP config — see EMPTY_MCP_CONFIG's doc comment
    ];
    const model = options.model ?? this.model;
    if (model) args.push("--model", model);
    args.push(prompt);
    const { reply, usage, model: resolved } = await invokeClaude(this.claudePath, args);
    if (resolved) this.resolvedModelId = resolved;
    if (usage) (_a = options.onUsage) == null ? void 0 : _a.call(options, usage);
    return reply;
  }
  /**
   * When `tools` is non-empty and `fileTools`/`shellTools` was configured, wires the
   * file-tools MCP server into a single `claude -p` call and lets Claude Code's own
   * agentic loop call read_file/list_directory/write_file/fetch_url/create_reminder/
   * list_reminders/run_shell_command autonomously — we don't get to intercept each
   * call the way the proxy backend's manual tool loop does (see
   * the internal plan, T6). fetch_url is always
   * registered on that server; create_reminder/list_reminders only when
   * `remindersFile` is set; run_shell_command only when `shellTools` is set;
   * web_search only when `webTools` is set (Brave Search — see the `webTools`
   * option). Three
   * possible outcomes: a final text reply (no tool call this backend needs to
   * surface), a write or shell command staged by the MCP server mid-call (surfaced
   * as a synthetic `__staged_action` tool call so assistant.ts's tool loop treats it
   * the same as a manually staged action without staging it a second time), or —
   * for fetch_url/create_reminder/list_reminders — the tool's result text folded
   * directly into Claude Code's own reply, since (unlike the proxy backend's
   * `executeToolCall`) there's no outer loop here to intercept each call and
   * re-apply trust-tagging itself; the MCP server tags fetch_url's result before
   * Claude Code ever sees it instead (see file-tools-mcp-server.mjs).
   */
  async callChatStructured(messages, tools, options = {}) {
    var _a, _b, _c, _d, _e2, _f;
    if (!tools || tools.length === 0) {
      const content = await this.callChatSync(messages, options);
      return { content: options.structuredOutput ? stripJsonCodeFence(content) : content };
    }
    if (!this.fileTools && !this.shellTools && !this.webTools && !this.actionTools && !recallToolEnabled()) {
      throw new Error(
        "ClaudeCliLLMClient does not support tool calls unless constructed with fileTools, shellTools, webTools, or actionTools configured"
      );
    }
    const { systemPrompt, prompt } = buildClaudePrompt(messages);
    const workspaceRoot = ((_a = this.fileTools) == null ? void 0 : _a.workspaceRoot) ?? ((_b = this.shellTools) == null ? void 0 : _b.workspaceRoot) ?? ((_c = this.actionTools) == null ? void 0 : _c.workspaceRoot) ?? tmpdir();
    const lastUserMessage = ((_d = [...messages].reverse().find((m) => m.role === "user")) == null ? void 0 : _d.content) ?? "";
    const mcpServerPath = resolveMcpServerPath();
    const gate = await startToolGateServer(options.onToolProposal, options.onToolResult, options.onToolExecute);
    try {
      const mcpConfig = JSON.stringify({
        mcpServers: {
          "file-tools": {
            command: "node",
            args: [mcpServerPath],
            env: {
              WORKSPACE_ROOT: workspaceRoot,
              TOOL_GATE_PORT: String(gate.port),
              ...this.remindersFile ? { REMINDERS_FILE: this.remindersFile, CURRENT_USER_MESSAGE: lastUserMessage } : {},
              ...this.shellTools ? { ENABLE_SHELL_TOOLS: "1" } : {},
              ...((_e2 = this.webTools) == null ? void 0 : _e2.braveApiKey) ? { BRAVE_SEARCH_API_KEY: this.webTools.braveApiKey } : {},
              ...this.actionTools ? { ENABLE_EMAIL_TOOL: "1" } : {},
              // M3: recall_memory is registered (gated, then served by the parent via onToolExecute) only under AUDIT_RECALL_TOOL.
              ...recallToolEnabled() ? { ENABLE_RECALL_TOOL: "1" } : {},
              // Always passed (even empty): the server reads an unset value as the default, every family off.
              ASSISTANT_LEXICAL_RESOLVED_OFF: lexicalOffEnvValue()
            }
          }
        }
      });
      const args = [
        "--print",
        "--output-format",
        "stream-json",
        // streamed (not the single-object 'json') so tool_use events can be reported live via onToolStep — see invokeClaudeStreaming
        "--verbose",
        // required by --print when --output-format is stream-json
        "--tools",
        "",
        // still disable Claude Code's own built-in Read/Write/Bash tools — Bash is never added, regardless of shellTools
        "--no-session-persistence",
        "--system-prompt",
        systemPrompt,
        "--mcp-config",
        mcpConfig,
        "--strict-mcp-config",
        // ignore any ambient project .mcp.json — the tool surface must be exactly this plan's tools
        "--dangerously-skip-permissions"
        // headless -p mode has no way to answer an interactive tool-permission prompt
      ];
      const model = options.model ?? this.model;
      if (model) args.push("--model", model);
      args.push(prompt);
      const callStartedAt = Date.now();
      const { reply, usage, model: resolved } = await invokeClaudeStreaming(this.claudePath, args, options.onToolStep);
      if (resolved) this.resolvedModelId = resolved;
      if (usage) (_f = options.onUsage) == null ? void 0 : _f.call(options, usage);
      const staged = await this.findPendingActionStagedSince(workspaceRoot, callStartedAt);
      if (staged) {
        return {
          content: "",
          toolCalls: [{ id: `cli-staged-${staged.id}`, name: ALREADY_STAGED_ACTION_TOOL, input: stagedActionInput(staged) }]
        };
      }
      return { content: reply };
    } finally {
      gate.server.close();
    }
  }
  /** Diffs .pending-actions/ against the call's start time to detect a write or shell command the MCP server staged during this subprocess call. */
  /**
   * When the MCP server staged more than one action this call (e.g. "run X AND write Y" —
   * see file-tools-mcp-server.mjs's stagePendingAction doc comment), every one of them lands
   * in `.pending-actions/` with an mtime after `startTimeMs`, in `readdir`-arbitrary order —
   * not necessarily staging order. Must return the *chain head* (earliest `stagedAt`)
   * specifically, since resolvePendingAction (assistant.ts) walks `nextPendingActionId`
   * forward from whichever record it's handed; returning a later link here would surface the
   * chain out of order and orphan the earlier, still-unresolved action.
   */
  async findPendingActionStagedSince(workspaceRoot, startTimeMs) {
    const dir = `${workspaceRoot}/.pending-actions`;
    let names;
    try {
      names = await readdir(dir);
    } catch {
      return void 0;
    }
    let earliest;
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const filePath = `${dir}/${name}`;
      const stats = await stat(filePath);
      if (stats.mtimeMs < startTimeMs - 1e3) continue;
      const record = JSON.parse(await readFile(filePath, "utf-8"));
      if (!earliest || record.stagedAt < earliest.stagedAt) earliest = record;
    }
    return earliest;
  }
}
const MAX_HEADER_BYTES = 16384;
function hostAllowed(host, allowlist) {
  const normalized = host.toLowerCase();
  return allowlist.some((entry) => {
    const allowed = entry.toLowerCase();
    return normalized === allowed || normalized.endsWith(`.${allowed}`);
  });
}
function parseConnectTarget(requestLine) {
  const match = /^CONNECT\s+([^:\s]+):(\d+)\s+HTTP/i.exec(requestLine);
  return match ? { host: match[1], port: Number(match[2]) } : null;
}
function parsePlainHttpTarget(requestLine, headerText) {
  const absoluteUri = /^[A-Z]+\s+https?:\/\/([^/:\s]+)(?::(\d+))?/i.exec(requestLine);
  if (absoluteUri) return { host: absoluteUri[1], port: Number(absoluteUri[2] ?? 80) };
  const hostHeader = /^host:\s*([^\s:]+)(?::(\d+))?/im.exec(headerText);
  return hostHeader ? { host: hostHeader[1], port: Number(hostHeader[2] ?? 80) } : null;
}
function handleConnection(clientSocket, allowlist) {
  let buffered = Buffer.alloc(0);
  const onData = (chunk) => {
    buffered = Buffer.concat([buffered, chunk]);
    const headerEnd = buffered.indexOf("\r\n\r\n");
    if (headerEnd === -1) {
      if (buffered.length > MAX_HEADER_BYTES) clientSocket.destroy();
      return;
    }
    clientSocket.removeListener("data", onData);
    const headerText = buffered.slice(0, headerEnd).toString("utf-8");
    const requestLine = headerText.split("\r\n")[0] ?? "";
    const isConnect = /^CONNECT\s/i.test(requestLine);
    const target = isConnect ? parseConnectTarget(requestLine) : parsePlainHttpTarget(requestLine, headerText);
    if (!target || !hostAllowed(target.host, allowlist)) {
      clientSocket.end("HTTP/1.1 403 Forbidden\r\nContent-Length: 0\r\n\r\n");
      return;
    }
    const upstream = connect(target.port, target.host, () => {
      if (isConnect) {
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        const tunnelBytes = buffered.slice(headerEnd + 4);
        if (tunnelBytes.length > 0) upstream.write(tunnelBytes);
      } else {
        upstream.write(buffered);
      }
      clientSocket.pipe(upstream);
      upstream.pipe(clientSocket);
    });
    upstream.on("error", () => clientSocket.destroy());
  };
  clientSocket.on("data", onData);
  clientSocket.on("error", () => clientSocket.destroy());
}
function startProxyServer(allowlist) {
  return new Promise((resolveStart, rejectStart) => {
    const server = createServer((socket) => handleConnection(socket, allowlist));
    server.on("error", rejectStart);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        rejectStart(new Error("Failed to bind network containment proxy to a loopback port"));
        return;
      }
      resolveStart({
        port: address.port,
        close: () => new Promise((resolveClose) => server.close(() => resolveClose()))
      });
    });
  });
}
const proxyCache = /* @__PURE__ */ new Map();
function getNetworkContainmentProxy(allowlist) {
  const key = JSON.stringify([...allowlist].map((host) => host.toLowerCase()).sort());
  let proxy = proxyCache.get(key);
  if (!proxy) {
    proxy = startProxyServer(allowlist);
    proxyCache.set(key, proxy);
  }
  return proxy;
}
const DEFAULT_TIMEOUT_MS = 3e4;
const DEFAULT_MAX_OUTPUT_BYTES = 2e4;
const ALLOWED_ENV_VARS = ["PATH", "HOME", "LANG"];
function allowlistedEnv() {
  const env = {};
  for (const key of ALLOWED_ENV_VARS) {
    const value = process.env[key];
    if (value !== void 0) env[key] = value;
  }
  return env;
}
async function networkContainmentEnv(networkAllowlist) {
  const proxy = await getNetworkContainmentProxy(networkAllowlist);
  const proxyUrl = `http://127.0.0.1:${proxy.port}`;
  return {
    HTTP_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    https_proxy: proxyUrl
  };
}
function truncateOutput(text, maxBytes) {
  const encoded = new TextEncoder().encode(text);
  if (encoded.length <= maxBytes) return text;
  const truncated = new TextDecoder("utf-8", { fatal: false }).decode(encoded.slice(0, maxBytes));
  return `${truncated}
… (truncated)`;
}
const runApprovedShellCommand = async (command, cwd, options = {}) => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
  const containmentEnv = await networkContainmentEnv(options.networkAllowlist ?? []);
  return new Promise((resolvePromise, reject) => {
    var _a, _b;
    const proc = spawn(command, {
      shell: true,
      cwd,
      env: { ...allowlistedEnv(), ...containmentEnv },
      detached: true,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let output = "";
    let timedOut = false;
    let settled = false;
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (proc.pid) process.kill(-proc.pid, "SIGKILL");
        else proc.kill("SIGKILL");
      } catch {
        proc.kill("SIGKILL");
      }
    }, timeoutMs);
    (_a = proc.stdout) == null ? void 0 : _a.on("data", (chunk) => {
      output += chunk.toString("utf-8");
    });
    (_b = proc.stderr) == null ? void 0 : _b.on("data", (chunk) => {
      output += chunk.toString("utf-8");
    });
    proc.on("error", (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(err);
    });
    proc.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise({
        output: truncateOutput(output, maxOutputBytes),
        exitCode: timedOut ? null : exitCode,
        timedOut
      });
    });
  });
};
function isEnoent(err) {
  return (err == null ? void 0 : err.code) === "ENOENT";
}
class NodeConfigStore {
  constructor(path) {
    __publicField(this, "queue", Promise.resolve());
    this.path = path;
  }
  async load() {
    let raw;
    try {
      raw = await readFile(this.path, "utf-8");
    } catch (err) {
      if (isEnoent(err)) return {};
      throw err;
    }
    try {
      return JSON.parse(raw);
    } catch {
      console.error(`Warning: ${this.path} is not valid JSON — ignoring it and falling back to defaults.`);
      return {};
    }
  }
  save(patch) {
    const task = this.queue.then(() => this.writePatch(patch));
    this.queue = task.catch(() => {
    });
    return task;
  }
  async writePatch(patch) {
    const existing = await this.load();
    const merged = { ...existing, ...patch };
    await mkdir(dirname(this.path), { recursive: true });
    const tempPath = `${this.path}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
    await writeFile(tempPath, JSON.stringify(merged, null, 2), "utf-8");
    await rename(tempPath, this.path);
  }
}
const DOCTOR_CHECK_TIMEOUT_MS = 3e3;
async function checkProxyHealth(proxyUrl) {
  const label = `proxy reachable (${proxyUrl}/health)`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), DOCTOR_CHECK_TIMEOUT_MS);
  try {
    const res = await fetch(`${proxyUrl}/health`, { signal: controller.signal });
    if (!res.ok) return { label, ok: false, detail: `HTTP ${res.status}` };
    const body = await res.json().catch(() => void 0);
    return (body == null ? void 0 : body.status) === "ok" ? { label, ok: true } : { label, ok: false, detail: "unexpected response body" };
  } catch (err) {
    const timedOut = err instanceof Error && err.name === "AbortError";
    return { label, ok: false, detail: timedOut ? "timed out" : err instanceof Error ? err.message : String(err) };
  } finally {
    clearTimeout(timeout);
  }
}
function checkClaudeCli(claudePath) {
  const label = `claude binary (${claudePath})`;
  return new Promise((resolvePromise) => {
    let settled = false;
    const proc = spawn(claudePath, ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
    const timeout = setTimeout(() => {
      if (settled) return;
      settled = true;
      proc.kill();
      resolvePromise({ label, ok: false, detail: "timed out" });
    }, DOCTOR_CHECK_TIMEOUT_MS);
    proc.on("error", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise({ label, ok: false, detail: "not found" });
    });
    proc.on("close", (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      resolvePromise({ label, ok: code === 0, detail: code === 0 ? void 0 : `exited with code ${code}` });
    });
  });
}
function checkMemoryHealth(status) {
  return memoryStatusChecks(status);
}
async function checkWorkspaceRoot(workspaceRoot) {
  const label = `workspace root exists (${workspaceRoot})`;
  try {
    const info = await stat(workspaceRoot);
    return info.isDirectory() ? { label, ok: true } : { label, ok: false, detail: "not a directory" };
  } catch {
    return { label, ok: false, detail: "not found" };
  }
}
async function checkDataDirWritable(backend, dataDir) {
  const label = `data dir writable (${dataDir})`;
  const probePath = join(dataDir, ".doctor-check");
  try {
    await backend.mkdir(dataDir);
    await backend.writeTextFile(probePath, "ok");
    await backend.removeFile(probePath);
    return { label, ok: true };
  } catch (err) {
    return { label, ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}
function resolveNonInteractiveApprovalMode(env) {
  const raw = env.ASSISTANT_NON_INTERACTIVE_APPROVAL;
  if (raw === void 0) return void 0;
  if (raw === "decline" || raw === "require-tty") return raw;
  console.error(`[warning] ASSISTANT_NON_INTERACTIVE_APPROVAL="${raw}" is not "decline" or "require-tty" — ignoring.`);
  return void 0;
}
var Te = Object.defineProperty;
var In = (e, n, t) => n in e ? Te(e, n, { enumerable: true, configurable: true, writable: true, value: t }) : e[n] = t;
var Sn = (e, n) => {
  for (var t in n) Te(e, t, { get: n[t], enumerable: true });
};
var je = (e, n, t) => In(e, n + "", t);
var ie = {};
Sn(ie, { Graph: () => T, alg: () => H });
var Mn = Object.defineProperty, Se = (e, n) => {
  for (var t in n) Mn(e, t, { get: n[t], enumerable: true });
}, Q = class {
  constructor(e) {
    this._isDirected = true, this._isMultigraph = false, this._isCompound = false, this._nodes = {}, this._in = {}, this._preds = {}, this._out = {}, this._sucs = {}, this._edgeObjs = {}, this._edgeLabels = {}, this._nodeCount = 0, this._edgeCount = 0, this._defaultNodeLabelFn = () => {
    }, this._defaultEdgeLabelFn = () => {
    }, e && (this._isDirected = "directed" in e ? e.directed : true, this._isMultigraph = "multigraph" in e ? e.multigraph : false, this._isCompound = "compound" in e ? e.compound : false), this._isCompound && (this._parent = {}, this._children = {}, this._children["\0"] = {});
  }
  isDirected() {
    return this._isDirected;
  }
  isMultigraph() {
    return this._isMultigraph;
  }
  isCompound() {
    return this._isCompound;
  }
  setGraph(e) {
    return this._label = e, this;
  }
  graph() {
    return this._label;
  }
  setDefaultNodeLabel(e) {
    return typeof e != "function" ? this._defaultNodeLabelFn = () => e : this._defaultNodeLabelFn = e, this;
  }
  nodeCount() {
    return this._nodeCount;
  }
  nodes() {
    return Object.keys(this._nodes);
  }
  sources() {
    return this.nodes().filter((e) => Object.keys(this._in[e]).length === 0);
  }
  sinks() {
    return this.nodes().filter((e) => Object.keys(this._out[e]).length === 0);
  }
  setNodes(e, n) {
    return e.forEach((t) => {
      n !== void 0 ? this.setNode(t, n) : this.setNode(t);
    }), this;
  }
  setNode(e, n) {
    return e in this._nodes ? (arguments.length > 1 && (this._nodes[e] = n), this) : (this._nodes[e] = arguments.length > 1 ? n : this._defaultNodeLabelFn(e), this._isCompound && (this._parent[e] = "\0", this._children[e] = {}, this._children["\0"][e] = true), this._in[e] = {}, this._preds[e] = {}, this._out[e] = {}, this._sucs[e] = {}, ++this._nodeCount, this);
  }
  node(e) {
    return this._nodes[e];
  }
  hasNode(e) {
    return e in this._nodes;
  }
  removeNode(e) {
    if (e in this._nodes) {
      let n = (t) => this.removeEdge(this._edgeObjs[t]);
      delete this._nodes[e], this._isCompound && (this._removeFromParentsChildList(e), delete this._parent[e], this.children(e).forEach((t) => {
        this.setParent(t);
      }), delete this._children[e]), Object.keys(this._in[e]).forEach(n), delete this._in[e], delete this._preds[e], Object.keys(this._out[e]).forEach(n), delete this._out[e], delete this._sucs[e], --this._nodeCount;
    }
    return this;
  }
  setParent(e, n) {
    if (!this._isCompound) throw new Error("Cannot set parent in a non-compound graph");
    if (n === void 0) n = "\0";
    else {
      n += "";
      for (let t = n; t !== void 0; t = this.parent(t)) if (t === e) throw new Error("Setting " + n + " as parent of " + e + " would create a cycle");
      this.setNode(n);
    }
    return this.setNode(e), this._removeFromParentsChildList(e), this._parent[e] = n, this._children[n][e] = true, this;
  }
  parent(e) {
    if (this._isCompound) {
      let n = this._parent[e];
      if (n !== "\0") return n;
    }
  }
  children(e = "\0") {
    if (this._isCompound) {
      let n = this._children[e];
      if (n) return Object.keys(n);
    } else {
      if (e === "\0") return this.nodes();
      if (this.hasNode(e)) return [];
    }
    return [];
  }
  predecessors(e) {
    let n = this._preds[e];
    if (n) return Object.keys(n);
  }
  successors(e) {
    let n = this._sucs[e];
    if (n) return Object.keys(n);
  }
  neighbors(e) {
    let n = this.predecessors(e);
    if (n) {
      let t = new Set(n), r = this.successors(e);
      if (r) for (let o of r) t.add(o);
      return Array.from(t.values());
    }
  }
  isLeaf(e) {
    var n;
    let t;
    return this.isDirected() ? t = this.successors(e) : t = this.neighbors(e), ((n = t == null ? void 0 : t.length) != null ? n : 0) === 0;
  }
  filterNodes(e) {
    let n = new this.constructor({ directed: this._isDirected, multigraph: this._isMultigraph, compound: this._isCompound });
    n.setGraph(this.graph()), Object.entries(this._nodes).forEach(([o, i]) => {
      e(o) && n.setNode(o, i);
    }), Object.values(this._edgeObjs).forEach((o) => {
      n.hasNode(o.v) && n.hasNode(o.w) && n.setEdge(o, this.edge(o));
    });
    let t = {}, r = (o) => {
      let i = this.parent(o);
      return !i || n.hasNode(i) ? (t[o] = i, i) : i in t ? t[i] : r(i);
    };
    return this._isCompound && n.nodes().forEach((o) => n.setParent(o, r(o))), n;
  }
  setDefaultEdgeLabel(e) {
    return typeof e != "function" ? this._defaultEdgeLabelFn = () => e : this._defaultEdgeLabelFn = e, this;
  }
  edgeCount() {
    return this._edgeCount;
  }
  edges() {
    return Object.values(this._edgeObjs);
  }
  setPath(e, n) {
    return e.reduce((t, r) => (n !== void 0 ? this.setEdge(t, r, n) : this.setEdge(t, r), r)), this;
  }
  setEdge(e, n, t, r) {
    let o, i, s, a, l = false;
    typeof e == "object" && e !== null && "v" in e ? (o = e.v, i = e.w, s = e.name, arguments.length === 2 && (a = n, l = true)) : (o = e, i = n, s = r, arguments.length > 2 && (a = t, l = true)), o = "" + o, i = "" + i, s !== void 0 && (s = "" + s);
    let u = z(this._isDirected, o, i, s);
    if (u in this._edgeLabels) return l && (this._edgeLabels[u] = a), this;
    if (s !== void 0 && !this._isMultigraph) throw new Error("Cannot set a named edge when isMultigraph = false");
    this.setNode(o), this.setNode(i), this._edgeLabels[u] = l ? a : this._defaultEdgeLabelFn(o, i, s);
    let d = Pn(this._isDirected, o, i, s);
    return o = d.v, i = d.w, Object.freeze(d), this._edgeObjs[u] = d, Re(this._preds[i], o), Re(this._sucs[o], i), this._in[i][u] = d, this._out[o][u] = d, this._edgeCount++, this;
  }
  edge(e, n, t) {
    let r = arguments.length === 1 ? oe(this._isDirected, e) : z(this._isDirected, e, n, t);
    return this._edgeLabels[r];
  }
  edgeAsObj(e, n, t) {
    let r = arguments.length === 1 ? this.edge(e) : this.edge(e, n, t);
    return typeof r != "object" || r === null ? { label: r } : r;
  }
  hasEdge(e, n, t) {
    return (arguments.length === 1 ? oe(this._isDirected, e) : z(this._isDirected, e, n, t)) in this._edgeLabels;
  }
  removeEdge(e, n, t) {
    let r = arguments.length === 1 ? oe(this._isDirected, e) : z(this._isDirected, e, n, t), o = this._edgeObjs[r];
    if (o) {
      let i = o.v, s = o.w;
      delete this._edgeLabels[r], delete this._edgeObjs[r], Ie(this._preds[s], i), Ie(this._sucs[i], s), delete this._in[s][r], delete this._out[i][r], this._edgeCount--;
    }
    return this;
  }
  inEdges(e, n) {
    return this.isDirected() ? this.filterEdges(this._in[e], e, n) : this.nodeEdges(e, n);
  }
  outEdges(e, n) {
    return this.isDirected() ? this.filterEdges(this._out[e], e, n) : this.nodeEdges(e, n);
  }
  nodeEdges(e, n) {
    if (e in this._nodes) return this.filterEdges({ ...this._in[e], ...this._out[e] }, e, n);
  }
  _removeFromParentsChildList(e) {
    delete this._children[this._parent[e]][e];
  }
  filterEdges(e, n, t) {
    if (!e) return;
    let r = Object.values(e);
    return t ? r.filter((o) => o.v === n && o.w === t || o.v === t && o.w === n) : r;
  }
};
function Re(e, n) {
  e[n] ? e[n]++ : e[n] = 1;
}
function Ie(e, n) {
  e[n] !== void 0 && !--e[n] && delete e[n];
}
function z(e, n, t, r) {
  let o = "" + n, i = "" + t;
  if (!e && o > i) {
    let s = o;
    o = i, i = s;
  }
  return o + "" + i + "" + (r === void 0 ? "\0" : r);
}
function Pn(e, n, t, r) {
  let o = "" + n, i = "" + t;
  if (!e && o > i) {
    let a = o;
    o = i, i = a;
  }
  let s = { v: o, w: i };
  return r && (s.name = r), s;
}
function oe(e, n) {
  return z(e, n.v, n.w, n.name);
}
var Fn = {};
Se(Fn, { read: () => Yn, write: () => An });
function An(e) {
  let n = { options: { directed: e.isDirected(), multigraph: e.isMultigraph(), compound: e.isCompound() }, nodes: Vn(e), edges: Dn(e) }, t = e.graph();
  return t !== void 0 && (n.value = structuredClone(t)), n;
}
function Vn(e) {
  return e.nodes().map((n) => {
    let t = e.node(n), r = e.parent(n), o = { v: n };
    return t !== void 0 && (o.value = t), r !== void 0 && (o.parent = r), o;
  });
}
function Dn(e) {
  return e.edges().map((n) => {
    let t = e.edge(n), r = { v: n.v, w: n.w };
    return n.name !== void 0 && (r.name = n.name), t !== void 0 && (r.value = t), r;
  });
}
function Yn(e) {
  let n = new Q(e.options);
  return e.value !== void 0 && n.setGraph(e.value), e.nodes.forEach((t) => {
    n.setNode(t.v, t.value), t.parent && n.setParent(t.v, t.parent);
  }), e.edges.forEach((t) => {
    n.setEdge({ v: t.v, w: t.w, name: t.name }, t.value);
  }), n;
}
var H = {};
Se(H, { CycleException: () => K, bellmanFord: () => Me, components: () => Xn, dijkstra: () => J, dijkstraAll: () => qn, findCycles: () => $n, floydWarshall: () => Jn, isAcyclic: () => Qn, postorder: () => et, preorder: () => nt, prim: () => tt, shortestPaths: () => rt, tarjan: () => Fe, topsort: () => Ae });
var Wn = () => 1;
function Me(e, n, t, r) {
  return Bn(e, String(n), t || Wn, r || function(o) {
    var i;
    return (i = e.outEdges(o)) != null ? i : [];
  });
}
function Bn(e, n, t, r) {
  let o = {}, i, s = 0, a = e.nodes(), l = function(c) {
    let f = o[c.v], h = o[c.w];
    if (!f || !h) return;
    let p = t(c);
    f.distance + p < h.distance && (o[c.w] = { distance: f.distance + p, predecessor: c.v }, i = true);
  }, u = function() {
    a.forEach(function(c) {
      r(c).forEach(function(f) {
        let h = f.v === c ? f.v : f.w, p = h === f.v ? f.w : f.v;
        l({ v: h, w: p });
      });
    });
  };
  a.forEach(function(c) {
    let f = c === n ? 0 : Number.POSITIVE_INFINITY;
    o[c] = { distance: f, predecessor: "" };
  });
  let d = a.length;
  for (let c = 1; c < d && (i = false, s++, u(), !!i); c++) ;
  if (s === d - 1 && (i = false, u(), i)) throw new Error("The graph contains a negative weight cycle");
  return o;
}
function Xn(e) {
  let n = {}, t = [], r;
  function o(i) {
    var s, a;
    i in n || (n[i] = true, r.push(i), (s = e.successors(i)) == null || s.forEach(o), (a = e.predecessors(i)) == null || a.forEach(o));
  }
  return e.nodes().forEach(function(i) {
    r = [], o(i), r.length && t.push(r);
  }), t;
}
var Pe = class {
  constructor() {
    this._arr = [], this._keyIndices = {};
  }
  size() {
    return this._arr.length;
  }
  keys() {
    return this._arr.map((e) => e.key);
  }
  has(e) {
    return e in this._keyIndices;
  }
  priority(e) {
    let n = this._keyIndices[e];
    if (n !== void 0) return this._arr[n].priority;
  }
  min() {
    if (this.size() === 0) throw new Error("Queue underflow");
    return this._arr[0].key;
  }
  add(e, n) {
    let t = this._keyIndices, r = String(e);
    if (!(r in t)) {
      let o = this._arr, i = o.length;
      return t[r] = i, o.push({ key: r, priority: n }), this._decrease(i), true;
    }
    return false;
  }
  removeMin() {
    if (this.size() === 0) throw new Error("Queue underflow");
    this._swap(0, this._arr.length - 1);
    let e = this._arr.pop();
    return delete this._keyIndices[e.key], this._heapify(0), e.key;
  }
  decrease(e, n) {
    let t = this._keyIndices[e];
    if (t === void 0) throw new Error(`Key not found: ${e}`);
    let r = this._arr[t].priority;
    if (n > r) throw new Error(`New priority is greater than current priority. Key: ${e} Old: ${r} New: ${n}`);
    this._arr[t].priority = n, this._decrease(t);
  }
  _heapify(e) {
    let n = this._arr, t = 2 * e, r = t + 1, o = e;
    t < n.length && (o = n[t].priority < n[o].priority ? t : o, r < n.length && (o = n[r].priority < n[o].priority ? r : o), o !== e && (this._swap(e, o), this._heapify(o)));
  }
  _decrease(e) {
    let n = this._arr, t = n[e].priority, r;
    for (; e !== 0 && (r = e >> 1, !(n[r].priority < t)); ) this._swap(e, r), e = r;
  }
  _swap(e, n) {
    let t = this._arr, r = this._keyIndices, o = t[e], i = t[n];
    t[e] = i, t[n] = o, r[i.key] = e, r[o.key] = n;
  }
}, zn = () => 1;
function J(e, n, t, r) {
  let o = function(i) {
    var s;
    return (s = e.outEdges(i)) != null ? s : [];
  };
  return Hn(e, String(n), t || zn, r || o);
}
function Hn(e, n, t, r) {
  let o = {}, i = new Pe(), s, a, l = function(u) {
    let d = u.v !== s ? u.v : u.w, c = o[d];
    if (!c) return;
    let f = t(u), h = a.distance + f;
    if (f < 0) throw new Error("dijkstra does not allow negative edge weights. Bad edge: " + u + " Weight: " + f);
    h < c.distance && (c.distance = h, c.predecessor = s, i.decrease(d, h));
  };
  for (e.nodes().forEach(function(u) {
    let d = u === n ? 0 : Number.POSITIVE_INFINITY;
    o[u] = { distance: d, predecessor: "" }, i.add(u, d);
  }); i.size() > 0; ) {
    s = i.removeMin();
    let u = o[s];
    if (!u || u.distance === Number.POSITIVE_INFINITY) break;
    a = u, r(s).forEach(l);
  }
  return o;
}
function qn(e, n, t) {
  return e.nodes().reduce(function(r, o) {
    return r[o] = J(e, o, n, t), r;
  }, {});
}
function Fe(e) {
  let n = 0, t = [], r = {}, o = [];
  function i(s) {
    var a;
    let l = r[s] = { onStack: true, lowlink: n, index: n++ };
    if (t.push(s), (a = e.successors(s)) == null || a.forEach(function(u) {
      if (u in r) {
        let d = r[u];
        d != null && d.onStack && (l.lowlink = Math.min(l.lowlink, d.index));
      } else {
        i(u);
        let d = r[u];
        d && (l.lowlink = Math.min(l.lowlink, d.lowlink));
      }
    }), l.lowlink === l.index) {
      let u = [], d;
      do {
        d = t.pop();
        let c = r[d];
        c && (c.onStack = false), u.push(d);
      } while (s !== d);
      o.push(u);
    }
  }
  return e.nodes().forEach(function(s) {
    s in r || i(s);
  }), o;
}
function $n(e) {
  return Fe(e).filter(function(n) {
    var t;
    let r = n[0];
    return r ? n.length > 1 || n.length === 1 && ((t = e.outEdges(r, r)) != null ? t : []).length > 0 : false;
  });
}
var Un = () => 1;
function Jn(e, n, t) {
  return Kn(e, n || Un, t || function(r) {
    var o;
    return (o = e.outEdges(r)) != null ? o : [];
  });
}
function Kn(e, n, t) {
  let r = {}, o = e.nodes();
  return o.forEach(function(i) {
    let s = {};
    r[i] = s, s[i] = { distance: 0, predecessor: "" }, o.forEach(function(a) {
      i !== a && (s[a] = { distance: Number.POSITIVE_INFINITY, predecessor: "" });
    }), t(i).forEach(function(a) {
      let l = a.v === i ? a.w : a.v, u = n(a);
      s[l] = { distance: u, predecessor: i };
    });
  }), o.forEach(function(i) {
    let s = r[i];
    s && o.forEach(function(a) {
      let l = r[a];
      l && o.forEach(function(u) {
        let d = l[i], c = s[u], f = l[u];
        if (d && c && f) {
          let h = d.distance + c.distance;
          h < f.distance && (f.distance = h, f.predecessor = c.predecessor);
        }
      });
    });
  }), r;
}
var K = class extends Error {
  constructor(e) {
    super(e), this.name = "CycleException";
  }
};
function Ae(e) {
  let n = {}, t = {}, r = [];
  function o(i) {
    var s;
    if (i in t) throw new K();
    i in n || (t[i] = true, n[i] = true, (s = e.predecessors(i)) == null || s.forEach(o), delete t[i], r.push(i));
  }
  if (e.sinks().forEach(o), Object.keys(n).length !== e.nodeCount()) throw new K();
  return r;
}
function Qn(e) {
  try {
    Ae(e);
  } catch (n) {
    if (n instanceof K) return false;
    throw n;
  }
  return true;
}
function Zn(e, n, t, r, o) {
  Array.isArray(n) || (n = [n]);
  let i = (a) => {
    var l;
    return (l = e.isDirected() ? e.successors(a) : e.neighbors(a)) != null ? l : [];
  }, s = {};
  return n.forEach(function(a) {
    if (!e.hasNode(a)) throw new Error("Graph does not have node: " + a);
    o = Ve(e, a, t === "post", s, i, r, o);
  }), o;
}
function Ve(e, n, t, r, o, i, s) {
  return n in r || (r[n] = true, t || (s = i(s, n)), o(n).forEach(function(a) {
    s = Ve(e, a, t, r, o, i, s);
  }), t && (s = i(s, n))), s;
}
function De(e, n, t) {
  return Zn(e, n, t, function(r, o) {
    return r.push(o), r;
  }, []);
}
function et(e, n) {
  return De(e, n, "post");
}
function nt(e, n) {
  return De(e, n, "pre");
}
function tt(e, n) {
  var t;
  let r = new Q(), o = {}, i = new Pe(), s;
  function a(d) {
    let c = d.v === s ? d.w : d.v, f = i.priority(c);
    if (f !== void 0) {
      let h = n(d);
      h < f && (o[c] = s, i.decrease(c, h));
    }
  }
  if (e.nodeCount() === 0) return r;
  e.nodes().forEach(function(d) {
    i.add(d, Number.POSITIVE_INFINITY), r.setNode(d);
  });
  let l = e.nodes()[0];
  l !== void 0 && i.decrease(l, 0);
  let u = false;
  for (; i.size() > 0; ) {
    if (s = i.removeMin(), s in o) r.setEdge(s, o[s]);
    else {
      if (u) throw new Error("Input graph is not connected: " + e);
      u = true;
    }
    (t = e.nodeEdges(s)) == null || t.forEach(a);
  }
  return r;
}
function rt(e, n, t, r) {
  return ot(e, n, t, r != null ? r : (o) => {
    var i;
    return (i = e.outEdges(o)) != null ? i : [];
  });
}
function ot(e, n, t, r) {
  if (t === void 0) return J(e, n, t, r);
  let o = false, i = e.nodes();
  for (let s = 0; s < i.length; s++) {
    let a = i[s];
    if (a === void 0) continue;
    let l = r(a);
    for (let u = 0; u < l.length; u++) {
      let d = l[u];
      if (!d) continue;
      let c = d.v === a ? d.v : d.w, f = c === d.v ? d.w : d.v;
      t({ v: c, w: f }) < 0 && (o = true);
    }
    if (o) return Me(e, n, t, r);
  }
  return J(e, n, t, r);
}
var T = Q;
function M(e, n, t, r) {
  let o = r;
  for (; e.hasNode(o); ) o = $(r);
  return t.dummy = n, e.setNode(o, t), o;
}
function Ye(e) {
  let n = new T().setGraph(e.graph());
  return e.nodes().forEach((t) => n.setNode(t, e.node(t))), e.edges().forEach((t) => {
    let r = n.edge(t.v, t.w) || { weight: 0, minlen: 1 }, o = e.edge(t);
    n.setEdge(t.v, t.w, { weight: r.weight + o.weight, minlen: Math.max(r.minlen, o.minlen) });
  }), n;
}
function Z(e) {
  let n = new T({ multigraph: e.isMultigraph() }).setGraph(e.graph());
  return e.nodes().forEach((t) => {
    e.children(t).length || n.setNode(t, e.node(t));
  }), e.edges().forEach((t) => {
    n.setEdge(t, e.edge(t));
  }), n;
}
function se(e, n) {
  let t = e.x, r = e.y, o = n.x - t, i = n.y - r, s = e.width / 2, a = e.height / 2;
  if (!o && !i) throw new Error("Not possible to find intersection inside of the rectangle");
  let l, u;
  return Math.abs(i) * s > Math.abs(o) * a ? (i < 0 && (a = -a), l = a * o / i, u = a) : (o < 0 && (s = -s), l = s, u = s * i / o), { x: t + l, y: r + u };
}
function P(e) {
  let n = A(de(e) + 1).map(() => []);
  return e.nodes().forEach((t) => {
    let r = e.node(t), o = r.rank;
    o !== void 0 && (n[o] || (n[o] = []), n[o][r.order] = t);
  }), n;
}
function We(e) {
  let n = e.nodes().map((r) => {
    let o = e.node(r).rank;
    return o === void 0 ? Number.MAX_VALUE : o;
  }), t = R$1(Math.min, n);
  e.nodes().forEach((r) => {
    let o = e.node(r);
    Object.hasOwn(o, "rank") && (o.rank -= t);
  });
}
function Be(e) {
  let n = e.nodes().map((s) => e.node(s).rank).filter((s) => s !== void 0), t = R$1(Math.min, n), r = [];
  e.nodes().forEach((s) => {
    let a = e.node(s).rank - t;
    r[a] || (r[a] = []), r[a].push(s);
  });
  let o = 0, i = e.graph().nodeRankFactor;
  Array.from(r).forEach((s, a) => {
    s === void 0 && a % i !== 0 ? --o : s !== void 0 && o && s.forEach((l) => e.node(l).rank += o);
  });
}
function ae(e, n, t, r) {
  let o = { width: 0, height: 0 };
  return arguments.length >= 4 && (o.rank = t, o.order = r), M(e, "border", o, n);
}
function it(e, n = Xe) {
  let t = [];
  for (let r = 0; r < e.length; r += n) {
    let o = e.slice(r, r + n);
    t.push(o);
  }
  return t;
}
var Xe = 65535;
function R$1(e, n) {
  if (n.length > Xe) {
    let t = it(n);
    return e(...t.map((r) => e(...r)));
  } else return e(...n);
}
function de(e) {
  let t = e.nodes().map((r) => {
    let o = e.node(r).rank;
    return o === void 0 ? Number.MIN_VALUE : o;
  });
  return R$1(Math.max, t);
}
function ze(e, n) {
  let t = { lhs: [], rhs: [] };
  return e.forEach((r) => {
    n(r) ? t.lhs.push(r) : t.rhs.push(r);
  }), t;
}
function le(e, n) {
  let t = Date.now();
  try {
    return n();
  } finally {
    console.log(e + " time: " + (Date.now() - t) + "ms");
  }
}
function q(e, n) {
  return n();
}
var st = 0;
function $(e) {
  let n = ++st;
  return e + ("" + n);
}
function A(e, n, t = 1) {
  n == null && (n = e, e = 0);
  let r = (i) => i < n;
  t < 0 && (r = (i) => n < i);
  let o = [];
  for (let i = e; r(i); i += t) o.push(i);
  return o;
}
function B(e, n) {
  let t = {};
  for (let r of n) e[r] !== void 0 && (t[r] = e[r]);
  return t;
}
function X(e, n) {
  let t;
  return typeof n == "string" ? t = (r) => r[n] : t = n, Object.entries(e).reduce((r, [o, i]) => (r[o] = t(i, o), r), {});
}
function He(e, n) {
  return e.reduce((t, r, o) => (t[r] = n[o], t), {});
}
var D$1 = "\0";
function ee(e, n, t) {
  var u, d, c, f, h, p;
  if (!(e && n && t && n.dummy === "edge" && t.dummy === "edge" && n.edgeObj && t.edgeObj && e[n.edgeObj.v] && e[t.edgeObj.v] && e[n.edgeObj.w] && e[t.edgeObj.w])) return 0;
  let r = true;
  n.edgeObj.w === t.edgeObj.w && (r = false);
  let o = r ? (d = (u = e[n.edgeObj.v]) == null ? void 0 : u.rank) != null ? d : NaN + 1 : (f = (c = e[n.edgeObj.w]) == null ? void 0 : c.rank) != null ? f : NaN - 1, i = Object.entries(e).find((E) => {
    var y, L2;
    return ((y = E[1].edgeObj) == null ? void 0 : y.v) === n.edgeObj.v && ((L2 = E[1].edgeObj) == null ? void 0 : L2.w) === n.edgeObj.w && E[1].rank === o;
  }), s = Object.entries(e).find((E) => {
    var y, L2;
    return ((y = E[1].edgeObj) == null ? void 0 : y.v) === t.edgeObj.v && ((L2 = E[1].edgeObj) == null ? void 0 : L2.w) === t.edgeObj.w && E[1].rank === o;
  });
  if (!i || !s) return 0;
  let a = (h = i[1].order) != null ? h : NaN, l = (p = s[1].order) != null ? p : NaN;
  return isNaN(a - l) ? 0 : a - l;
}
var ue = "3.1.1";
var ce = class {
  constructor() {
    je(this, "_sentinel");
    let n = {};
    n._next = n._prev = n, this._sentinel = n;
  }
  dequeue() {
    let n = this._sentinel, t = n._prev;
    if (t !== n) return qe(t), t;
  }
  enqueue(n) {
    let t = this._sentinel;
    n._prev && n._next && qe(n), n._next = t._next, t._next._prev = n, t._next = n, n._prev = t;
  }
  toString() {
    let n = [], t = this._sentinel, r = t._prev;
    for (; r !== t; ) n.push(JSON.stringify(r, at)), r = r._prev;
    return "[" + n.join(", ") + "]";
  }
};
function qe(e) {
  e._prev._next = e._next, e._next._prev = e._prev, delete e._next, delete e._prev;
}
function at(e, n) {
  if (e !== "_next" && e !== "_prev") return n;
}
var $e = ce;
var dt = () => 1;
function be(e, n) {
  if (e.nodeCount() <= 1) return [];
  let t = ut(e, n || dt);
  return lt(t.graph, t.buckets, t.zeroIdx).flatMap((o) => e.outEdges(o.v, o.w) || []);
}
function lt(e, n, t) {
  var a;
  let r = [], o = n[n.length - 1], i = n[0], s;
  for (; e.nodeCount(); ) {
    for (; s = i.dequeue(); ) fe(e, n, t, s);
    for (; s = o.dequeue(); ) fe(e, n, t, s);
    if (e.nodeCount()) {
      for (let l = n.length - 2; l > 0; --l) if (s = (a = n[l]) == null ? void 0 : a.dequeue(), s) {
        r = r.concat(fe(e, n, t, s, true) || []);
        break;
      }
    }
  }
  return r;
}
function fe(e, n, t, r, o) {
  let i = [], s = o ? i : void 0;
  return (e.inEdges(r.v) || []).forEach((a) => {
    let l = e.edge(a), u = e.node(a.v);
    o && i.push({ v: a.v, w: a.w }), u.out -= l, he(n, t, u);
  }), (e.outEdges(r.v) || []).forEach((a) => {
    let l = e.edge(a), u = a.w, d = e.node(u);
    d.in -= l, he(n, t, d);
  }), e.removeNode(r.v), s;
}
function ut(e, n) {
  let t = new T(), r = 0, o = 0;
  e.nodes().forEach((a) => {
    t.setNode(a, { v: a, in: 0, out: 0 });
  }), e.edges().forEach((a) => {
    let l = t.edge(a.v, a.w) || 0, u = n(a), d = l + u;
    t.setEdge(a.v, a.w, d);
    let c = t.node(a.v), f = t.node(a.w);
    o = Math.max(o, c.out += u), r = Math.max(r, f.in += u);
  });
  let i = ct(o + r + 3).map(() => new $e()), s = r + 1;
  return t.nodes().forEach((a) => {
    he(i, s, t.node(a));
  }), { graph: t, buckets: i, zeroIdx: s };
}
function he(e, n, t) {
  var r, o, i;
  t.out ? t.in ? (i = e[t.out - t.in + n]) == null || i.enqueue(t) : (o = e[e.length - 1]) == null || o.enqueue(t) : (r = e[0]) == null || r.enqueue(t);
}
function ct(e) {
  let n = [];
  for (let t = 0; t < e; t++) n.push(t);
  return n;
}
function Ue(e, n) {
  (e.graph().acyclicer === "greedy" ? be(e, r(e)) : ft(e, n != null ? n : null)).forEach((o) => {
    let i = e.edge(o);
    e.removeEdge(o), i.forwardName = o.name, i.reversed = true, e.setEdge(o.w, o.v, i, $("rev"));
  });
  function r(o) {
    return (i) => o.edge(i).weight;
  }
}
function ft(e, n) {
  let t = [], r = {}, o = {};
  function i(l) {
    Object.hasOwn(o, l) || (o[l] = true, r[l] = true, e.outEdges(l).forEach((u) => {
      Object.hasOwn(r, u.w) ? t.push(u) : i(u.w);
    }), delete r[l]);
  }
  function s(l) {
    var u;
    Object.hasOwn(o, l) || (o[l] = true, r[l] = true, (u = e.outEdges(l)) == null || u.forEach((d) => {
      var c, f;
      Object.hasOwn(r, d.w) || ((c = n.node(l)) == null ? void 0 : c.rank) > ((f = n.node(d.w)) == null ? void 0 : f.rank) && ht(e, d.w, d) ? t.push(d) : s(d.w);
    }), delete r[l]);
  }
  let a = i;
  return n && typeof n.node == "function" && (a = s), e.sources().forEach(a), e.nodes().forEach(a), t;
}
function Je(e) {
  e.edges().forEach((n) => {
    let t = e.edge(n);
    if (t.reversed) {
      e.removeEdge(n);
      let r = t.forwardName;
      delete t.reversed, delete t.forwardName, e.setEdge(n.w, n.v, t, r);
    }
  });
}
function ht(e, n, t) {
  let r = /* @__PURE__ */ new Set();
  function o(i) {
    var s;
    if (e.sources().includes(i)) return true;
    r.add(i);
    for (let a of (s = e.inEdges(i)) != null ? s : []) if (!(a.v === t.v && a.w === t.w) && !r.has(a.v) && o(a.v)) return true;
    return false;
  }
  return o(n);
}
function Ke(e) {
  e.graph().dummyChains = [], e.edges().forEach((n) => gt(e, n));
}
function gt(e, n) {
  let t = n.v, r = e.node(t).rank, o = n.w, i = e.node(o).rank, s = n.name, a = e.edge(n), l = a.labelRank;
  if (i === r + 1) return;
  e.removeEdge(n);
  let u, d, c;
  for (c = 0, ++r; r < i; ++c, ++r) a.points = [], d = { width: 0, height: 0, edgeLabel: a, edgeObj: n, rank: r }, u = M(e, "edge", d, "_d"), r === l && (d.width = a.width, d.height = a.height, d.dummy = "edge-label", d.labelpos = a.labelpos), e.setEdge(t, u, { weight: a.weight }, s), c === 0 && e.graph().dummyChains.push(u), t = u;
  e.setEdge(t, o, { weight: a.weight }, s);
}
function Qe(e) {
  e.graph().dummyChains.forEach((n) => {
    let t = e.node(n), r = t.edgeLabel, o;
    for (e.setEdge(t.edgeObj, r); t.dummy; ) o = e.successors(n)[0], e.removeNode(n), r.points.push({ x: t.x, y: t.y }), t.dummy === "edge-label" && (r.x = t.x, r.y = t.y, r.width = t.width, r.height = t.height), n = o, t = e.node(n);
  });
}
function U$1(e) {
  let n = {};
  function t(r) {
    let o = e.node(r);
    if (Object.hasOwn(n, r)) return o.rank;
    n[r] = true;
    let i = e.outEdges(r), s = i ? i.map((l) => l == null ? Number.POSITIVE_INFINITY : t(l.w) - e.edge(l).minlen) : [], a = R$1(Math.min, s);
    return a === Number.POSITIVE_INFINITY && (a = 0), o.rank = a;
  }
  e.sources().forEach(t);
}
function V(e, n) {
  return e.node(n.w).rank - e.node(n.v).rank - e.edge(n).minlen;
}
var ne = mt;
function mt(e) {
  let n = new T({ directed: false }), t = e.nodes();
  if (t.length === 0) throw new Error("Graph must have at least one node");
  let r = t[0], o = e.nodeCount();
  n.setNode(r, {});
  let i, s;
  for (; Et(n, e) < o && (i = Lt(n, e), !!i); ) s = n.hasNode(i.v) ? V(e, i) : -V(e, i), yt(n, e, s);
  return n;
}
function Et(e, n) {
  function t(r) {
    let o = n.nodeEdges(r);
    o && o.forEach((i) => {
      let s = i.v, a = r === s ? i.w : s;
      !e.hasNode(a) && !V(n, i) && (e.setNode(a, {}), e.setEdge(r, a, {}), t(a));
    });
  }
  return e.nodes().forEach(t), e.nodeCount();
}
function Lt(e, n) {
  return n.edges().reduce((r, o) => {
    let i = Number.POSITIVE_INFINITY;
    return e.hasNode(o.v) !== e.hasNode(o.w) && (i = V(n, o)), i < r[0] ? [i, o] : r;
  }, [Number.POSITIVE_INFINITY, null])[1];
}
function yt(e, n, t) {
  e.nodes().forEach((r) => n.node(r).rank += t);
}
var { preorder: wt, postorder: Nt } = H, en = Y;
Y.initLowLimValues = pe;
Y.initCutValues = ge;
Y.calcCutValue = nn;
Y.leaveEdge = rn;
Y.enterEdge = on;
Y.exchangeEdges = sn;
function Y(e) {
  e = Ye(e), U$1(e);
  let n = ne(e);
  pe(n), ge(n, e);
  let t, r;
  for (; t = rn(n); ) r = on(n, e, t), sn(n, e, t, r);
}
function ge(e, n) {
  let t = Nt(e, e.nodes());
  t = t.slice(0, t.length - 1), t.forEach((r) => Gt(e, n, r));
}
function Gt(e, n, t) {
  let o = e.node(t).parent, i = e.edge(t, o);
  i.cutvalue = nn(e, n, t);
}
function nn(e, n, t) {
  let o = e.node(t).parent, i = true, s = n.edge(t, o), a = 0;
  s || (i = false, s = n.edge(o, t)), a = s.weight;
  let l = n.nodeEdges(t);
  return l && l.forEach((u) => {
    let d = u.v === t, c = d ? u.w : u.v;
    if (c !== o) {
      let f = d === i, h = n.edge(u).weight;
      if (a += f ? h : -h, kt(e, t, c)) {
        let E = e.edge(t, c).cutvalue;
        a += f ? -E : E;
      }
    }
  }), a;
}
function pe(e, n) {
  arguments.length < 2 && (n = e.nodes()[0]), tn(e, {}, 1, n);
}
function tn(e, n, t, r, o) {
  let i = t, s = e.node(r);
  n[r] = true;
  let a = e.neighbors(r);
  return a && a.forEach((l) => {
    Object.hasOwn(n, l) || (t = tn(e, n, t, l, r));
  }), s.low = i, s.lim = t++, o ? s.parent = o : delete s.parent, t;
}
function rn(e) {
  return e.edges().find((n) => e.edge(n).cutvalue < 0);
}
function on(e, n, t) {
  let r = t.v, o = t.w;
  n.hasEdge(r, o) || (r = t.w, o = t.v);
  let i = e.node(r), s = e.node(o), a = i, l = false;
  return i.lim > s.lim && (a = s, l = true), n.edges().filter((d) => l === Ze(e, e.node(d.v), a) && l !== Ze(e, e.node(d.w), a)).reduce((d, c) => V(n, c) < V(n, d) ? c : d);
}
function sn(e, n, t, r) {
  let o = t.v, i = t.w;
  e.removeEdge(o, i), e.setEdge(r.v, r.w, {}), pe(e), ge(e, n), vt(e, n);
}
function vt(e, n) {
  let t = e.nodes().find((o) => !e.node(o).parent);
  if (!t) return;
  let r = wt(e, [t]);
  r = r.slice(1), r.forEach((o) => {
    let s = e.node(o).parent, a = n.edge(o, s), l = false;
    a || (a = n.edge(s, o), l = true), n.node(o).rank = n.node(s).rank + (l ? a.minlen : -a.minlen);
  });
}
function kt(e, n, t) {
  return e.hasEdge(n, t);
}
function Ze(e, n, t) {
  return t.low <= n.lim && n.lim <= t.lim;
}
var dn = xt;
function xt(e) {
  let n = e.graph().ranker;
  if (typeof n == "function") return n(e);
  switch (n) {
    case "network-simplex":
      an(e);
      break;
    case "tight-tree":
      Ot(e);
      break;
    case "longest-path":
      _t(e);
      break;
    case "none":
      break;
    default:
      an(e);
  }
}
var _t = U$1;
function Ot(e) {
  U$1(e), ne(e);
}
function an(e) {
  en(e);
}
var ln = Ct;
function Ct(e) {
  let n = jt(e), t = e.graph();
  if (!Array.isArray(t.dummyChains)) return;
  t.dummyChains.forEach((o) => {
    let i = e.node(o), s = i.edgeObj, a = Tt(e, n, s.v, s.w), l = a.path, u = a.lca, d = 0, c = l[d], f = true;
    for (; o !== s.w; ) {
      if (i = e.node(o), f) {
        for (; (c = l[d]) !== u && e.node(c).maxRank < i.rank; ) d++;
        c === u && (f = false);
      }
      if (!f) {
        for (; d < l.length - 1 && e.node(l[d + 1]).minRank <= i.rank; ) d++;
        c = l[d];
      }
      c !== void 0 && e.setParent(o, c), o = e.successors(o)[0];
    }
  });
}
function Tt(e, n, t, r) {
  let o = [], i = [], s = Math.min(n[t].low, n[r].low), a = Math.max(n[t].lim, n[r].lim), l;
  l = t;
  do
    l = e.parent(l), o.push(l);
  while (l && (n[l].low > s || a > n[l].lim));
  let u = l, d = r;
  for (; (d = e.parent(d)) !== u; ) i.push(d);
  return { path: o.concat(i.reverse()), lca: u };
}
function jt(e) {
  let n = {}, t = 0;
  function r(o) {
    let i = t;
    e.children(o).forEach(r), n[o] = { low: i, lim: t++ };
  }
  return e.children(D$1).forEach(r), n;
}
function un(e) {
  let n = M(e, "root", {}, "_root"), t = Rt(e), r = Object.values(t), o = R$1(Math.max, r) - 1, i = 2 * o + 1;
  e.graph().nestingRoot = n, e.edges().forEach((a) => e.edge(a).minlen *= i);
  let s = It(e) + 1;
  e.children(D$1).forEach((a) => {
    cn(e, n, i, s, o, t, a);
  }), e.graph().nodeRankFactor = i;
}
function cn(e, n, t, r, o, i, s) {
  var c;
  let a = e.children(s);
  if (!a.length) {
    s !== n && e.setEdge(n, s, { weight: 0, minlen: t });
    return;
  }
  let l = ae(e, "_bt"), u = ae(e, "_bb"), d = e.node(s);
  e.setParent(l, s), d.borderTop = l, e.setParent(u, s), d.borderBottom = u, a.forEach((f) => {
    var b;
    cn(e, n, t, r, o, i, f);
    let h = e.node(f), p = h.borderTop ? h.borderTop : f, E = h.borderBottom ? h.borderBottom : f, y = h.borderTop ? r : 2 * r, L2 = p !== E ? 1 : o - ((b = i[s]) != null ? b : 0) + 1;
    e.setEdge(l, p, { weight: y, minlen: L2, nestingEdge: true }), e.setEdge(E, u, { weight: y, minlen: L2, nestingEdge: true });
  }), e.parent(s) || e.setEdge(n, l, { weight: 0, minlen: o + ((c = i[s]) != null ? c : 0) });
}
function Rt(e) {
  let n = {};
  function t(r, o) {
    let i = e.children(r);
    i && i.length && i.forEach((s) => t(s, o + 1)), n[r] = o;
  }
  return e.children(D$1).forEach((r) => t(r, 1)), n;
}
function It(e) {
  return e.edges().reduce((n, t) => n + e.edge(t).weight, 0);
}
function fn(e) {
  let n = e.graph();
  e.removeNode(n.nestingRoot), delete n.nestingRoot, e.edges().forEach((t) => {
    e.edge(t).nestingEdge && e.removeEdge(t);
  });
}
var bn = Mt;
function Mt(e) {
  function n(t) {
    let r = e.children(t), o = e.node(t);
    if (r.length && r.forEach(n), o && Object.hasOwn(o, "minRank")) {
      o.borderLeft = [], o.borderRight = [];
      for (let i = o.minRank, s = o.maxRank + 1; i < s; ++i) hn(e, "borderLeft", "_bl", t, o, i), hn(e, "borderRight", "_br", t, o, i);
    }
  }
  e.children(D$1).forEach(n);
}
function hn(e, n, t, r, o, i) {
  let s = { width: 0, height: 0, rank: i, borderType: n }, a = o[n][i - 1], l = M(e, "border", s, t);
  o[n][i] = l, e.setParent(l, r), a && e.setEdge(a, l, { weight: 1 });
}
function pn(e) {
  var t;
  let n = (t = e.graph().rankdir) == null ? void 0 : t.toLowerCase();
  (n === "lr" || n === "rl") && En(e);
}
function mn(e) {
  var t;
  let n = (t = e.graph().rankdir) == null ? void 0 : t.toLowerCase();
  (n === "bt" || n === "rl") && Pt(e), (n === "lr" || n === "rl") && (Ft(e), En(e));
}
function En(e) {
  e.nodes().forEach((n) => gn(e.node(n))), e.edges().forEach((n) => gn(e.edge(n)));
}
function gn(e) {
  let n = e.width;
  e.width = e.height, e.height = n;
}
function Pt(e) {
  e.nodes().forEach((n) => me(e.node(n))), e.edges().forEach((n) => {
    var r;
    let t = e.edge(n);
    (r = t.points) == null || r.forEach(me), Object.hasOwn(t, "y") && me(t);
  });
}
function me(e) {
  e.y = -e.y;
}
function Ft(e) {
  e.nodes().forEach((n) => Ee(e.node(n))), e.edges().forEach((n) => {
    var r;
    let t = e.edge(n);
    (r = t.points) == null || r.forEach(Ee), Object.hasOwn(t, "x") && Ee(t);
  });
}
function Ee(e) {
  let n = e.x;
  e.x = e.y, e.y = n;
}
function Le(e, n = null) {
  let t = {}, r = e.nodes().filter((d) => !e.children(d).length), o = r.map((d) => e.node(d).rank), i = R$1(Math.max, o), s = A(i + 1).map(() => []);
  function a(d) {
    if (t[d]) return;
    t[d] = true;
    let c = e.node(d);
    s[c.rank].push(d);
    let f = e.successors(d);
    f && [...f].sort((p, E) => u(p, E)).forEach(a);
  }
  r.sort((d, c) => e.node(d).rank - e.node(c).rank).forEach(a);
  function u(d, c) {
    let f = e.node(d), h = e.node(c);
    return ee(n, f, h);
  }
  return s;
}
function ye(e, n) {
  let t = 0;
  for (let r = 1; r < n.length; ++r) t += Vt(e, n[r - 1], n[r]);
  return t;
}
function Vt(e, n, t) {
  let r = He(t, t.map((u, d) => d)), o = n.flatMap((u) => {
    let d = e.outEdges(u);
    return d ? d.map((c) => ({ pos: r[c.w], weight: e.edge(c).weight })).sort((c, f) => c.pos - f.pos) : [];
  }), i = 1;
  for (; i < t.length; ) i <<= 1;
  let s = 2 * i - 1;
  i -= 1;
  let a = new Array(s).fill(0), l = 0;
  return o.forEach((u) => {
    let d = u.pos + i;
    a[d] += u.weight;
    let c = 0;
    for (; d > 0; ) d % 2 && (c += a[d + 1]), d = d - 1 >> 1, a[d] += u.weight;
    l += u.weight * c;
  }), l;
}
function we(e, n = []) {
  return n.map((t) => {
    let r = e.inEdges(t);
    if (!r || !r.length) return { v: t };
    {
      let o = r.reduce((i, s) => {
        let a = e.edge(s), l = e.node(s.v);
        return { sum: i.sum + a.weight * l.order, weight: i.weight + a.weight };
      }, { sum: 0, weight: 0 });
      return { v: t, barycenter: o.sum / o.weight, weight: o.weight };
    }
  });
}
function Ne(e, n) {
  let t = {};
  e.forEach((o, i) => {
    let s = { indegree: 0, in: [], out: [], vs: [o.v], i };
    o.barycenter !== void 0 && (s.barycenter = o.barycenter, s.weight = o.weight), t[o.v] = s;
  }), n.edges().forEach((o) => {
    let i = t[o.v], s = t[o.w];
    i !== void 0 && s !== void 0 && (s.indegree++, i.out.push(s));
  });
  let r = Object.values(t).filter((o) => !o.indegree);
  return Dt(r);
}
function Dt(e) {
  let n = [];
  function t(o) {
    return (i) => {
      i.merged || (i.barycenter === void 0 || o.barycenter === void 0 || i.barycenter >= o.barycenter) && Yt(o, i);
    };
  }
  function r(o) {
    return (i) => {
      i.in.push(o), --i.indegree === 0 && e.push(i);
    };
  }
  for (; e.length; ) {
    let o = e.pop();
    n.push(o), o.in.reverse().forEach(t(o)), o.out.forEach(r(o));
  }
  return n.filter((o) => !o.merged).map((o) => B(o, ["vs", "i", "barycenter", "weight"]));
}
function Yt(e, n) {
  let t = 0, r = 0;
  e.weight && (t += e.barycenter * e.weight, r += e.weight), n.weight && (t += n.barycenter * n.weight, r += n.weight), e.vs = n.vs.concat(e.vs), e.barycenter = t / r, e.weight = r, e.i = Math.min(n.i, e.i), n.merged = true;
}
function Ge(e, n, t, r, o) {
  let i = {}, s = null, a = null, l = o;
  typeof n == "boolean" ? (l = n, i = {}) : n && (i = n, s = t != null ? t : null, a = r != null ? r : null);
  let u = ze(e, (L2) => Object.hasOwn(L2, "barycenter")), d = u.lhs, c = u.rhs.sort((L2, b) => b.i - L2.i), f = [], h = 0, p = 0, E = 0;
  d.sort(Wt(a, s, !!l));
  for (let [L2, b] of Object.entries(i)) {
    let g = d.findIndex((m) => m.vs[0] === L2);
    d.splice(g + 1, 0, b);
  }
  E = Ln(f, c, E), d.forEach((L2) => {
    E += L2.vs.length, f.push(L2.vs), h += L2.barycenter * L2.weight, p += L2.weight, E = Ln(f, c, E);
  });
  let y = { vs: f.flat(1) };
  return p && (y.barycenter = h / p, y.weight = p), y;
}
function Ln(e, n, t) {
  let r;
  for (; n.length && (r = n[n.length - 1]).i <= t; ) n.pop(), e.push(r.vs), t++;
  return t;
}
function Wt(e, n, t) {
  return (r, o) => {
    if (r.barycenter < o.barycenter) return -1;
    if (r.barycenter > o.barycenter) return 1;
    if (e && (typeof r.vs[0] == "string" || typeof o.vs[0] == "string")) {
      let i = e.node(r.vs[0]), s = e.node(o.vs[0]), a = ee(n, i, s);
      if (a !== 0) return a;
    }
    return t ? o.i - r.i : r.i - o.i;
  };
}
function te(e, n, t, r, o) {
  var L2, b, g, m, w, k, _, C, j, I, S;
  let i = null, s = o;
  typeof r == "boolean" ? (s = r, i = null) : r !== void 0 && (i = r);
  let a = e.children(n), l = e.node(n), u = l ? l.borderLeft : void 0, d = l ? l.borderRight : void 0, c = {};
  u && (a = a.filter((G) => G !== u && G !== d));
  let f = we(e, a);
  f.forEach((G) => {
    if (e.children(G.v).length) {
      let { result: x } = te(e, G.v, t, i, s);
      c[G.v] = x, Object.hasOwn(x, "barycenter") && Xt(G, x);
    }
  });
  let h = Ne(f, t);
  Bt(h, c);
  let p = {}, E = false;
  for (let G = 0; G < h.length; G++) for (let x = G + 1; x < h.length; x++) if (!(!h[G] || !h[x] || !((L2 = h[G]) != null && L2.barycenter) || !((b = h[x]) != null && b.barycenter)) && ((g = h[G]) == null ? void 0 : g.barycenter) === h[x].barycenter) {
    let v = (w = (m = h[G]) == null ? void 0 : m.vs[0]) != null ? w : "", N = (_ = (k = h[x]) == null ? void 0 : k.vs[0]) != null ? _ : "", O = e.node(v), W = e.node(N);
    if (O.dummy === "edge" && W.dummy === "edge" && ((C = O.edgeObj) == null ? void 0 : C.v) === ((j = W.edgeObj) == null ? void 0 : j.v) && ((I = O.edgeObj) == null ? void 0 : I.w) === ((S = W.edgeObj) == null ? void 0 : S.w)) if (O.edgeLabel.reversed) {
      p[N] = h[G], h.splice(G, 1), G--;
      break;
    } else p[v] = h[x], h.splice(x, 1), x--;
    else E = true;
  }
  let y = Ge(h, p, i, e, s);
  if (u && d) {
    y.vs = [u, y.vs, d].flat(1);
    let G = e.predecessors(u);
    if (G && G.length) {
      let x = e.node(G[0]), v = e.predecessors(d), N = e.node(v[0]);
      Object.hasOwn(y, "barycenter") || (y.barycenter = 0, y.weight = 0), y.barycenter = (y.barycenter * y.weight + x.order + N.order) / (y.weight + 2), y.weight += 2;
    }
  }
  return Object.defineProperty(y, "result", { value: y, enumerable: false, configurable: true, writable: true }), Object.defineProperty(y, "usedBias", { value: E, enumerable: false, configurable: true, writable: true }), y;
}
function Bt(e, n) {
  e.forEach((t) => {
    t.vs = t.vs.flatMap((r) => n[r] ? n[r].vs : r);
  });
}
function Xt(e, n) {
  e.barycenter !== void 0 ? (e.barycenter = (e.barycenter * e.weight + n.barycenter * n.weight) / (e.weight + n.weight), e.weight += n.weight) : (e.barycenter = n.barycenter, e.weight = n.weight);
}
function ve(e, n, t, r) {
  r || (r = e.nodes());
  let o = zt(e), i = new T({ compound: true }).setGraph({ root: o }).setDefaultNodeLabel((s) => e.node(s));
  return r.forEach((s) => {
    let a = e.node(s), l = e.parent(s);
    if (a.rank === n || a.minRank <= n && n <= a.maxRank) {
      i.setNode(s), i.setParent(s, l || o);
      let u = e[t](s);
      u && u.forEach((d) => {
        let c = d.v === s ? d.w : d.v, f = i.edge(c, s), h = f !== void 0 ? f.weight : 0;
        i.setEdge(c, s, { weight: e.edge(d).weight + h });
      }), Object.hasOwn(a, "minRank") && i.setNode(s, { borderLeft: a.borderLeft[n], borderRight: a.borderRight[n] });
    }
  }), i;
}
function zt(e) {
  let n;
  for (; e.hasNode(n = $("_root")); ) ;
  return n;
}
function ke(e, n, t) {
  let r = {}, o;
  t.forEach((i) => {
    let s = e.parent(i), a, l;
    for (; s; ) {
      if (a = e.parent(s), a ? (l = r[a], r[a] = s) : (l = o, o = s), l && l !== s) {
        n.setEdge(l, s);
        return;
      }
      s = a;
    }
  });
}
function re(e, n = {}, t = null) {
  if (typeof n.customOrder == "function") {
    n.customOrder(e, re);
    return;
  }
  let r = de(e), o = yn(e, A(1, r + 1), "inEdges"), i = yn(e, A(r - 1, -1, -1), "outEdges"), s = Le(e, t);
  if (wn(e, s), n.disableOptimalOrderHeuristic) return;
  let a = Number.POSITIVE_INFINITY, l, u = n.constraints || [];
  for (let d = 0, c = 0; c < 4; ++d, ++c) {
    Ht(d % 2 ? o : i, d % 4 >= 2, u, t), s = P(e);
    let f = ye(e, s);
    f < a ? (c = 0, l = Object.assign({}, s), a = f) : f === a && (l = structuredClone(s));
  }
  wn(e, l);
}
function yn(e, n, t) {
  let r = /* @__PURE__ */ new Map(), o = (i, s) => {
    r.has(i) || r.set(i, []), r.get(i).push(s);
  };
  for (let i of e.nodes()) {
    let s = e.node(i);
    if (typeof s.rank == "number" && o(s.rank, i), typeof s.minRank == "number" && typeof s.maxRank == "number") for (let a = s.minRank; a <= s.maxRank; a++) a !== s.rank && o(a, i);
  }
  return n.map(function(i) {
    return ve(e, i, t, r.get(i) || []);
  });
}
function Ht(e, n, t, r) {
  let o = true, i = new T();
  e.forEach(function(s) {
    t.forEach((d) => i.setEdge(d.left, d.right));
    let a = s.graph().root, { result: l, usedBias: u } = te(s, a, i, r, o);
    n && u && (o = !o), l.vs.forEach((d, c) => s.node(d).order = c), ke(s, i, l.vs);
  });
}
function wn(e, n) {
  Object.values(n).forEach((t) => t.forEach((r, o) => e.node(r).order = o));
}
function qt(e, n) {
  let t = {};
  function r(o, i) {
    let s = 0, a = 0, l = o.length, u = i[i.length - 1];
    return i.forEach((d, c) => {
      let f = Ut(e, d), h = f ? e.node(f).order : l;
      (f || d === u) && (i.slice(a, c + 1).forEach((p) => {
        let E = e.predecessors(p);
        E && E.forEach((y) => {
          let L2 = e.node(y), b = L2.order;
          (b < s || h < b) && !(L2.dummy && e.node(p).dummy) && Gn(t, y, p);
        });
      }), a = c + 1, s = h);
    }), i;
  }
  return n.length && n.reduce(r), t;
}
function $t(e, n) {
  let t = {};
  function r(i, s, a, l, u) {
    A(s, a).forEach((d) => {
      let c = i[d];
      if (c !== void 0 && e.node(c).dummy) {
        let f = e.predecessors(c);
        f && f.forEach((h) => {
          if (h === void 0) return;
          let p = e.node(h);
          p.dummy && (p.order < l || p.order > u) && Gn(t, h, c);
        });
      }
    });
  }
  function o(i, s) {
    let a = -1, l = -1, u = 0;
    return s.forEach((d, c) => {
      if (e.node(d).dummy === "border") {
        let f = e.predecessors(d);
        if (f && f.length) {
          let h = f[0];
          if (h === void 0) return;
          l = e.node(h).order, r(s, u, c, a, l), u = c, a = l;
        }
      }
      r(s, u, s.length, l, i.length);
    }), s;
  }
  return n.length && n.reduce(o), t;
}
function Ut(e, n) {
  if (e.node(n).dummy) {
    let t = e.predecessors(n);
    if (t) return t.find((r) => e.node(r).dummy);
  }
}
function Gn(e, n, t) {
  if (n > t) {
    let o = n;
    n = t, t = o;
  }
  let r = e[n];
  r || (e[n] = r = {}), r[t] = true;
}
function Jt(e, n, t) {
  if (n > t) {
    let o = n;
    n = t, t = o;
  }
  let r = e[n];
  return r !== void 0 && Object.hasOwn(r, t);
}
function Kt(e, n, t, r, o) {
  let i = {}, s = {}, a = {};
  return n.forEach((l) => {
    l.forEach((u, d) => {
      i[u] = u, s[u] = u, a[u] = d;
    });
  }), n.forEach((l) => {
    let u = -1, d = -1, c = false, f = l, h = l.findIndex((p) => (o == null ? void 0 : o.includes(p)) || Nn(p, e, o));
    h > 0 && (f = [l[h], ...l.slice(0, h), ...l.slice(h + 1)], c = true), f.forEach((p) => {
      var y;
      let E = r(p);
      if (E && E.length) {
        o != null && o.includes(p) && (E = E.filter((g) => Nn(g, e, o)));
        let L2 = E.sort((g, m) => {
          let w = a[g], k = a[m];
          return (w !== void 0 ? w : 0) - (k !== void 0 ? k : 0);
        }), b = (L2.length - 1) / 2;
        for (let g = Math.floor(b), m = Math.ceil(b); g <= m; ++g) {
          let w = L2[g];
          if (w === void 0) continue;
          let k = a[w];
          if (k !== void 0 && s[p] === p && u < k && a[w] !== d && !Jt(t, p, w)) {
            let _ = i[w];
            _ !== void 0 && (s[w] = p, s[p] = i[p] = _, u = k, c && (u = -1, d = (y = a[w]) != null ? y : -1, c = false));
          }
        }
      }
    });
  }), { root: i, align: s };
}
function Qt(e, n, t, r, o = false) {
  let i = {}, s = Zt(e, n, t, o), a = o ? "borderLeft" : "borderRight";
  function l(h, p) {
    let E = s.nodes().slice(), y = {}, L2 = E.pop();
    for (; L2; ) {
      if (y[L2]) h(L2);
      else {
        y[L2] = true, E.push(L2);
        for (let b of p(L2)) E.push(b);
      }
      L2 = E.pop();
    }
  }
  function u(h) {
    let p = s.inEdges(h);
    p ? i[h] = p.reduce((E, y) => {
      var g;
      let L2 = (g = i[y.v]) != null ? g : 0, b = s.edge(y);
      return Math.max(E, L2 + (b !== void 0 ? b : 0));
    }, 0) : i[h] = 0;
  }
  function d(h) {
    let p = s.outEdges(h), E = Number.POSITIVE_INFINITY;
    p && (E = p.reduce((L2, b) => {
      let g = i[b.w], m = s.edge(b);
      return Math.min(L2, (g !== void 0 ? g : 0) - (m !== void 0 ? m : 0));
    }, Number.POSITIVE_INFINITY));
    let y = e.node(h);
    E !== Number.POSITIVE_INFINITY && y.borderType !== a && (i[h] = Math.max(i[h] !== void 0 ? i[h] : 0, E));
  }
  function c(h) {
    return s.predecessors(h) || [];
  }
  function f(h) {
    return s.successors(h) || [];
  }
  return l(u, c), l(d, f), Object.keys(r).forEach((h) => {
    var E;
    let p = t[h];
    p !== void 0 && (i[h] = (E = i[p]) != null ? E : 0);
  }), i;
}
function Zt(e, n, t, r) {
  let o = new T(), i = e.graph(), s = rr(i.nodesep, i.edgesep, r);
  return n.forEach((a) => {
    let l;
    a.forEach((u) => {
      let d = t[u];
      if (d !== void 0) {
        if (o.setNode(d), l !== void 0) {
          let c = t[l];
          if (c !== void 0) {
            let f = o.edge(c, d);
            o.setEdge(c, d, Math.max(s(e, u, l), f || 0));
          }
        }
        l = u;
      }
    });
  }), o;
}
function er(e, n) {
  return Object.values(n).reduce((t, r) => {
    let o = Number.NEGATIVE_INFINITY, i = Number.POSITIVE_INFINITY;
    Object.entries(r).forEach(([a, l]) => {
      let u = or(e, a) / 2;
      o = Math.max(l + u, o), i = Math.min(l - u, i);
    });
    let s = o - i;
    return s < t[0] && (t = [s, r]), t;
  }, [Number.POSITIVE_INFINITY, null])[1];
}
function nr(e, n) {
  let t = Object.values(n), r = R$1(Math.min, t), o = R$1(Math.max, t);
  ["u", "d"].forEach((i) => {
    ["l", "r"].forEach((s) => {
      let a = i + s, l = e[a];
      if (!l || l === n) return;
      let u = Object.values(l), d = r - R$1(Math.min, u);
      s !== "l" && (d = o - R$1(Math.max, u)), d && (e[a] = X(l, (c) => c + d));
    });
  });
}
function tr(e, n = void 0) {
  let t = e.ul;
  return t ? X(t, (r, o) => {
    var s, a;
    if (n) {
      let l = n.toLowerCase(), u = e[l];
      if (u && u[o] !== void 0) return u[o];
    }
    let i = Object.values(e).map((l) => {
      let u = l[o];
      return u !== void 0 ? u : 0;
    }).sort((l, u) => l - u);
    return (((s = i[1]) != null ? s : 0) + ((a = i[2]) != null ? a : 0)) / 2;
  }) : {};
}
function vn(e, n) {
  let t = P(e), r = Object.assign(qt(e, t), $t(e, t)), o = {}, i;
  ["u", "d"].forEach((a) => {
    i = a === "u" ? t : Object.values(t).reverse(), ["l", "r"].forEach((l) => {
      l === "r" && (i = i.map((f) => Object.values(f).reverse()));
      let d = Kt(e, i, r, (f) => (a === "u" ? e.predecessors(f) : e.successors(f)) || [], n), c = Qt(e, i, d.root, d.align, l === "r");
      l === "r" && (c = X(c, (f) => -f)), o[a + l] = c;
    });
  });
  let s = er(e, o);
  return nr(o, s), tr(o, e.graph().align);
}
function rr(e, n, t) {
  return (r, o, i) => {
    let s = r.node(o), a = r.node(i), l = 0, u;
    if (l += s.width / 2, Object.hasOwn(s, "labelpos")) switch (s.labelpos.toLowerCase()) {
      case "l":
        u = -s.width / 2;
        break;
      case "r":
        u = s.width / 2;
        break;
    }
    if (u && (l += t ? u : -u), u = void 0, l += (s.dummy ? n : e) / 2, l += (a.dummy ? n : e) / 2, l += a.width / 2, Object.hasOwn(a, "labelpos")) switch (a.labelpos.toLowerCase()) {
      case "l":
        u = a.width / 2;
        break;
      case "r":
        u = -a.width / 2;
        break;
    }
    return u && (l += t ? u : -u), l;
  };
}
function or(e, n) {
  return e.node(n).width;
}
function Nn(e, n, t) {
  var s;
  if (!t) return false;
  let r = (s = n.node(e)) == null ? void 0 : s.edgeObj;
  if (!r || n.node(e).edgeLabel.reversed) return false;
  let o = t.indexOf(r == null ? void 0 : r.v), i = t.indexOf(r == null ? void 0 : r.w);
  return o !== -1 && i !== -1 && o === (i + 1) % t.length || o === (i - 1) % t.length;
}
function kn(e, n) {
  e = Z(e), ir(e), Object.entries(vn(e, n)).forEach(([t, r]) => e.node(t).x = r);
}
function ir(e) {
  let n = P(e), t = e.graph(), r = t.ranksep, o = t.rankalign, i = 0;
  n.forEach((s) => {
    let a = s.reduce((l, u) => {
      var c;
      let d = (c = e.node(u).height) != null ? c : 0;
      return l > d ? l : d;
    }, 0);
    s.forEach((l) => {
      let u = e.node(l);
      o === "top" ? u.y = i + u.height / 2 : o === "bottom" ? u.y = i + a - u.height / 2 : u.y = i + a / 2;
    }), i += a + r;
  });
}
var xn = /* @__PURE__ */ new WeakMap();
function Oe(e, n = {}) {
  return Rn(e, q, n), e;
}
function _n(e, n, t) {
  let r = n;
  for (; r !== void 0; ) {
    let o = e.parent(r);
    if (o === t) return r;
    r = o;
  }
}
function Rn(e, n, t) {
  var L2;
  let r = e.nodes().filter((b) => e.children(b).length), o = {};
  r.forEach((b) => {
    let g = e.node(b);
    if (g && g.rankdir) {
      let m = new T({ multigraph: true, compound: true });
      m.setGraph({ rankdir: g.rankdir });
      let w = e.children(b);
      w.forEach((v) => {
        let N = { ...e.node(v) };
        m.setNode(v, N);
        let O = e.parent(v);
        O && O !== b && w.includes(O) && m.setParent(v, O);
      });
      let k = /* @__PURE__ */ new Set();
      e.edges().forEach((v) => {
        let N = _n(e, v.v, b), O = _n(e, v.w, b);
        if (N && O && N !== O) {
          let W = `${N}\0${O}`;
          k.has(W) || (k.add(W), m.setEdge(N, O, { ...e.edge(v) }));
        }
      }), Rn(m, n, t);
      let _ = jn(m);
      On(_, n, t, null), Cn(m, _);
      let C = 1 / 0, j = 1 / 0, I = -1 / 0, S = -1 / 0;
      m.nodes().forEach((v) => {
        if (v === b) return;
        let N = m.node(v);
        N && typeof N.x == "number" && typeof N.y == "number" && typeof N.width == "number" && typeof N.height == "number" && (C = Math.min(C, N.x - N.width / 2), I = Math.max(I, N.x + N.width / 2), j = Math.min(j, N.y - N.height / 2), S = Math.max(S, N.y + N.height / 2));
      }), (!isFinite(C) || !isFinite(j) || !isFinite(I) || !isFinite(S)) && (C = j = 0, I = S = 0);
      let G = I - C, x = S - j;
      o[b] = { minX: C, minY: j, maxX: I, maxY: S, width: G, height: x, offsetX: C, offsetY: j }, g._dagreClusterSubgraph = m;
    }
  });
  let i = [], s = (b) => {
    let g = [], m = (e.children(b) || []).filter((w) => w !== b);
    for (; m.length > 0; ) {
      let w = m.shift();
      g.push(w), (e.children(w) || []).filter((k) => k !== w).forEach((k) => m.push(k));
    }
    return g;
  }, a = /* @__PURE__ */ new Map();
  r.forEach((b) => {
    let g = e.node(b);
    g && g.rankdir && o[b] && a.set(b, (e.children(b) || []).filter((m) => m !== b));
  });
  let l = new Set([...a.values()].flat()), u = /* @__PURE__ */ new Map();
  a.forEach((b, g) => {
    l.has(g) || u.set(g, s(g));
  });
  let d = new Set([...u.values()].flat()), c = (b) => {
    for (let [g, m] of u) if (m.includes(b)) return g;
    return b;
  }, f = [];
  e.edges().forEach((b) => {
    (d.has(b.v) || d.has(b.w)) && f.push({ edge: b, label: e.edge(b) });
  });
  let h = /* @__PURE__ */ new Map();
  d.forEach((b) => {
    let g = e.parent(b);
    h.set(b, typeof g == "string" ? g : void 0);
  }), u.forEach((b, g) => {
    let m = e.node(g), w = [];
    b.forEach((C) => {
      let j = e.node(C);
      j && (w.push({ id: C, node: j, parent: h.get(C) }), e.removeNode(C));
    });
    let k = f.filter(({ edge: C }) => b.includes(C.v) || b.includes(C.w)), _ = o[g];
    m && (i.push({ clusterId: g, subgraph: m._dagreClusterSubgraph, bounds: _, children: b, removedNodes: w, removedEdges: k }), m.width = _.width, m.height = _.height);
  });
  let p = /* @__PURE__ */ new Set();
  f.forEach(({ edge: b, label: g }) => {
    let m = c(b.v), w = c(b.w);
    if (m !== w && e.hasNode(m) && e.hasNode(w)) {
      let k = `${m}\0${w}`;
      p.has(k) || (p.add(k), e.setEdge(m, w, { ...g, width: 0, height: 0 }));
    }
  });
  let E = jn(e), y = On(E, n, t, (L2 = xn.get(e)) != null ? L2 : null);
  xn.set(e, y), Cn(e, E), p.forEach((b) => {
    let g = b.indexOf("\0"), m = b.slice(0, g), w = b.slice(g + 1);
    e.hasEdge(m, w) && e.removeEdge(m, w);
  }), i.forEach(({ clusterId: b, subgraph: g, bounds: m, removedNodes: w, removedEdges: k }) => {
    var G, x;
    let _ = e.node(b), C = (G = _ == null ? void 0 : _.x) != null ? G : 0, j = (x = _ == null ? void 0 : _.y) != null ? x : 0, I = (m.minX + m.maxX) / 2, S = (m.minY + m.maxY) / 2;
    w.forEach(({ id: v, node: N, parent: O }) => {
      e.setNode(v, N), O !== void 0 && e.setParent(v, O);
    }), k.forEach(({ edge: v, label: N }) => {
      e.setEdge(v, N);
    }), g.nodes().forEach((v) => {
      if (v === b) return;
      let N = g.node(v), O = e.node(v);
      O && N && typeof N.x == "number" && typeof N.y == "number" && (O.x = C + (N.x - I), O.y = j + (N.y - S));
    }), delete _._dagreClusterSubgraph;
  }), r.forEach((b) => {
    var w, k;
    let g = e.node(b), m = o[b];
    if (g && g.rankdir && g._dagreClusterSubgraph && m) {
      let _ = g._dagreClusterSubgraph, C = (w = g.x) != null ? w : 0, j = (k = g.y) != null ? k : 0, I = (m.minX + m.maxX) / 2, S = (m.minY + m.maxY) / 2;
      _.nodes().forEach((G) => {
        if (G === b) return;
        let x = _.node(G), v = e.node(G);
        if (v && x && typeof x.x == "number" && typeof x.y == "number") {
          let N = x.x - I, O = x.y - S;
          v.x = C + N, v.y = j + O;
        }
      }), delete g._dagreClusterSubgraph;
    }
  });
}
function On(e, n, t, r = null) {
  var l, u;
  let o = (t == null ? void 0 : t.useDynamic) !== false, i = o && (l = r == null ? void 0 : r.graph) != null ? l : null, s = o && (u = r == null ? void 0 : r.rawNodes) != null ? u : null;
  n("    makeSpaceForEdgeLabels", () => hr(e)), n("    removeSelfEdges", () => Nr(e)), n("    acyclic", () => Ue(e, i)), n("    nestingGraph.run", () => un(e)), n("    rank", () => dn(Z(e))), n("    injectEdgeLabelProxies", () => br(e)), n("    removeEmptyRanks", () => Be(e)), n("    nestingGraph.cleanup", () => fn(e)), n("    normalizeRanks", () => We(e)), n("    assignRankMinMax", () => gr(e)), n("    removeEdgeLabelProxies", () => pr(e)), n("    normalize.run", () => Ke(e)), n("    parentDummyChains", () => ln(e)), n("    addBorderSegments", () => bn(e)), n("    order", () => re(e, t, s)), n("    insertSelfEdges", () => Gr(e)), n("    adjustCoordinateSystem", () => pn(e)), n("    position", () => kn(e, t.corePath)), n("    positionSelfEdges", () => vr(e));
  let a = JSON.parse(JSON.stringify(e._nodes));
  return n("    removeBorderNodes", () => wr(e)), n("    normalize.undo", () => Qe(e)), n("    fixupEdgeLabelCoords", () => Lr(e)), n("    undoCoordinateSystem", () => mn(e)), n("    translateGraph", () => mr(e)), n("    assignNodeIntersects", () => Er(e)), n("    reversePoints", () => yr(e)), n("    acyclic.undo", () => Je(e)), { graph: e, rawNodes: a };
}
function Cn(e, n) {
  e.nodes().forEach((t) => {
    let r = e.node(t), o = n.node(t);
    r && (r.x = o.x, r.y = o.y, r.order = o.order, r.rank = o.rank, n.children(t).length && (r.width = o.width, r.height = o.height));
  }), e.edges().forEach((t) => {
    let r = e.edge(t), o = n.edge(t);
    r.points = o.points, Object.hasOwn(o, "x") && (r.x = o.x, r.y = o.y);
  }), e.graph().width = n.graph().width, e.graph().height = n.graph().height;
}
var sr = ["nodesep", "edgesep", "ranksep", "marginx", "marginy"], ar = { ranksep: 50, edgesep: 20, nodesep: 50, rankdir: "TB", rankalign: "center" }, dr = ["acyclicer", "ranker", "rankdir", "align", "rankalign"], lr = ["width", "height", "rank"], Tn = { width: 0, height: 0 }, ur = ["minlen", "weight", "width", "height", "labeloffset"], cr = { minlen: 1, weight: 1, width: 0, height: 0, labeloffset: 10, labelpos: "r" }, fr = ["labelpos"];
function jn(e) {
  let n = new T({ multigraph: true, compound: true }), t = _e(e.graph());
  return n.setGraph(Object.assign({}, ar, xe(t, sr), B(t, dr))), e.nodes().forEach((r) => {
    let o = _e(e.node(r)), i = xe(o, lr);
    Object.keys(Tn).forEach((a) => {
      i[a] === void 0 && (i[a] = Tn[a]);
    }), n.setNode(r, i);
    let s = e.parent(r);
    s !== void 0 && n.setParent(r, s);
  }), e.edges().forEach((r) => {
    let o = _e(e.edge(r));
    n.setEdge(r, Object.assign({}, cr, xe(o, ur), B(o, fr)));
  }), n;
}
function hr(e) {
  let n = e.graph();
  n.ranksep /= 2, e.edges().forEach((t) => {
    var o;
    let r = e.edge(t);
    r.minlen *= 2, ((o = r.labelpos) != null ? o : "r").toLowerCase() !== "c" && (n.rankdir === "TB" || n.rankdir === "BT" ? r.width += r.labeloffset : r.height += r.labeloffset);
  });
}
function br(e) {
  e.edges().forEach((n) => {
    let t = e.edge(n);
    if (t.width && t.height) {
      let r = e.node(n.v), i = { rank: (e.node(n.w).rank - r.rank) / 2 + r.rank, e: n };
      M(e, "edge-proxy", i, "_ep");
    }
  });
}
function gr(e) {
  let n = 0;
  e.nodes().forEach((t) => {
    let r = e.node(t);
    r.borderTop && (r.minRank = e.node(r.borderTop).rank, r.maxRank = e.node(r.borderBottom).rank, n = Math.max(n, r.maxRank));
  }), e.graph().maxRank = n;
}
function pr(e) {
  e.nodes().forEach((n) => {
    let t = e.node(n);
    if (t.dummy === "edge-proxy") {
      let r = t;
      e.edge(r.e).labelRank = t.rank, e.removeNode(n);
    }
  });
}
function mr(e) {
  let n = Number.POSITIVE_INFINITY, t = 0, r = Number.POSITIVE_INFINITY, o = 0, i = e.graph(), s = i.marginx || 0, a = i.marginy || 0;
  function l(u) {
    let d = u.x, c = u.y, f = u.width, h = u.height;
    n = Math.min(n, d - f / 2), t = Math.max(t, d + f / 2), r = Math.min(r, c - h / 2), o = Math.max(o, c + h / 2);
  }
  e.nodes().forEach((u) => l(e.node(u))), e.edges().forEach((u) => {
    let d = e.edge(u);
    Object.hasOwn(d, "x") && l(d);
  }), n -= s, r -= a, e.nodes().forEach((u) => {
    let d = e.node(u);
    d.x -= n, d.y -= r;
  }), e.edges().forEach((u) => {
    let d = e.edge(u);
    d.points.forEach((c) => {
      c.x -= n, c.y -= r;
    }), Object.hasOwn(d, "x") && (d.x -= n), Object.hasOwn(d, "y") && (d.y -= r);
  }), i.width = t - n + s, i.height = o - r + a;
}
function Er(e) {
  e.edges().forEach((n) => {
    if (n.v === n.w) return;
    let t = e.edge(n), r = e.node(n.v), o = e.node(n.w), i, s;
    t.points ? (i = t.points[0], s = t.points[t.points.length - 1]) : (t.points = [], i = o, s = r), t.points.unshift(se(r, i)), t.points.push(se(o, s));
  });
}
function Lr(e) {
  e.edges().forEach((n) => {
    let t = e.edge(n);
    if (Object.hasOwn(t, "x")) switch ((t.labelpos === "l" || t.labelpos === "r") && (t.width -= t.labeloffset), t.labelpos) {
      case "l":
        t.x -= t.width / 2 + t.labeloffset;
        break;
      case "r":
        t.x += t.width / 2 + t.labeloffset;
        break;
    }
  });
}
function yr(e) {
  e.edges().forEach((n) => {
    let t = e.edge(n);
    t.reversed && t.points.reverse();
  });
}
function wr(e) {
  e.nodes().forEach((n) => {
    if (e.children(n).length) {
      let t = e.node(n), r = e.node(t.borderTop), o = e.node(t.borderBottom), i = e.node(t.borderLeft[t.borderLeft.length - 1]), s = e.node(t.borderRight[t.borderRight.length - 1]);
      t.width = Math.abs(s.x - i.x), t.height = Math.abs(o.y - r.y), t.x = i.x + t.width / 2, t.y = r.y + t.height / 2;
    }
  }), e.nodes().forEach((n) => {
    e.node(n).dummy === "border" && e.removeNode(n);
  });
}
function Nr(e) {
  e.edges().forEach((n) => {
    if (n.v === n.w) {
      let t = e.node(n.v);
      t.selfEdges || (t.selfEdges = []), t.selfEdges.push({ e: n, label: e.edge(n) }), e.removeEdge(n);
    }
  });
}
function Gr(e) {
  P(e).forEach((t) => {
    let r = 0;
    t.forEach((o, i) => {
      let s = e.node(o);
      typeof s.rank != "number" && (s.rank = 0), s.order = i + r, (s.selfEdges || []).forEach((a) => {
        M(e, "selfedge", { width: a.label.width, height: a.label.height, rank: s.rank, order: i + ++r, e: a.e, edgeLabel: a.label }, "_se"), (!Array.isArray(a.label.points) || a.label.points.length !== 7) && (a.label.points = [{ x: 0, y: -10 }, { x: 0, y: -10 }, { x: 0, y: 0 }, { x: 0, y: 10 }, { x: 0, y: 10 }, { x: 0, y: 0 }, { x: 0, y: 0 }]);
      }), delete s.selfEdges;
    });
  });
}
function vr(e) {
  e.nodes().forEach((n) => {
    let t = e.node(n), r = (o) => typeof o == "number" && isFinite(o);
    if (t.dummy === "selfedge") {
      let o = t, i = e.node(o.e.v), s = r(i == null ? void 0 : i.x) ? i.x : 0, a = r(i == null ? void 0 : i.y) ? i.y : 0, l = r(i == null ? void 0 : i.width) ? i.width : 0, u = r(i == null ? void 0 : i.height) ? i.height : 0, d = r(t.x) ? t.x : s, c = r(t.y) ? t.y : a, f = l / 2, h = u / 2;
      o.edgeLabel.points = [{ x: d + f, y: c - h }, { x: d + f, y: c - h }, { x: d, y: c }, { x: d - f, y: c + h }, { x: d - f, y: c + h }, { x: d, y: c }, { x: d, y: c }], o.edgeLabel.x = d, o.edgeLabel.y = c, e.setEdge(o.e, o.edgeLabel), e.removeNode(n);
    } else t && Array.isArray(t.selfEdges) && t.selfEdges.forEach((o) => {
      if (!Array.isArray(o.label.points) || o.label.points.length !== 7) {
        let i = r(t.x) ? t.x : 0, s = r(t.y) ? t.y : 0, a = r(t.width) ? t.width : 0, l = r(t.height) ? t.height : 0, u = a / 2, d = l / 2;
        o.label.points = [{ x: i + u, y: s - d }, { x: i + u, y: s - d }, { x: i, y: s }, { x: i - u, y: s + d }, { x: i - u, y: s + d }, { x: i, y: s }, { x: i, y: s }];
      }
    });
  });
}
function xe(e, n) {
  return X(B(e, n), Number);
}
function _e(e) {
  let n = {};
  return e && Object.entries(e).forEach(([t, r]) => {
    typeof t == "string" && (t = t.toLowerCase()), n[t] = r;
  }), n;
}
function Ce(e) {
  let n = P(e), t = new T({ compound: true, multigraph: true }).setGraph({});
  return e.nodes().forEach((r) => {
    t.setNode(r, { label: r }), t.setParent(r, "layer" + e.node(r).rank);
  }), e.edges().forEach((r) => t.setEdge(r.v, r.w, {}, r.name)), n.forEach((r, o) => {
    let i = "layer" + o;
    t.setNode(i, { rank: "same" }), r.reduce((s, a) => (t.setEdge(s, a, { style: "invis" }), a));
  }), t;
}
var kr = { graphlib: ie, version: ue, layout: Oe, debug: Ce, util: { time: le, notime: q } }, $o = kr;
/*! For license information please see dagre.esm.js.LEGAL.txt */
const WIDE_RANGES = [
  [4352, 4447],
  [11904, 42191],
  [44032, 55203],
  [63744, 64255],
  [65072, 65135],
  [65280, 65376],
  [65504, 65510],
  [127744, 128591],
  [128640, 128767],
  [128992, 129003],
  [129280, 129535],
  [131072, 262141],
  // single-codepoint emoji that are East Asian Wide (✅ ❌ ⚡ ⭐ ❓ ➕): drawn two cells wide
  [9989, 9989],
  [10060, 10060],
  [9889, 9889],
  [11088, 11088],
  [10067, 10069],
  [10133, 10135]
];
const ZERO_WIDTH_RANGES = [[768, 879], [8203, 8205], [65024, 65039]];
function cellWidth(ch) {
  const cp = ch.codePointAt(0) ?? 0;
  if (ZERO_WIDTH_RANGES.some(([a, b]) => cp >= a && cp <= b)) return 0;
  if (WIDE_RANGES.some(([a, b]) => cp >= a && cp <= b)) return 2;
  return 1;
}
function displayWidth(s) {
  let w = 0;
  for (const ch of s) w += cellWidth(ch);
  return w;
}
const WIDE_TAIL = "\0";
const ZERO_WIDTH = /[\u0300-\u036f\u200b-\u200d\ufe00-\ufe0f]/g;
const CONTROL = /[\u0000-\u001f\u007f-\u009f؜‎‏‪-‮⁦-⁩﻿]/g;
function sanitizeLabel(raw) {
  return String(raw ?? "").normalize("NFC").replace(/[\n\r\t]+/g, " ").replace(CONTROL, "").replace(ZERO_WIDTH, "").replace(/ {2,}/g, " ").trim();
}
function fitLabel(s, max) {
  if (displayWidth(s) <= max) return s;
  let out = "";
  let w = 0;
  for (const ch of s) {
    const cw = cellWidth(ch);
    if (w + cw > max - 1) break;
    out += ch;
    w += cw;
  }
  return out + "…";
}
const MAX_PLAN_NODES = 150;
const MAX_PLAN_EDGES = 600;
const BOX_HEIGHT = 3;
const BOX_CHROME = 6;
const MIN_LABEL = 8;
const GAP_BOX = 3;
const GAP_OTHER = 2;
const LABEL_FLOOR = MIN_LABEL;
function layoutPlan(input, labelMax) {
  const { nodes, warnings } = normalizePlanNodes(input);
  if (!nodes.length) return { ok: false, reason: "empty", message: "the plan has no tasks" };
  if (nodes.length > MAX_PLAN_NODES) return { ok: false, reason: "too_large", message: `the plan has ${nodes.length} tasks (the graph shows at most ${MAX_PLAN_NODES})` };
  const edgeCount = nodes.reduce((a, n) => a + n.deps.length, 0);
  if (edgeCount > MAX_PLAN_EDGES) return { ok: false, reason: "too_large", message: `the plan has ${edgeCount} dependencies (the graph shows at most ${MAX_PLAN_EDGES})` };
  const items = nodes.map((node, i) => {
    const label = fitLabel(sanitizeLabel(node.label) || sanitizeLabel(node.id) || "?", Math.max(MIN_LABEL, labelMax));
    return { uid: i, rank: 0, x: 0, w: Math.max(displayWidth(label), 1) + BOX_CHROME, virtual: false, node, label };
  });
  const byId = new Map(items.map((it2) => [it2.node.id, it2]));
  const g = new $o.graphlib.Graph();
  g.setGraph({ rankdir: "TB", nodesep: GAP_BOX + 1, edgesep: GAP_OTHER + 1, ranksep: 4, marginx: 0, marginy: 0 });
  g.setDefaultEdgeLabel(() => ({}));
  items.forEach((it2, i) => g.setNode(`n${i}`, { width: it2.w, height: BOX_HEIGHT }));
  const idx = new Map(nodes.map((n, i) => [n.id, i]));
  for (const n of nodes) for (const d of n.deps) g.setEdge(`n${idx.get(d)}`, `n${idx.get(n.id)}`);
  $o.layout(g);
  const ys = [...new Set(items.map((_, i) => Math.round(g.node(`n${i}`).y)))].sort((a, b) => a - b);
  items.forEach((it2, i) => {
    const p = g.node(`n${i}`);
    it2.rank = ys.indexOf(Math.round(p.y));
    it2.x = Math.round(p.x - it2.w / 2);
  });
  const ranks = ys.map(() => []);
  items.forEach((it2) => ranks[it2.rank].push(it2));
  const chains = [];
  let uid = items.length;
  for (const n of nodes) for (const d of n.deps) {
    const a = items[idx.get(d)];
    const b = items[idx.get(n.id)];
    const span = b.rank - a.rank;
    if (span < 1) return { ok: false, reason: "cannot_draw", message: `${n.id} is not ranked below ${d}` };
    const pts = g.edge(`n${idx.get(d)}`, `n${idx.get(n.id)}`).points ?? [];
    const chain = [a];
    for (let k = 1; k < span; k++) {
      const px = pts.length === span + 1 ? pts[k].x : a.x + a.w / 2 + (b.x + b.w / 2 - (a.x + a.w / 2)) * (k / span);
      const v = { uid: uid++, rank: a.rank + k, x: Math.round(px), w: 1, virtual: true, chain: chains.length };
      ranks[v.rank].push(v);
      chain.push(v);
    }
    chain.push(b);
    chains.push({ from: d, to: n.id, items: chain });
  }
  const legalize = (row) => {
    row.sort((p, q2) => p.x - q2.x || p.uid - q2.uid);
    for (let i = 1; i < row.length; i++) {
      const gap = row[i - 1].virtual || row[i].virtual ? GAP_OTHER : GAP_BOX;
      row[i].x = Math.max(row[i].x, row[i - 1].x + row[i - 1].w + gap);
    }
  };
  ranks.forEach(legalize);
  const minX = Math.min(...ranks.flat().map((it2) => it2.x));
  if (minX !== 0) ranks.flat().forEach((it2) => {
    it2.x -= minX;
  });
  const clashes = (v) => [v.rank - 1, v.rank + 1].some((r) => (ranks[r] ?? []).some((o) => o.virtual && o.x === v.x && o.chain !== v.chain));
  for (let pass = 0; pass < 40; pass++) {
    let changed = false;
    for (const row of ranks) for (const v of row) if (v.virtual && clashes(v)) {
      v.x += 1;
      legalize(row);
      changed = true;
    }
    if (!changed) break;
  }
  if (ranks.flat().some((v) => v.virtual && clashes(v))) return { ok: false, reason: "cannot_draw", message: "edge waypoints could not be separated" };
  const width = Math.max(...ranks.flat().map((it2) => it2.x + it2.w));
  return { ok: true, nodes, ranks, chains, byId, width, warnings };
}
const GLYPHS = { done: "✓", running: "▶", failed: "✗", pending: "○", ready: "◔", awaiting_user: "~", awaiting_input: "⏸", cancelled: "⊘" };
const ASCII_GLYPHS = { done: "+", running: ">", failed: "x", pending: "o", ready: "*", awaiting_user: "~", awaiting_input: "=", cancelled: "/" };
const STATUS_SGR = { done: "32", running: "33", failed: "31", pending: "2", ready: "36", awaiting_user: "35", awaiting_input: "35", cancelled: "2" };
const U = 1;
const D = 2;
const L = 4;
const R = 8;
const UNICODE_GLYPH = {
  [U]: "│",
  [D]: "│",
  [U | D]: "│",
  [L]: "─",
  [R]: "─",
  [L | R]: "─",
  [D | R]: "┌",
  [D | L]: "┐",
  [U | R]: "└",
  [U | L]: "┘",
  [U | D | R]: "├",
  [U | D | L]: "┤",
  [L | R | D]: "┬",
  [L | R | U]: "┴",
  [U | D | L | R]: "┼"
};
const LABEL_STEPS = [40, 30, 24, 20, 16, 13, 10, LABEL_FLOOR];
class CannotDraw extends Error {
}
const cV = (col, r1, r2) => Array.from({ length: r2 - r1 + 1 }, (_, i) => [r1 + i, col]);
const cH = (row, c1, c2) => {
  const lo = Math.min(c1, c2);
  return Array.from({ length: Math.abs(c2 - c1) + 1 }, (_, i) => [row, lo + i]);
};
const portRange = (it2) => it2.virtual ? [it2.x, it2.x] : [it2.x + 1, it2.x + it2.w - 2];
function planGap(layout, g) {
  const top = layout.ranks[g];
  const bot = layout.ranks[g + 1];
  const segs = [];
  layout.chains.forEach((c, ci) => {
    for (let k = 0; k + 1 < c.items.length; k++) if (c.items[k].rank === g) segs.push({ a: c.items[k], b: c.items[k + 1], chain: ci });
  });
  const outN = /* @__PURE__ */ new Map();
  const inN = /* @__PURE__ */ new Map();
  for (const s of segs) {
    outN.set(s.a.uid, (outN.get(s.a.uid) ?? 0) + 1);
    inN.set(s.b.uid, (inN.get(s.b.uid) ?? 0) + 1);
  }
  const limit = layout.width + 24;
  const used = /* @__PURE__ */ new Set();
  for (const it2 of [...top, ...bot]) if (it2.virtual) used.add(it2.x);
  const pickFree = (lo, hi, pref) => {
    const p = Math.min(hi, Math.max(lo, pref));
    for (let d = 0; d <= hi - lo; d++) for (const c of d === 0 ? [p] : [p - d, p + d]) if (c >= lo && c <= hi && !used.has(c)) return c;
    return void 0;
  };
  const sc = /* @__PURE__ */ new Map();
  const tc = /* @__PURE__ */ new Map();
  for (const it2 of top) if (it2.virtual) sc.set(it2.uid, it2.x);
  for (const it2 of bot) if (it2.virtual) tc.set(it2.uid, it2.x);
  const straight = /* @__PURE__ */ new Set();
  for (const s of segs) {
    if (outN.get(s.a.uid) !== 1 || inN.get(s.b.uid) !== 1) continue;
    const [alo, ahi] = portRange(s.a);
    const [blo, bhi] = portRange(s.b);
    const lo = Math.max(alo, blo);
    const hi = Math.min(ahi, bhi);
    if (lo > hi) continue;
    let c;
    if (s.a.virtual || s.b.virtual) c = s.a.virtual ? s.a.x : s.b.x;
    else c = pickFree(lo, hi, Math.round((s.a.x + s.a.w / 2 + s.b.x + s.b.w / 2) / 2));
    if (c === void 0 || c < lo || c > hi) continue;
    used.add(c);
    sc.set(s.a.uid, c);
    tc.set(s.b.uid, c);
    straight.add(s);
  }
  for (const [items, ports, counts] of [[top, sc, outN], [bot, tc, inN]]) {
    for (const it2 of items) {
      if (!counts.get(it2.uid) || ports.has(it2.uid)) continue;
      const [lo, hi] = portRange(it2);
      const c = pickFree(lo, hi, Math.round(it2.x + it2.w / 2));
      if (c === void 0) throw new CannotDraw("no free port column");
      used.add(c);
      ports.set(it2.uid, c);
    }
  }
  const dropOf = /* @__PURE__ */ new Map();
  const needSrc = /* @__PURE__ */ new Set();
  const needTgt = /* @__PURE__ */ new Set();
  for (const s of segs) {
    if (straight.has(s)) continue;
    const srcSingle = outN.get(s.a.uid) === 1;
    const tgtSingle = inN.get(s.b.uid) === 1;
    if (srcSingle && !tgtSingle) {
      dropOf.set(s, sc.get(s.a.uid));
      needTgt.add(s.b.uid);
    } else if (tgtSingle) {
      dropOf.set(s, tc.get(s.b.uid));
      needSrc.add(s.a.uid);
    }
  }
  for (const s of segs) {
    if (straight.has(s) || dropOf.has(s)) continue;
    const c = pickFree(0, limit, Math.round((sc.get(s.a.uid) + tc.get(s.b.uid)) / 2));
    if (c === void 0) throw new CannotDraw("no free drop column");
    used.add(c);
    dropOf.set(s, c);
    needSrc.add(s.a.uid);
    needTgt.add(s.b.uid);
  }
  const srcRow = /* @__PURE__ */ new Map();
  const tgtRow = /* @__PURE__ */ new Map();
  top.filter((it2) => needSrc.has(it2.uid)).forEach((it2, i) => srcRow.set(it2.uid, i));
  bot.filter((it2) => needTgt.has(it2.uid)).forEach((it2, i) => tgtRow.set(it2.uid, srcRow.size + i));
  const rows = Math.max(srcRow.size + tgtRow.size + 1, 2);
  const last = rows - 1;
  const plan = { rows, vlines: [], hlines: [], arrows: [], routes: [], maxCol: Math.max(0, ...used) };
  const arrive = (b, col) => {
    if (!b.virtual) plan.arrows.push({ row: last, col });
  };
  for (const s of segs) {
    const a = sc.get(s.a.uid);
    const t = tc.get(s.b.uid);
    const botOpen = s.b.virtual;
    const cells = [];
    if (straight.has(s)) {
      plan.vlines.push({ col: a, r1: 0, r2: last, top: true, bot: botOpen });
      arrive(s.b, a);
      cells.push(...cV(a, 0, last));
    } else {
      const d = dropOf.get(s);
      const sr2 = srcRow.get(s.a.uid);
      const tr2 = tgtRow.get(s.b.uid);
      const haveSrc = sr2 !== void 0 && needSrc.has(s.a.uid) && d !== a;
      const haveTgt = tr2 !== void 0 && needTgt.has(s.b.uid) && d !== t;
      if (haveSrc) {
        plan.vlines.push({ col: a, r1: 0, r2: sr2, top: true, bot: false });
        plan.hlines.push({ row: sr2, c1: Math.min(a, d), c2: Math.max(a, d) });
        cells.push(...cV(a, 0, sr2), ...cH(sr2, a, d));
      }
      const y1 = haveSrc ? sr2 : 0;
      const y2 = haveTgt ? tr2 : last;
      plan.vlines.push({ col: d, r1: y1, r2: y2, top: !haveSrc, bot: !haveTgt && botOpen });
      cells.push(...cV(d, y1, y2));
      if (haveTgt) {
        plan.hlines.push({ row: tr2, c1: Math.min(d, t), c2: Math.max(d, t) });
        plan.vlines.push({ col: t, r1: tr2, r2: last, top: false, bot: botOpen });
        cells.push(...cH(tr2, d, t), ...cV(t, tr2, last));
        arrive(s.b, t);
      } else arrive(s.b, d);
    }
    plan.routes.push({ chain: s.chain, cells });
    plan.maxCol = Math.max(plan.maxCol, ...cells.map((c) => c[1]));
  }
  return plan;
}
function drawOnce(layout, opts) {
  const ascii = opts.ascii ?? false;
  const gaps = layout.ranks.slice(0, -1).map((_, g) => planGap(layout, g));
  const rankY = [0];
  gaps.forEach((gp, g) => rankY.push(rankY[g] + BOX_HEIGHT + gp.rows));
  const height = rankY[rankY.length - 1] + BOX_HEIGHT;
  const width = Math.max(layout.width, ...gaps.map((gp) => gp.maxCol + 1));
  const bits = Array.from({ length: height }, () => new Uint8Array(width));
  const arrows = [];
  const parts = layout.chains.map(() => []);
  gaps.forEach((gp, g) => {
    const y0 = rankY[g] + BOX_HEIGHT;
    for (const v of gp.vlines) for (let r = v.r1; r <= v.r2; r++) bits[y0 + r][v.col] |= (r > v.r1 || v.top ? U : 0) | (r < v.r2 || v.bot ? D : 0);
    for (const h of gp.hlines) for (let c = h.c1; c <= h.c2; c++) bits[y0 + h.row][c] |= (c > h.c1 ? L : 0) | (c < h.c2 ? R : 0);
    for (const a of gp.arrows) arrows.push([y0 + a.row, a.col]);
    for (const rt2 of gp.routes) parts[rt2.chain].push({ at: g * 2 + 1, cells: rt2.cells.map(([r, c]) => [y0 + r, c]) });
  });
  layout.chains.forEach((ch, ci) => {
    for (const it2 of ch.items) if (it2.virtual) {
      for (let r = 0; r < BOX_HEIGHT; r++) bits[rankY[it2.rank] + r][it2.x] |= U | D;
      parts[ci].push({ at: it2.rank * 2, cells: [0, 1, 2].map((r) => [rankY[it2.rank] + r, it2.x]) });
    }
  });
  const routes = Object.fromEntries(layout.chains.map((c, ci) => [`${c.from}>${c.to}`, parts[ci].sort((p, q2) => p.at - q2.at).flatMap((p) => p.cells)]));
  const cells = bits.map((row) => Array.from(row, (b) => b ? ascii ? b & (L | R) && b & (U | D) ? "+" : b & (L | R) ? "-" : "|" : UNICODE_GLYPH[b] : " "));
  for (const [r, c] of arrows) cells[r][c] = ascii ? "v" : "▼";
  const styles = cells.map((row) => row.map(() => ""));
  const glyphs = ascii ? ASCII_GLYPHS : GLYPHS;
  const boxes = [];
  const labels = {};
  const put = (r, c, ch, style = "") => {
    const w = cellWidth(ch);
    if (w === 0) return 0;
    cells[r][c] = ch;
    styles[r][c] = style;
    if (w === 2) {
      cells[r][c + 1] = WIDE_TAIL;
      styles[r][c + 1] = style;
    }
    return w;
  };
  const color = opts.color ?? false;
  for (const node of layout.nodes) {
    const it2 = layout.byId.get(node.id);
    const y = rankY[it2.rank];
    const { x, w } = it2;
    boxes.push({ id: node.id, x, y, w, h: BOX_HEIGHT });
    labels[node.id] = it2.label;
    const selected = opts.selectedId === node.id;
    const [tl, tr2, bl, br2, h, v] = ascii ? ["+", "+", "+", "+", "-", "|"] : ["┌", "┐", "└", "┘", "─", "│"];
    for (let c2 = x; c2 < x + w; c2++) {
      put(y, c2, c2 === x ? tl : c2 === x + w - 1 ? tr2 : h);
      put(y + 2, c2, c2 === x ? bl : c2 === x + w - 1 ? br2 : h);
    }
    for (let c2 = x; c2 < x + w; c2++) put(y + 1, c2, " ", color && selected ? "7" : "");
    put(y + 1, x, v);
    put(y + 1, x + w - 1, v);
    const mid = color && selected ? "7" : "";
    if (selected && !color) put(y + 1, x + 1, ">");
    put(y + 1, x + 2, glyphs[node.status] ?? "?", color ? (selected ? "7;" : "") + STATUS_SGR[node.status] : "");
    let c = x + 4;
    for (const ch of it2.label) c += put(y + 1, c, ch, mid);
  }
  if (color && opts.selectedId) {
    for (const [key, route] of Object.entries(routes)) {
      const e = layout.chains.find((ch) => `${ch.from}>${ch.to}` === key);
      if (e.from === opts.selectedId || e.to === opts.selectedId) {
        for (const [r, c] of route) if (!styles[r][c]) styles[r][c] = "1;36";
      }
    }
  }
  const edges = layout.chains.map((c) => ({ from: c.from, to: c.to }));
  return { ok: true, lines: toLines(cells, styles), boxes, edges, width, height, fits: true, labels, routes, cells, styles, warnings: layout.warnings };
}
function toLines(cells, styles, rows, cols) {
  const [r0, r1] = rows ?? [0, cells.length];
  const out = [];
  for (let r = r0; r < r1; r++) {
    const row = cells[r];
    const [c0, c1] = cols ?? [0, row.length];
    let end = c1;
    while (end > c0 && (row[end - 1] === " " && !styles[r][end - 1])) end--;
    let line = "";
    let cur = "";
    for (let c = c0; c < end; c++) {
      if (row[c] === WIDE_TAIL) continue;
      if (styles[r][c] !== cur) {
        line += cur ? "\x1B[0m" : "";
        cur = styles[r][c];
        line += cur ? `\x1B[${cur}m` : "";
      }
      line += row[c];
    }
    out.push(line + (cur ? "\x1B[0m" : ""));
  }
  return out;
}
function renderPlan(nodes, opts = {}) {
  try {
    let result;
    for (const labelMax of LABEL_STEPS) {
      const layout = layoutPlan(nodes, labelMax);
      if (!layout.ok) return layout;
      result = drawOnce(layout, opts);
      if (opts.maxCols === void 0 || result.width <= opts.maxCols) return result;
    }
    return { ...result, fits: false };
  } catch (err) {
    return { ok: false, reason: "cannot_draw", message: err instanceof Error ? err.message : String(err) };
  }
}
const MAX_KEY_ATTEMPTS = 3;
function alreadyConfigured(deps) {
  const { persisted, overriddenKeys } = deps;
  if (persisted.llmBackend !== void 0) return true;
  if (persisted.apiKey !== void 0 || persisted.authToken !== void 0) return true;
  for (const key of ["llmBackend", "apiKey", "authToken", "proxyUrl"]) {
    if (overriddenKeys.has(key)) return true;
  }
  return false;
}
async function maybeRunFirstRunSetup(deps) {
  const { configStore, persisted, isInteractive, ask, log, testKey } = deps;
  if (alreadyConfigured(deps)) return persisted;
  if (!isInteractive) return persisted;
  log("");
  log("Welcome to Aielia! 👋  Let’s get you set up — it takes about a minute.");
  log("");
  log("Aielia needs an AI model to think with. Pick where that comes from below.");
  log("(You can change this any time with /config, or press Ctrl+C to skip.)");
  log("");
  const patch = {};
  log("Which AI provider do you have (or want to use)?");
  log("");
  PROVIDER_SETUP.forEach((p, i) => {
    log(`  ${i + 1}) ${p.name}`);
    log(`     ${p.blurb}`);
  });
  log("");
  const choice = (await ask(`Type 1-${PROVIDER_SETUP.length} and press Enter (or just Enter to skip): `)).trim();
  const picked = PROVIDER_SETUP[Number(choice) - 1];
  if (!picked) {
    log("");
    log('Skipped. Until you set a provider, Aielia will try the "proxy" backend (needs');
    log("@buildaharness/proxy running on :8787). To set one up later, run:");
    log("  /config set llmBackend <anthropic|openai|openrouter>");
    log("  /config set apiKey <your key>");
    log("");
    return persisted;
  }
  log("");
  log(`To connect ${picked.name}, you need an “API key” — a password-like code that lets Aielia use your account.`);
  log("Here’s how to get one:");
  log("");
  picked.steps.forEach((step, i) => log(`  ${i + 1}. ${step}`));
  if (picked.safety) {
    log("");
    log(`  ${picked.safety.title}:`);
    picked.safety.steps.forEach((step, i) => log(`     ${i + 1}. ${step}`));
    log(`     (${picked.safety.urlLabel})`);
  }
  log("");
  log(`The key starts with "${picked.keyPrefix}". Paste it below when you have it.`);
  log("");
  let key = "";
  for (let attempt = 1; attempt <= MAX_KEY_ATTEMPTS; attempt++) {
    const candidate = cleanApiKey(await ask("Paste your API key (or just Enter to skip): "));
    if (candidate === "") break;
    const formatProblem = checkApiKeyFormat(picked.backend, candidate);
    if (formatProblem) {
      log(`  ✗ ${formatProblem}`);
      continue;
    }
    if (testKey) {
      log("  Checking your key…");
      const result = await testKey(picked.backend, candidate);
      if (result.status === "invalid") {
        log(`  ✗ ${result.message}`);
        continue;
      }
      if (result.status === "unverified") log(`  ! ${result.message}`);
    }
    key = candidate;
    break;
  }
  if (!key) {
    log("");
    log("No working key entered, so nothing was saved. Run Aielia again to retry, or use");
    log("/config set llmBackend " + picked.backend + "  then  /config set apiKey <key>");
    log("");
    return persisted;
  }
  patch.llmBackend = picked.backend;
  patch.apiKey = key;
  await configStore.save(patch);
  log("");
  log(`✓ You’re all set — using ${picked.name}. Say hello!`);
  log("  Your key is saved on this computer in ~/.buildaharness/personal-assistant/config.json");
  log("  (plain text, like a .env file) — don’t share that file.");
  log("");
  return { ...persisted, ...patch };
}
const ICONS = {
  /** A routine, no-approval-needed tool step (read_file, fetch_url, web_search, list_reminders, …). */
  toolStep: "⚙",
  /** A tool step that is itself the proposal of a state-changing action (write_file, run_shell_command) — printed on the same in-flight step line, before the separate "[needs approval — …]" prompt appears. */
  proposalStep: "⚠",
  /** A read-only tool call `tool-policy.ts` denied before it executed — deliberately not `✗` (cli.ts already uses that, unprefixed, as the leading character of several unrelated config/undo-action error lines; reusing it here would misclassify those as `'tool'`-kind in tui-app.tsx's `TOOL_STEP_PREFIXES` match). */
  deniedStep: "⛔"
};
const PLAN_LINE_PREFIX = "▤PLAN▤";
const PROPOSAL_TOOLS = /* @__PURE__ */ new Set(["write_file", "run_shell_command"]);
function toolStepIcon(tool) {
  return PROPOSAL_TOOLS.has(tool) ? ICONS.proposalStep : ICONS.toolStep;
}
function parseCliArgs(argv) {
  const first = argv[0];
  if (first === "--version" || first === "-v" || first === "version") return { command: "version" };
  if (first === "--help" || first === "-h" || first === "help") return { command: "help" };
  if (first === "update") return { command: "update", dryRun: argv.slice(1).includes("--dry-run") };
  return { command: "repl" };
}
function cliHelpText(version) {
  return [
    `aielia ${version} — an agent you can hand real work to, held in bounds by a harness.`,
    "",
    "Usage:",
    "  aielia                 start the interactive assistant",
    "  aielia update          update to the latest release (standalone binary installs)",
    "  aielia update --dry-run  check for an update without installing it",
    "  aielia --version       print the version",
    "  aielia --help          show this help",
    "",
    "https://myaielia.com"
  ].join("\n");
}
const MANIFEST_URL = "https://myaielia.com/aielia-latest.json";
const RELEASES_API_URL = "https://api.github.com/repos/3IVIS/buildaharness/releases?per_page=50";
const RELEASE_TAG_PREFIX = "aielia-v";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1e3;
const REQUEST_TIMEOUT_MS = 5e3;
const DOWNLOAD_TIMEOUT_MS = 10 * 60 * 1e3;
const NPM_UPDATE_HINT = "npm update -g @buildaharness/aielia";
const defaultDataDir$1 = () => join(homedir(), ".buildaharness", "personal-assistant");
const cachePath = (dataDir) => join(dataDir, "update-check.json");
function compareVersions(a, b) {
  const parse = (v) => {
    const [core, pre] = v.replace(/^v/, "").split("-", 2);
    const nums = core.split(".").map((n) => Number.parseInt(n, 10) || 0);
    while (nums.length < 3) nums.push(0);
    return { nums, pre: pre !== void 0 };
  };
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] - pb.nums[i];
  if (pa.pre !== pb.pre) return pa.pre ? -1 : 1;
  return 0;
}
function assertHttps(url, allowInsecureHttp = false) {
  let protocol;
  try {
    protocol = new URL(url).protocol;
  } catch {
    throw new Error(`Refusing malformed URL: ${url}`);
  }
  if (protocol === "https:") return;
  if (protocol === "http:" && allowInsecureHttp) return;
  throw new Error(`Refusing non-HTTPS URL: ${url}`);
}
function shouldRunPassiveUpdateCheck(input) {
  if (input.updateCheck === "disabled") return false;
  if (!input.stdinIsTty) return false;
  if (input.env.ASSISTANT_NON_INTERACTIVE_APPROVAL !== void 0) return false;
  return true;
}
function platformKey(o) {
  return `${o.platform ?? process.platform}-${o.arch ?? process.arch}`;
}
function readCache(dataDir) {
  try {
    const parsed = JSON.parse(readFileSync(cachePath(dataDir), "utf8"));
    if (typeof parsed.checkedAt !== "number") return null;
    return parsed;
  } catch {
    return null;
  }
}
function writeCache(dataDir, cache) {
  try {
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(cachePath(dataDir), JSON.stringify(cache));
  } catch {
  }
}
function parseManifest(json, allowInsecureHttp) {
  const m = json;
  if (typeof (m == null ? void 0 : m.tag) !== "string" || typeof m.version !== "string" || typeof m.assets !== "object" || m.assets === null) {
    throw new Error("Malformed update manifest");
  }
  const assets = {};
  for (const [key, raw] of Object.entries(m.assets)) {
    if (typeof (raw == null ? void 0 : raw.url) !== "string") continue;
    assertHttps(raw.url, allowInsecureHttp);
    assets[key] = {
      url: raw.url,
      sha256: typeof raw.sha256 === "string" ? raw.sha256.toLowerCase() : void 0,
      size: typeof raw.size === "number" ? raw.size : void 0
    };
  }
  return { tag: m.tag, version: m.version, assets, source: "manifest" };
}
function assetKeyFromName(name) {
  const m = /^aielia-([a-z0-9]+-[a-z0-9]+?)(?:\.exe)?$/.exec(name);
  return m ? m[1] : null;
}
function parseGithubReleases(releases, allowInsecureHttp) {
  let best = null;
  for (const r of releases) {
    if (r.draft || r.prerelease || !r.tag_name.startsWith(RELEASE_TAG_PREFIX)) continue;
    const version = r.tag_name.slice(RELEASE_TAG_PREFIX.length);
    if (best && compareVersions(version, best.version) <= 0) continue;
    const assets = {};
    for (const a of r.assets ?? []) {
      const key = assetKeyFromName(a.name);
      if (!key) continue;
      assertHttps(a.browser_download_url, allowInsecureHttp);
      assets[key] = { url: a.browser_download_url, size: a.size };
    }
    best = { tag: r.tag_name, version, assets, source: "github" };
  }
  return best;
}
async function getJson(fetchFn, url, headers = {}) {
  return fetchFn(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS), redirect: "follow" });
}
async function fetchLatestRelease(options, etag) {
  const fetchFn = options.fetchFn ?? fetch;
  const insecure = options.allowInsecureHttp ?? false;
  const manifestUrl = options.manifestUrl ?? MANIFEST_URL;
  const apiUrl = options.releasesApiUrl ?? RELEASES_API_URL;
  assertHttps(manifestUrl, insecure);
  assertHttps(apiUrl, insecure);
  let manifestError;
  try {
    const res2 = await getJson(fetchFn, manifestUrl);
    if (res2.ok) return { release: parseManifest(await res2.json(), insecure) };
    manifestError = new Error(`manifest HTTP ${res2.status}`);
  } catch (err) {
    manifestError = err;
  }
  const headers = { Accept: "application/vnd.github+json" };
  if (etag) headers["If-None-Match"] = etag;
  const res = await getJson(fetchFn, apiUrl, headers);
  if (res.status === 304 && etag) return { notModified: true };
  if (!res.ok) {
    throw new Error(`Could not check for updates (manifest: ${(manifestError == null ? void 0 : manifestError.message) ?? manifestError}; GitHub: HTTP ${res.status})`);
  }
  const release = parseGithubReleases(await res.json(), insecure);
  if (!release) throw new Error(`No ${RELEASE_TAG_PREFIX}* release found`);
  return { release, etag: res.headers.get("etag") ?? void 0 };
}
async function checkForUpdate(options = {}) {
  const now = (options.now ?? Date.now)();
  const dataDir = options.dataDir ?? defaultDataDir$1();
  const current = options.currentVersion ?? CLI_VERSION;
  const cached = readCache(dataDir);
  try {
    if ((cached == null ? void 0 : cached.latestVersion) && now - cached.checkedAt < CHECK_INTERVAL_MS) {
      return { latestVersion: cached.latestVersion, latestTag: cached.latestTag, updateAvailable: compareVersions(cached.latestVersion, current) > 0 };
    }
    const result = await fetchLatestRelease(options, cached == null ? void 0 : cached.etag);
    if ("notModified" in result) {
      writeCache(dataDir, { ...cached, checkedAt: now });
      const v = cached.latestVersion;
      return { latestVersion: v, latestTag: cached.latestTag, updateAvailable: compareVersions(v, current) > 0 };
    }
    writeCache(dataDir, { checkedAt: now, latestVersion: result.release.version, latestTag: result.release.tag, etag: result.etag });
    return { latestVersion: result.release.version, latestTag: result.release.tag, updateAvailable: compareVersions(result.release.version, current) > 0 };
  } catch {
    return null;
  }
}
function updateAvailableNotice(latestVersion, currentVersion, isSea) {
  const how = isSea ? "run `aielia update`" : `run \`${NPM_UPDATE_HINT}\``;
  return `A newer aielia is available (${currentVersion} → ${latestVersion}) — ${how}.`;
}
function isRunningAsSea() {
  return loadSea() !== null;
}
function cleanupStaleUpdateFiles(execPath = process.execPath) {
  for (const stale of [`${execPath}.old`, `${execPath}.update.tmp`]) {
    try {
      if (existsSync(stale)) rmSync(stale, { force: true });
    } catch {
    }
  }
}
function replaceBinary(execPath, newFile, platform = process.platform) {
  if (platform === "win32") {
    const aside = `${execPath}.old`;
    rmSync(aside, { force: true });
    renameSync(execPath, aside);
    try {
      renameSync(newFile, execPath);
    } catch (err) {
      renameSync(aside, execPath);
      throw err;
    }
    return;
  }
  chmodSync(newFile, 493);
  renameSync(newFile, execPath);
}
async function downloadTo(fetchFn, url, dest) {
  const res = await fetchFn(url, { signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS), redirect: "follow" });
  if (!res.ok || !res.body) throw new Error(`Download failed: HTTP ${res.status} for ${url}`);
  const hash = createHash("sha256");
  await pipeline(
    Readable.fromWeb(res.body),
    async function* (source) {
      for await (const chunk of source) {
        hash.update(chunk);
        yield chunk;
      }
    },
    createWriteStream(dest)
  );
  return hash.digest("hex");
}
async function fetchSidecarHash(fetchFn, assetUrl) {
  try {
    const res = await getJson(fetchFn, `${assetUrl}.sha256`);
    if (!res.ok) return null;
    const m = /[0-9a-fA-F]{64}/.exec(await res.text());
    return m ? m[0].toLowerCase() : null;
  } catch {
    return null;
  }
}
async function runUpdateCommand(input = {}) {
  const log = input.log ?? ((line) => console.log(line));
  const isSea = input.isSea ?? isRunningAsSea();
  const current = input.currentVersion ?? CLI_VERSION;
  const dataDir = input.dataDir ?? defaultDataDir$1();
  const fetchFn = input.fetchFn ?? fetch;
  const insecure = input.allowInsecureHttp ?? false;
  if (!isSea) {
    log(`aielia update only replaces the standalone binary. This copy was installed with npm — run: ${NPM_UPDATE_HINT}`);
    return 1;
  }
  let release;
  try {
    const result = await fetchLatestRelease(input);
    if ("notModified" in result) throw new Error("unexpected 304");
    release = result.release;
    writeCache(dataDir, { checkedAt: (input.now ?? Date.now)(), latestVersion: release.version, latestTag: release.tag, etag: result.etag });
  } catch (err) {
    log(`Could not check for updates: ${err.message}`);
    return 1;
  }
  if (compareVersions(release.version, current) <= 0) {
    log(`aielia ${current} is up to date.`);
    return 0;
  }
  const key = platformKey(input);
  const asset = release.assets[key];
  if (!asset) {
    log(`Release ${release.tag} has no build for ${key}.`);
    return 1;
  }
  if (input.dryRun) {
    log(`Update available: ${current} → ${release.version} (${release.tag}). Would download ${asset.url}`);
    return 0;
  }
  const execPath = input.execPath ?? process.execPath;
  const tmp = `${execPath}.update.tmp`;
  try {
    assertHttps(asset.url, insecure);
    log(`Downloading aielia ${release.version} (${key})…`);
    const actual = await downloadTo(fetchFn, asset.url, tmp);
    const sidecar = await fetchSidecarHash(fetchFn, asset.url);
    const expected = asset.sha256 ?? sidecar;
    if (!expected) throw new Error("No checksum available for this release — refusing to install an unverified binary");
    if (actual !== expected) throw new Error(`Checksum mismatch (expected ${expected}, got ${actual}) — download discarded`);
    if (asset.sha256 && sidecar && sidecar !== asset.sha256) {
      throw new Error("Checksum sidecar disagrees with the release manifest — download discarded");
    }
    mkdirSync(dirname(execPath), { recursive: true });
    replaceBinary(execPath, tmp, input.platform);
    log(`Updated aielia ${current} → ${release.version}. Restart to use the new version.`);
    return 0;
  } catch (err) {
    rmSync(tmp, { force: true });
    log(`Update failed: ${err.message}`);
    return 1;
  }
}
const defaultDataDir = join(homedir(), ".buildaharness", "personal-assistant");
const defaultConfigStore = new NodeConfigStore(join(defaultDataDir, "config.json"));
const defaultRemindersFile = join(defaultDataDir, "reminders", "reminders.json");
const defaultEnvOverrides = envOverridesFromProcessEnv(process.env);
const defaultNonInteractiveApprovalMode = resolveNonInteractiveApprovalMode(process.env);
const defaultBackend = createNodeFsBackend();
function buildEmailSender(config) {
  if (!config.enableEmail || !config.emailFrom) return void 0;
  if (config.emailProvider === "smtp" && config.smtpHost && config.smtpPort) {
    return createSmtpSender({
      host: config.smtpHost,
      port: config.smtpPort,
      auth: config.smtpUser && config.smtpPass ? { user: config.smtpUser, pass: config.smtpPass } : void 0,
      from: config.emailFrom
    });
  }
  if (config.emailProvider === "resend" && config.resendApiKey) {
    return createResendSender({ apiKey: config.resendApiKey, from: config.emailFrom });
  }
  return void 0;
}
function buildLlmClient(config, workspaceRoot, remindersFile) {
  switch (config.llmBackend) {
    case "claude-cli":
      return new ClaudeCliLLMClient({
        fileTools: { workspaceRoot },
        remindersFile,
        shellTools: config.enableShell ? { workspaceRoot } : void 0,
        webTools: config.enableWeb ? { braveApiKey: config.braveApiKey } : void 0,
        actionTools: config.enableEmail ? { workspaceRoot } : void 0
      });
    case "anthropic":
      return new AnthropicLLMClient({ apiKey: config.apiKey ?? "" });
    case "openai":
      return new OpenAICompatibleLLMClient({ apiKey: config.apiKey ?? "", baseUrl: OPENAI_BASE_URL, defaultModel: OPENAI_DEFAULT_MODEL });
    case "openrouter":
      return new OpenAICompatibleLLMClient({
        apiKey: config.apiKey ?? "",
        baseUrl: OPENROUTER_BASE_URL,
        defaultModel: OPENROUTER_DEFAULT_MODEL,
        extraHeaders: OPENROUTER_EXTRA_HEADERS
      });
    case "proxy":
      return new LLMClient({ proxyUrl: config.proxyUrl, authToken: config.authToken });
  }
}
async function buildAssistant(config, { backend, dataDir, remindersFile }) {
  const workspaceRoot = config.workspaceRoot ?? process.cwd();
  const search = (query) => braveSearch(query, config.braveApiKey);
  const llmClient = buildLlmClient(config, workspaceRoot, remindersFile);
  return PersonalAssistant.create({
    llmClient,
    model: config.model,
    // config.activeProject (set via /project <name>) overrides the default of "the workspace
    // I'm running in" — see PersonalAssistantOptions.activeProject's doc comment.
    activeProject: config.activeProject || workspaceRoot,
    memoryBudgetChars: config.memoryBudgetChars,
    memoryWriteMode: config.memoryWriteMode,
    // M5: consolidation proposals are staged for /memory consolidate; the CLI has the controls, so it may raise them on /new.
    consolidateOnNewSession: true,
    memory: new FileSystemAdapter({ backend, baseDir: dataDir, namespace: "transcripts" }),
    experienceStore: await FileSystemExperienceStore.create({ backend, baseDir: dataDir, namespace: "experience" }),
    checkpointStore: new FileSystemAdapter({ backend, baseDir: dataDir, namespace: "checkpoints" }),
    reminderStore: new InMemoryReminderStore(new FileSystemAdapter({ backend, baseDir: dataDir, namespace: "reminders" })),
    fileTools: { backend, workspaceRoot },
    webTools: config.enableWeb ? { search } : void 0,
    // executeCommand is the real child_process.spawn-based implementation (shell-executor.ts) —
    // wired in here, not inside assistant.ts, so the browser build never needs node:child_process.
    shellTools: config.enableShell ? { backend, workspaceRoot, timeoutMs: config.shellTimeoutMs, networkAllowlist: config.shellNetworkAllowlist, executeCommand: runApprovedShellCommand } : void 0,
    // The Resend/SMTP transport is wired in here, not inside assistant.ts, so the browser build
    // never needs nodemailer or a mail server — same split as shellTools' executeCommand.
    actionTools: (() => {
      const sendEmail = buildEmailSender(config);
      return sendEmail ? { backend, workspaceRoot, sendEmail } : void 0;
    })(),
    dangerouslySkipPermissions: config.dangerouslySkipPermissions,
    spendCap: config.sessionCostLimitUsd !== void 0 || config.sessionCallLimit !== void 0 ? { sessionCostLimitUsd: config.sessionCostLimitUsd, sessionCallLimit: config.sessionCallLimit } : void 0,
    // Resolved through the shared config seam (cli-config.ts's envOverridesFromProcessEnv reads
    // ASSISTANT_ONE_LOOP into config.oneLoopMode; /config set oneLoopMode persists it) so the CLI,
    // chat-ui, and the Tauri desktop build all decide this the same way. Undefined here means
    // PersonalAssistant falls back to DEFAULT_ONE_LOOP_MODE.
    oneLoopMode: config.oneLoopMode,
    layerPolicyMode: config.layerPolicyMode,
    // R7: turn-end next-step options and DONE-thread suggestions. Undefined config means the
    // package default (enabled); PersonalAssistant itself defaults to disabled, so this is where
    // the front end opts in.
    goalGraphSuggestMode: isGoalGraphSuggestEnabled(config.goalGraphSuggestMode) ? "enabled" : "disabled",
    // P11 of the internal plan — resolved through the same shared config
    // seam as oneLoopMode above (ASSISTANT_PLAN_MODE / `/config set planMode`). Undefined here
    // means PersonalAssistant falls back to DEFAULT_PLAN_MODE ('legacy').
    planMode: config.planMode,
    ambiguityGuardMode: config.ambiguityGuardMode
  });
}
async function runCli(options = {}) {
  console.log("Aielia is alpha software — expect rough edges and breaking changes. It uses AI models and can make mistakes; verify anything important.\n");
  const dataDir = options.dataDir ?? defaultDataDir;
  const configStore = options.configStore ?? defaultConfigStore;
  const backend = options.backend ?? defaultBackend;
  const remindersFile = options.remindersFile ?? defaultRemindersFile;
  const envOverrides = options.envOverrides ?? defaultEnvOverrides;
  const nonInteractiveApprovalMode = options.nonInteractiveApprovalMode ?? defaultNonInteractiveApprovalMode;
  const inputStream = options.input ?? process.stdin;
  const outputStream = options.output ?? process.stdout;
  let persisted = await configStore.load();
  let { config, overriddenKeys } = resolveConfig(persisted, envOverrides);
  let layerPins = applyLayerSettings(sanitizeLayerChoices(config.layers), process.env).pinned;
  if (!options.skipFirstRunSetup && !options.assistant) {
    const isInteractive = inputStream.isTTY === true;
    let setupRl;
    const firstRunAsk = options.firstRunAsk ?? ((question) => {
      setupRl ?? (setupRl = createInterface({ input: inputStream, output: outputStream }));
      return new Promise((resolvePrompt) => {
        setupRl.question(question, (answer) => resolvePrompt(answer.trim()));
      });
    });
    try {
      persisted = await maybeRunFirstRunSetup({
        configStore,
        persisted,
        overriddenKeys,
        isInteractive,
        ask: firstRunAsk,
        log: (line) => outputStream.write(`${line}
`),
        testKey: options.firstRunTestKey ?? ((backend2, key) => testApiKey(backend2, key))
      });
    } finally {
      setupRl == null ? void 0 : setupRl.close();
    }
    ({ config, overriddenKeys } = resolveConfig(persisted, envOverrides));
    layerPins = applyLayerSettings(sanitizeLayerChoices(config.layers), process.env).pinned;
  }
  try {
    validateConfig({}, config);
  } catch (err) {
    if (!(err instanceof ConfigValidationError)) throw err;
    console.error(err.message);
    process.exit(1);
  }
  if (nonInteractiveApprovalMode === "require-tty" && !process.stdin.isTTY) {
    console.error(
      `ASSISTANT_NON_INTERACTIVE_APPROVAL=require-tty is set, but stdin is not a real TTY (piped/scripted input). Refusing to start rather than fail confusingly at the first approval prompt — see README.md's "Non-interactive / scripted use" section for the alternative (ASSISTANT_NON_INTERACTIVE_APPROVAL=decline).`
    );
    process.exit(1);
  }
  let assistant = options.assistant ?? await buildAssistant(config, { dataDir, backend, remindersFile });
  const rl = createInterface({ input: options.input ?? process.stdin, output: options.output ?? process.stdout, prompt: "you> " });
  rl.pause();
  rl.on("SIGINT", () => {
    console.log("\nExiting.");
    process.exit(0);
  });
  const backendDisplayModel = {
    proxy: ANTHROPIC_DEFAULT_MODEL,
    "claude-cli": "(your Claude Code default)",
    anthropic: ANTHROPIC_DEFAULT_MODEL,
    openai: OPENAI_DEFAULT_MODEL,
    openrouter: OPENROUTER_DEFAULT_MODEL
  };
  console.log(`backend: ${config.llmBackend} (${config.model ?? backendDisplayModel[config.llmBackend]})`);
  const enabledCapabilities = [];
  if (config.enableWeb) enabledCapabilities.push("web search/fetch (brave)");
  if (config.enableShell) enabledCapabilities.push(`shell commands (${config.dangerouslySkipPermissions ? "NOT approval-gated" : "approval-gated"})`);
  const capabilitySuffix = enabledCapabilities.length > 0 ? ` — enabled: ${enabledCapabilities.join(", ")}` : "";
  const dangerBanner = config.dangerouslySkipPermissions ? "\n⚠ dangerouslySkipPermissions is ON — every approval prompt (risky messages, file writes, shell commands) is skipped automatically.\n" : "";
  const nonInteractiveBanner = nonInteractiveApprovalMode === "decline" ? "\nASSISTANT_NON_INTERACTIVE_APPROVAL=decline is set — every approval prompt auto-declines.\n" : "";
  const startupUndoLogEntries = await assistant.listUndoLogEntries();
  const undoableFromBefore = startupUndoLogEntries.filter((e) => e.undoable).length;
  const undoBanner = undoableFromBefore > 0 ? `
${undoableFromBefore} action${undoableFromBefore === 1 ? "" : "s"} from earlier sessions ${undoableFromBefore === 1 ? "is" : "are"} still revertible — see /undo-action.
` : "";
  console.log(`Aielia — your personal assistant on the 11-layer harness, one turn at a time. Ctrl+C to exit.${capabilitySuffix}
${dangerBanner}${nonInteractiveBanner}${undoBanner}`);
  console.log("Type /help to see all commands, /config to view settings.\n");
  void assistant.proposeMemoryConsolidation("cli").catch(() => void 0);
  rl.prompt();
  let lastTrace;
  let lastSources;
  let lastPlanStatus;
  let pendingPlanApproval;
  let lastTurnUsage;
  let lastTurnToolSteps = [];
  let lastNoTraceReason;
  const rememberedActionKinds = /* @__PURE__ */ new Set();
  const rememberedRiskLevels = /* @__PURE__ */ new Set();
  const APPROVAL_OPTIONS = [
    { key: "y", label: "Yes" },
    { key: "a", label: "Yes, don't ask again this session" },
    { key: "n", label: "No" }
  ];
  function withCostEstimate(usage) {
    if (config.llmBackend === "claude-cli" || usage.costUsd !== void 0) return usage;
    const estimated = estimateCostUsd(config.model ?? ANTHROPIC_DEFAULT_MODEL, usage);
    return estimated !== void 0 ? { ...usage, costUsd: estimated } : usage;
  }
  const PLAN_TASK_STATUS_ICON = {
    PENDING: "○",
    RUNNING: "▶",
    COMPLETE: "✓",
    FAILED: "✗",
    BLOCKED: "✗",
    HUMAN_REQUIRED: "~"
  };
  function printPlan() {
    if (!lastPlanStatus) {
      console.log("\nNo active plan for this session.\n");
      return;
    }
    const lines = [
      PLAN_LINE_PREFIX,
      `Plan: ${lastPlanStatus.templateName ?? "custom plan"} (${lastPlanStatus.completionPct.toFixed(1)}% complete)`,
      ...lastPlanStatus.tasks.flatMap((task) => [
        `  ${PLAN_TASK_STATUS_ICON[task.status] ?? "?"} [${task.status}] ${task.id} — ${task.description}`,
        ...task.note ? [`      not accepted as done: ${task.note}`] : []
      ]),
      `Success criteria: ${lastPlanStatus.successCriteria}`
    ];
    console.log(`
${lines.join("\n")}
`);
  }
  async function handlePlanSketch(args) {
    const request = args.join(" ").trim();
    if (!request) {
      console.log("\nUsage: /plan sketch <request>\n");
      return;
    }
    console.log("\nSketching a plan (read-only grounding only, nothing staged)...\n");
    const result = await assistant.sketchPlan("cli", request);
    console.log(`Aielia> ${result.reply ?? "(no reply)"}
`);
    if (result.usage) lastTurnUsage = withCostEstimate(result.usage);
  }
  const PLAN_APPROVAL_OPTIONS = [
    { key: "y", label: "Approve" },
    { key: "e", label: "Approve with edits" },
    { key: "t", label: "Approve & trust this plan (its write/shell steps stop re-prompting)" },
    { key: "d", label: "Decide later — /plan approve|edit|decline" },
    { key: "n", label: "Decline" }
  ];
  function printPlanApproval(snapshot) {
    const lines = [
      PLAN_LINE_PREFIX,
      `Plan ready for approval${snapshot.templateName ? `: ${snapshot.templateName}` : " (custom plan)"}`,
      `Success criteria: ${snapshot.successCriteria}`,
      ...snapshot.rationale ? [`Why: ${snapshot.rationale}`] : [],
      ...snapshot.tasks.map((task) => `  ${task.riskLevel === "HIGH" ? "!" : task.riskLevel === "MEDIUM" ? "·" : "○"} [${task.riskLevel ?? "LOW"}] ${task.id} — ${task.description}`),
      ...snapshot.reviewNotes && snapshot.reviewNotes.length > 0 ? ["Review notes:", ...snapshot.reviewNotes.map((note) => `  - ${note}`)] : []
    ];
    console.log(`
${lines.join("\n")}
`);
  }
  async function promptPlanEdits(snapshot) {
    const knownIds = new Set(snapshot.tasks.map((task) => task.id));
    const cancelRaw = await askLine("Task ids to cancel (comma-separated, blank for none): ");
    const editRaw = await askLine('Edits as "id=new description" pairs separated by ";", e.g. t2=Reword this. (blank for none): ');
    const cancelTaskIds = cancelRaw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    const parsedEdits = editRaw.split(";").map((pair) => pair.trim()).filter(Boolean).map((pair) => {
      const sep = pair.indexOf("=");
      return sep >= 0 ? { id: pair.slice(0, sep).trim(), description: pair.slice(sep + 1).trim() } : { id: pair, description: "" };
    });
    const validCancels = cancelTaskIds.filter((id) => knownIds.has(id));
    const validEdits = parsedEdits.filter((edit) => knownIds.has(edit.id) && edit.description);
    const unknown = [...cancelTaskIds.filter((id) => !knownIds.has(id)), ...parsedEdits.filter((e) => !knownIds.has(e.id)).map((e) => e.id)];
    if (unknown.length > 0) console.log(`  [ignoring unknown task id(s): ${[...new Set(unknown)].join(", ")}]`);
    return {
      ...validCancels.length > 0 ? { cancelTaskIds: validCancels } : {},
      ...validEdits.length > 0 ? { editedTasks: validEdits } : {}
    };
  }
  async function handlePlanApprovalCommand(sub) {
    if (!pendingPlanApproval) {
      console.log("\nNo plan is awaiting approval.\n");
      return;
    }
    const { id, message, snapshot } = pendingPlanApproval;
    let decision;
    let edits;
    if (sub === "approve") {
      decision = "approve";
    } else if (sub === "trust") {
      decision = "approve_trusted";
    } else if (sub === "edit") {
      if (!snapshot) {
        console.log("\n[tasks unavailable for editing — /plan approve or /plan decline]\n");
        return;
      }
      printPlanApproval(snapshot);
      edits = await promptPlanEdits(snapshot);
      decision = "approve_with_edits";
    } else {
      decision = "decline";
    }
    pendingPlanApproval = void 0;
    lastTrace = void 0;
    lastNoTraceReason = `No harness trace — the last turn staged a plan that was ${decision === "decline" ? "declined" : "approved"} before the harness ran.`;
    await handleTurn(message, false, void 0, void 0, void 0, id, decision, edits);
  }
  async function loadPlanGraphNodes(live, threadId) {
    const record = await assistant.getPlanGraph("cli");
    if (!record) return void 0;
    let nodes = planToSnapshot(record, live ?? []).nodes;
    if (threadId) nodes = nodes.filter((n) => n.id.startsWith(`${threadId}__`));
    return nodes.length ? nodes : void 0;
  }
  async function handlePlanGraph(args) {
    const nodes = await loadPlanGraphNodes(void 0, args[0]);
    if (!nodes) {
      console.log(args[0] ? `
No plan graph for thread "${args[0]}".
` : "\nNo active plan for this session.\n");
      return;
    }
    if (options.openPlanGraph) {
      const probe = renderPlan(nodes, { maxCols: 80 });
      if (probe.ok) {
        options.openPlanGraph(nodes);
        return;
      }
      console.log(`
[plan graph unavailable: ${probe.message}] showing the checklist instead.`);
      printPlan();
      return;
    }
    const cols = process.stdout.columns || 80;
    const color = Boolean(process.stdout.isTTY) && !process.env.NO_COLOR;
    const result = renderPlan(nodes, { maxCols: cols, color });
    if (!result.ok) {
      console.log(`
[plan graph unavailable: ${result.message}] showing the checklist instead.`);
      printPlan();
      return;
    }
    if (!result.fits) {
      console.log(`
[plan graph is wider than ${cols} columns] dependency list:
`);
      for (const n of nodes) console.log(`  [${n.status}] ${n.id} — ${n.label}${n.deps.length ? `  (after: ${n.deps.join(", ")})` : ""}`);
      console.log("");
      return;
    }
    console.log(`
${result.lines.join("\n")}
`);
  }
  async function handlePlan(args) {
    const sub = args[0];
    if (sub === "graph" && isPlanGraphEnabled(config.planGraphMode)) {
      await handlePlanGraph(args.slice(1));
      return;
    }
    if (sub === "sketch") {
      await handlePlanSketch(args.slice(1));
      return;
    }
    if (sub === "approve" || sub === "trust" || sub === "edit" || sub === "decline") {
      await handlePlanApprovalCommand(sub);
      return;
    }
    if (pendingPlanApproval == null ? void 0 : pendingPlanApproval.snapshot) {
      printPlanApproval(pendingPlanApproval.snapshot);
      return;
    }
    printPlan();
  }
  function verificationHealthLabel({ strength, feasibility }) {
    const confidence = Math.min(strength, feasibility);
    if (confidence >= 0.7) return "High confidence";
    if (confidence >= 0.4) return "Reasonably confident";
    return "Worth double-checking";
  }
  function batchBudgetSummaryLine(batchBudget) {
    const found = batchBudget.perItemOutcomes.filter((o) => o.status === "found").length;
    const notFound = batchBudget.perItemOutcomes.filter((o) => o.status === "not_found").length;
    const truncated = batchBudget.perItemOutcomes.filter((o) => o.status === "truncated_while_productive").length;
    return `Batch: ${batchBudget.itemCount} items — ${found} found, ${notFound} not found, ${truncated} truncated (${batchBudget.totalCallsUsed} calls used, projected ~${Math.ceil(batchBudget.projectedTotal)})`;
  }
  function printWhy() {
    const memoryLine = formatMemoryInjection(assistant.getLastMemoryInjection());
    if (!lastTrace) {
      console.log(`
${lastNoTraceReason ?? "No harness trace for the last turn (nothing to explain yet, or it took the fast path)."}
${memoryLine}
`);
      return;
    }
    console.log(`
${verificationHealthLabel(lastTrace.verificationHealth)}`);
    const chain = buildWhyChain(lastTrace.layerActivity);
    if (chain.length > 0) {
      console.log("  " + chain.map((item) => `${LAYER_SHORT_CODE[item.layer]} (${item.reason})`).join(" > "));
    }
    if (lastTrace.batchBudget) {
      console.log("  " + batchBudgetSummaryLine(lastTrace.batchBudget));
    }
    console.log(memoryLine);
    console.log("");
  }
  function printLayers() {
    if (!lastTrace) {
      console.log(`
${lastNoTraceReason ?? "No harness trace for the last turn (nothing to explain yet, or it took the fast path)."}
`);
      return;
    }
    console.log("");
    const byLayer = new Map(lastTrace.layerActivity.map((e) => [e.layer, e]));
    for (const layer of LAYER_ORDER) {
      const e = byLayer.get(layer);
      const mark = (e == null ? void 0 : e.fired) ? "✓" : "·";
      const reason = (e == null ? void 0 : e.reason) ?? "not evaluated this turn";
      console.log(`  [${mark}] ${LAYER_DISPLAY_NAME[layer].padEnd(22)} ${reason}`);
    }
    if (lastTrace.batchBudget) {
      console.log("");
      console.log(`  ${batchBudgetSummaryLine(lastTrace.batchBudget)}`);
      const STATUS_MARK = {
        found: "✓",
        not_found: "✗",
        truncated_while_productive: "~"
      };
      for (const outcome of lastTrace.batchBudget.perItemOutcomes) {
        console.log(`    [${STATUS_MARK[outcome.status]}] ${outcome.item.padEnd(30)} ${outcome.status} (${outcome.callsUsed} calls)`);
      }
    }
    console.log("");
  }
  const SOURCE_TOOL_LABEL = {
    read_file: "Read",
    list_directory: "Listed",
    web_search: "Searched",
    fetch_url: "Fetched"
  };
  function printSources() {
    if (!lastSources || lastSources.length === 0) {
      console.log("\nNo sources for the last turn (it used no file/web tool calls).\n");
      return;
    }
    console.log("");
    for (const source of lastSources) {
      console.log(`  - ${SOURCE_TOOL_LABEL[source.tool]} ${source.path}`);
    }
    console.log("");
  }
  function printHelp() {
    console.log(`
${formatHelp()}
`);
  }
  async function handleClear() {
    await assistant.clearSession("cli");
    lastTrace = void 0;
    lastSources = void 0;
    lastPlanStatus = void 0;
    pendingPlanApproval = void 0;
    lastTurnUsage = void 0;
    lastNoTraceReason = void 0;
    console.log("\n✓ Started a fresh conversation.\n");
  }
  async function handleCheckpoint(args) {
    if (args[0] === "clear") {
      const result = await assistant.clearCheckpoint("cli");
      console.log(
        result.cleared ? `
✓ Cleared the stuck checkpoint (was at step ${result.stepsUsed}, node "${result.currentNode}"). Conversation history is untouched — your next message starts a fresh harness run.
` : "\nNo checkpoint to clear — the last turn either completed normally or there was nothing in progress.\n"
      );
      return;
    }
    const status = await assistant.getCheckpointStatus("cli");
    if (!status.present) {
      console.log("\nNo checkpoint present — the last turn completed normally or there was nothing in progress.\n");
      return;
    }
    const attemptsNote = status.failedResumeAttempts > 0 ? ` — failed to resume ${status.failedResumeAttempts} time${status.failedResumeAttempts === 1 ? "" : "s"} in a row so far` : "";
    console.log(
      `
A checkpoint is present: step ${status.stepsUsed}, last node "${status.currentNode}"${attemptsNote}.
Your next message will try to resume it automatically. Run /checkpoint clear to discard it and start fresh instead.
`
    );
  }
  async function printStatus() {
    const transcript = await assistant.getTranscript("cli");
    const undoLogEntries = await assistant.listUndoLogEntries();
    const spendCapLine = await spendCapStatusLine();
    console.log(
      `
${formatStatus({ config, overriddenKeys, transcriptLength: transcript.length, planActive: lastPlanStatus !== void 0, undoLogEntries, spendCapLine })}
`
    );
  }
  async function spendCapStatusLine() {
    if (config.sessionCostLimitUsd === void 0 && config.sessionCallLimit === void 0) return void 0;
    const state = await assistant.getSpendState("cli");
    return formatSpendCapStatus(state, { sessionCostLimitUsd: config.sessionCostLimitUsd, sessionCallLimit: config.sessionCallLimit });
  }
  async function handleExport(args) {
    const transcript = await assistant.getTranscript("cli");
    if (transcript.length === 0) {
      console.log("\nNothing to export yet.\n");
      return;
    }
    const filename = resolve(process.cwd(), args[0] ?? defaultExportFilename());
    try {
      await writeFile(filename, formatTranscriptMarkdown(transcript), "utf-8");
      console.log(`
✓ Exported ${transcript.length} message${transcript.length === 1 ? "" : "s"} to ${filename}
`);
    } catch (err) {
      const { message } = classifyError(err);
      console.log(`
[error] ${message}
`);
    }
  }
  async function handleUndo() {
    const transcriptBefore = await assistant.getTranscript("cli");
    if (transcriptBefore.length === 0) {
      console.log("\nNothing to undo.\n");
      return;
    }
    const wasPendingApproval = transcriptBefore[transcriptBefore.length - 1].role !== "assistant";
    const undoneReminders = lastTurnToolSteps.filter((s) => s.tool === "create_reminder");
    const result = await assistant.undoLastTurn("cli");
    if (!result.undone) {
      console.log("\nNothing to undo.\n");
      return;
    }
    lastTrace = void 0;
    lastSources = void 0;
    lastPlanStatus = void 0;
    lastTurnToolSteps = [];
    const caveat = undoneReminders.length > 0 ? ` Note: ${undoneReminders.length === 1 ? "a reminder" : `${undoneReminders.length} reminders`} created in that exchange (${undoneReminders.map((s) => `"${s.input.text}"`).join(", ")}) ${undoneReminders.length === 1 ? "is" : "are"} still active — /undo only removes chat history, not that side effect.` : "";
    console.log(
      `
✓ Removed ${wasPendingApproval ? "the pending message awaiting approval" : "the last exchange (1 user message, 1 assistant reply)"}.${caveat}
`
    );
  }
  async function handleUndoAction(args) {
    if (args.length === 0) {
      const entries = await assistant.listUndoLogEntries();
      console.log(`
${formatUndoLogListing(entries)}
`);
      return;
    }
    const staged = await assistant.stageUndoAction(args[0]);
    if (staged.status === "error") {
      console.log(`
✗ ${staged.message}
`);
      return;
    }
    console.log(`
[needs approval — revert] ${staged.reason}`);
    const confirmed = await askYesNo("Apply this revert? (y/N) ");
    lastTrace = void 0;
    lastNoTraceReason = `No harness trace — the last turn was a staged revert that was ${confirmed ? "approved" : "declined"} before the harness ran.`;
    await handleTurn("", confirmed, staged.pendingActionId);
  }
  async function printMemory() {
    const summary = await assistant.getMemorySummary("cli");
    const digests = await assistant.listSessionDigests();
    const digestLine = digests.length > 0 ? `
Session digests stored: ${digests.length} (/memory forget digest [id] erases them; /memory export includes them).
` : "";
    console.log(`
${formatMemoryStatus(await assistant.getMemoryStatus("cli"))}

${formatMemorySummary(summary)}
${digestLine}`);
  }
  async function handleMemoryExport(args) {
    const data = await assistant.exportMemory("cli");
    const filename = resolve(process.cwd(), args[0] ?? defaultMemoryExportFilename());
    try {
      await writeFile(filename, formatMemoryExport(data), "utf-8");
      console.log(`
✓ Exported learned memory to ${filename}
`);
    } catch (err) {
      const { message } = classifyError(err);
      console.log(`
[error] ${message}
`);
    }
  }
  async function handleMemoryPending(action, args) {
    const selector = args[0];
    if (!selector) {
      console.log(`
Usage: /memory ${action} <n> or /memory ${action} <category>
`);
      return;
    }
    const outcome = action === "confirm" ? await assistant.confirmPendingFact(selector) : await assistant.rejectPendingFact(selector);
    console.log(`
${formatMemoryPendingOutcome(action === "confirm" ? "confirmed" : "rejected", outcome)}
`);
  }
  async function handleMemoryForget(args) {
    const selector = args[0];
    if (!selector) {
      console.log("\nUsage: /memory forget <n> [erase]\n");
      return;
    }
    const erase = args[1] === "erase";
    const outcome = await assistant.forgetFact(selector, "cli", erase);
    const note = outcome.ok && !erase && memoryAuditLogEnabled() ? " The audit log still holds its text (see /memory history); use `/memory forget <n> erase` to remove that too." : "";
    console.log(`
${formatMemoryPendingOutcome("forgotten", outcome)}${note}
`);
  }
  async function handleMemory(args) {
    if (args[0] === "export") {
      await handleMemoryExport(args.slice(1));
      return;
    }
    if (args[0] === "confirm" || args[0] === "reject") {
      await handleMemoryPending(args[0], args.slice(1));
      return;
    }
    if (args[0] === "forget" && (args[1] === "digest" || args[1] === "digests")) {
      const removed = await assistant.forgetDigests(args[2]);
      console.log(`
Forgot ${removed} session digest${removed === 1 ? "" : "s"}.
`);
      return;
    }
    if (args[0] === "forget") {
      await handleMemoryForget(args.slice(1));
      return;
    }
    if (args[0] === "history") {
      console.log(`
${formatMemoryHistory(await assistant.memoryHistory())}
`);
      return;
    }
    if (args[0] === "status") {
      console.log(`
${formatMemoryStatus(await assistant.getMemoryStatus("cli"))}
`);
      return;
    }
    if (args[0] === "archive") {
      if (args[1] === "forget") {
        const outcome = await assistant.forgetArchivedFact(args[2] ?? "");
        console.log(`
${formatMemoryPendingOutcome("forgotten", outcome)}
`);
        return;
      }
      if (args[1] === "restore") {
        const outcome = await assistant.restoreArchivedMemory(args[2] ?? "", "cli");
        console.log(`
${outcome.message}
`);
        return;
      }
      console.log(`
${formatMemoryArchive(await assistant.listArchivedFacts(), await assistant.restorableArchiveCount())}
`);
      return;
    }
    if (args[0] === "off" || args[0] === "on") {
      await assistant.setMemoryEnabled(args[0] === "on");
      console.log(args[0] === "off" ? "\nMemory writes are OFF for this install: nothing new will be saved (facts, pending guesses, digests). What is already stored stays readable; /memory forget and /memory reject still work. /memory on resumes.\n" : "\nMemory writes are on.\n");
      return;
    }
    if (args[0] === "undo") {
      const outcome = await assistant.undoMemoryChange(args[1] ?? "", "cli");
      console.log(`
${outcome.message}
`);
      return;
    }
    if (args[0] === "consolidate") {
      await handleMemoryConsolidate(args.slice(1));
      return;
    }
    await printMemory();
  }
  async function handleMemoryConsolidate(args) {
    if (args[0] === "accept" || args[0] === "dismiss") {
      const outcome2 = args[0] === "accept" ? await assistant.acceptMemoryProposal(args[1] ?? "", "cli") : await assistant.dismissMemoryProposal(args[1] ?? "");
      console.log(`
${outcome2.message}
`);
      return;
    }
    const outcome = await assistant.consolidateMemory("cli");
    const proposals = await assistant.memoryProposals();
    if (proposals.length === 0) {
      console.log(`
${outcome.message}
`);
      return;
    }
    console.log(`
${outcome.status === "done" ? "" : `${outcome.message}
`}Proposed changes (nothing applied yet):
${proposals.map((p, i) => `  ${i + 1}. [${p.kind}]${p.touchesUserAsserted ? " (touches something you said yourself)" : ""} ${p.text ? `-> "${p.text}" ` : ""}${p.reason}`).join("\n")}
  Use /memory consolidate accept <n> or dismiss <n>.
`);
  }
  async function handleSearch(args) {
    const query = args.join(" ");
    if (!query.trim()) {
      console.log("\nUsage: /search <query>\n");
      return;
    }
    const hits = await assistant.searchTranscript(query);
    console.log(`
${formatSearchResults(hits, query)}
`);
  }
  async function handleGoals() {
    const state = await assistant.getGoalGraphState("cli");
    console.log(`
${formatGoalGraphState(state)}
`);
  }
  async function printCost() {
    const spendCapLine = await spendCapStatusLine();
    const spendState = await assistant.getSpendState("cli");
    const session = { inputTokens: spendState.cumulativeInputTokens, outputTokens: spendState.cumulativeOutputTokens, costUsd: spendState.cumulativeCostUsd };
    console.log(`
${formatCostSummary({ lastTurn: lastTurnUsage, session, backend: config.llmBackend, spendCapLine })}
`);
  }
  async function handleDoctor() {
    const workspaceRoot = config.workspaceRoot ?? process.cwd();
    const checks = await Promise.all([
      // Backend-specific checks only run for the backend actually in use — skipped, not
      // reported as failing, for the one that's inactive.
      ...config.llmBackend === "proxy" ? [checkProxyHealth(config.proxyUrl)] : [],
      ...config.llmBackend === "claude-cli" ? [checkClaudeCli(process.env.CLAUDE_PATH ?? "claude")] : [],
      checkWorkspaceRoot(workspaceRoot),
      checkDataDirWritable(backend, dataDir),
      ...checkMemoryHealth(await assistant.getMemoryStatus("cli")),
      // Informational only (always ok:true) — surfaces the active backend/flags so a user has
      // one command to confirm config, rather than none (see file's own config summary gap).
      { label: `llmBackend: ${config.llmBackend}`, ok: true },
      { label: `enableShell: ${config.enableShell ?? false}, enableWeb: ${config.enableWeb ?? false}`, ok: true },
      // Provider API keys are stored plaintext in config.json, not an OS keychain — confirming
      // that explicitly here rather than leaving it unstated (no keychain integration exists).
      { label: "provider keys stored: plaintext in config.json (no OS keychain integration)", ok: true }
    ]);
    console.log(`
${formatDoctorReport(checks)}
`);
  }
  let lastProgressLineLength = 0;
  function writeProgress(progress) {
    const layer = nodeToLayer(progress.currentNode);
    const label = layer ? LAYER_DISPLAY_NAME[layer] : nodeDisplayName(progress.currentNode);
    const prefix = progress.planPosition ? `[${progress.planPosition.templateName ?? "custom plan"} — step ${progress.planPosition.stepIndex}/${progress.planPosition.stepCount} (${progress.planPosition.completionPct.toFixed(0)}%)]` : `[step ${progress.stepsUsed}/${progress.maxSteps}]`;
    const line = `${prefix}${label ? ` ${label}…` : ""}`;
    process.stdout.write(`\r${line.padEnd(lastProgressLineLength)}`);
    lastProgressLineLength = line.length;
  }
  function clearProgress() {
    if (lastProgressLineLength === 0) return;
    process.stdout.write(`\r${" ".repeat(lastProgressLineLength)}\r`);
    lastProgressLineLength = 0;
  }
  function writeToolStep(step) {
    clearProgress();
    if (step.deniedReason) {
      console.log(`  ${ICONS.deniedStep} Denied: ${step.summary} — ${step.deniedReason}`);
    } else {
      console.log(`  ${toolStepIcon(step.tool)} ${step.summary}`);
    }
    lastTurnToolSteps.push(step);
  }
  function emptyClarificationDraft() {
    return { selectedLabels: [], editText: "", freeText: "" };
  }
  function orderedAskOptions(question) {
    const options2 = question.options ?? [];
    return options2.map((option, index) => ({ option, index })).sort((a, b) => Number(b.option.recommended ?? false) - Number(a.option.recommended ?? false) || a.index - b.index).map(({ option }) => option);
  }
  function clarificationDraftToAnswer(questionId, draft) {
    if (draft.selectedLabels.length > 0) {
      return draft.editText.trim() ? { questionId, kind: "selected_with_edit", selectedLabels: draft.selectedLabels, editText: draft.editText.trim() } : { questionId, kind: "selected", selectedLabels: draft.selectedLabels };
    }
    if (draft.freeText.trim()) {
      return { questionId, kind: "free_text", freeText: draft.freeText.trim() };
    }
    return null;
  }
  function printClarificationQuestion(question, draft, index, total) {
    const options2 = orderedAskOptions(question);
    const allowFreeText = question.allowFreeText !== false;
    console.log("");
    if (question.header) console.log(`[${question.header}]`);
    if (total > 1) console.log(`Question ${index + 1} of ${total}`);
    console.log(question.question);
    options2.forEach((option, i) => {
      const n = i + 1;
      const picked = draft.selectedLabels.includes(option.label) ? "✓" : " ";
      const recommended = option.recommended ? " (recommended)" : "";
      console.log(`  [${picked}] ${n}) ${option.label}${recommended}`);
      if (option.description) console.log(`        ${option.description}`);
      if (option.preview) console.log(`        preview: ${option.preview}`);
    });
    if (draft.editText) console.log(`  note: ${draft.editText}`);
    if (draft.freeText) console.log(`  other: ${draft.freeText}`);
    const commands2 = [
      options2.length > 0 ? question.allowMultiple ? "<n>/t<n> toggle option" : "<n> select option" : void 0,
      options2.length > 0 ? "e<n> add a note to a selected option" : void 0,
      allowFreeText ? "o other (free text)" : void 0,
      total > 1 ? "b back, n next" : void 0,
      "s submit"
    ].filter((c) => c !== void 0);
    console.log(`  (${commands2.join(" | ")})`);
  }
  async function handleClarification(result) {
    const questions = result.questions ?? [];
    const pendingClarificationId = result.pendingClarificationId;
    if (questions.length === 0 || !pendingClarificationId) {
      lastTrace = void 0;
      lastNoTraceReason = `No harness trace — the last turn needed clarification (${result.reason ?? "no further detail"}) but had no answerable questions.`;
      console.log(`
[needs clarification] ${result.reason ?? "This request needs clarification."}
`);
      return;
    }
    if (nonInteractiveApprovalMode === "decline") {
      console.log(`
[non-interactive mode: auto-declining — ASSISTANT_NON_INTERACTIVE_APPROVAL=decline]`);
      console.log(`
[needs clarification] ${result.reason ?? "This request needs clarification."}`);
      for (const q2 of questions) console.log(`  - ${q2.question}`);
      console.log("");
      lastTrace = void 0;
      lastNoTraceReason = "No harness trace — the last turn needed clarification and was auto-declined (non-interactive mode) before the harness resumed.";
      return;
    }
    console.log(`
[needs clarification] ${questions.length} question${questions.length === 1 ? "" : "s"} to answer.`);
    const drafts = new Map(questions.map((q2) => [q2.id, emptyClarificationDraft()]));
    let index = 0;
    while (true) {
      const question = questions[index];
      const draft = drafts.get(question.id);
      printClarificationQuestion(question, draft, index, questions.length);
      const token = (await askLine("clarify> ")).trim();
      const lower = token.toLowerCase();
      if (lower === "s" || lower === "submit") {
        const answers = questions.map((q2) => clarificationDraftToAnswer(q2.id, drafts.get(q2.id)));
        const missing = questions.filter((q2, i) => answers[i] === null);
        if (missing.length > 0) {
          console.log(`
Still need an answer for: ${missing.map((q2) => q2.question).join("; ")}
`);
          continue;
        }
        const response = { answers };
        await handleTurn("", false, void 0, pendingClarificationId, response);
        return;
      }
      if (lower === "b" && questions.length > 1) {
        index = Math.max(0, index - 1);
        continue;
      }
      if (lower === "n" && questions.length > 1) {
        index = Math.min(questions.length - 1, index + 1);
        continue;
      }
      if (lower === "o") {
        if (question.allowFreeText === false) {
          console.log("\nThis question does not accept a free-text answer.\n");
          continue;
        }
        const text = await askLine("Other — type your own answer: ");
        if (!text.trim()) {
          console.log("\nEmpty answer ignored.\n");
          continue;
        }
        drafts.set(question.id, { selectedLabels: [], editText: "", freeText: text.trim() });
        continue;
      }
      const editMatch = /^e(\d+)$/i.exec(token);
      if (editMatch) {
        const options2 = orderedAskOptions(question);
        const option = options2[Number(editMatch[1]) - 1];
        if (!option) {
          console.log(`
No option ${editMatch[1]}.
`);
          continue;
        }
        if (!draft.selectedLabels.includes(option.label)) {
          console.log(`
Select option ${editMatch[1]} first, then add a note with e${editMatch[1]}.
`);
          continue;
        }
        const note = await askLine("Note: ");
        drafts.set(question.id, { ...draft, editText: note.trim() });
        continue;
      }
      const toggleMatch = /^t(\d+)$/i.exec(token) ?? /^(\d+)$/.exec(token);
      if (toggleMatch) {
        const options2 = orderedAskOptions(question);
        const option = options2[Number(toggleMatch[1]) - 1];
        if (!option) {
          console.log(`
No option ${toggleMatch[1]}.
`);
          continue;
        }
        if (question.allowMultiple) {
          const already = draft.selectedLabels.includes(option.label);
          drafts.set(question.id, {
            ...draft,
            selectedLabels: already ? draft.selectedLabels.filter((l) => l !== option.label) : [...draft.selectedLabels, option.label],
            freeText: ""
          });
        } else {
          drafts.set(question.id, { ...draft, selectedLabels: [option.label], freeText: "" });
        }
        continue;
      }
      console.log(`
Unrecognized input "${token}".
`);
    }
  }
  async function handleTurn(message, approved = false, pendingActionId, pendingClarificationId, clarificationAnswer, planApprovalId, planDecision, planEdits) {
    lastTurnToolSteps = [];
    let streamedAnyTokens = false;
    function writeToken(token) {
      if (!streamedAnyTokens) {
        process.stdout.write("\nAielia> ");
        streamedAnyTokens = true;
      }
      process.stdout.write(token);
    }
    try {
      const result = await assistant.turn(message, {
        sessionId: "cli",
        approved,
        pendingActionId,
        pendingClarificationId,
        clarificationAnswer,
        planApprovalId,
        planDecision,
        planEdits,
        // Gated on streamedAnyTokens: onProgress keeps firing for layers (Memory,
        // Verification) that run after the LLM call, i.e. after writeToken has already put
        // the reply on the current line with no trailing newline. writeProgress's \r-based
        // overwrite doesn't know that — on a real TTY it wrote the "[step N/5] ..." text
        // over the tail of the just-streamed reply, and the following clearProgress() then
        // blanked that same line, so the end of the assistant's answer visibly vanished
        // right after it finished streaming. Once streaming has started this turn, further
        // progress has nothing safe to overwrite, so it's dropped instead.
        onProgress: (progress) => {
          var _a;
          if (progress.planTasks) (_a = options.onPlanProgress) == null ? void 0 : _a.call(options, progress.planTasks);
          if (!streamedAnyTokens) writeProgress(progress);
        },
        onToken: writeToken,
        onToolStep: writeToolStep,
        // Phase 4 — real intra-turn absorption via checkCallerUpdates, replacing Phase 3's
        // drain-as-follow-up-turns fallback in dispatchOne's `finally` below (kept there, but
        // only as a backstop: turn() re-enqueues anything it didn't get around to classifying
        // this turn — e.g. a trivial turn that never calls harnessBridge.run() at all — back onto
        // this same channel, see TurnOptions.steeringChannel's doc comment). Passed unconditionally:
        // with goalGraphMode off, routeMessage (below) never enqueues into steeringChannel, so it's
        // always empty and this resolves to exactly today's behavior (INV-43).
        steeringChannel
      });
      if (!streamedAnyTokens) clearProgress();
      if (result.status === "needs_approval" && result.pendingActionId) {
        const kindLabel = result.pendingActionKind === "shell" ? "shell command" : result.pendingActionKind === "email" ? "send email" : result.pendingActionKind === "batch" ? "batch research" : "write";
        const promptText = result.pendingActionKind === "shell" ? "Run this command?" : result.pendingActionKind === "email" ? "Send this email?" : result.pendingActionKind === "batch" ? "Continue?" : "Apply this write?";
        console.log(`
[needs approval — ${kindLabel}] ${result.reason}`);
        let confirmed;
        if (result.pendingActionKind && rememberedActionKinds.has(result.pendingActionKind)) {
          console.log(`["don't ask again" active this session for ${kindLabel} — auto-approved]`);
          confirmed = true;
        } else {
          const decision = await askSelect(promptText, APPROVAL_OPTIONS);
          confirmed = decision !== "n";
          if (decision === "a" && result.pendingActionKind) rememberedActionKinds.add(result.pendingActionKind);
        }
        lastTrace = void 0;
        lastNoTraceReason = `No harness trace — the last turn was a staged ${kindLabel} that was ${confirmed ? "approved" : "declined"} before the harness ran.`;
        await handleTurn(message, confirmed, result.pendingActionId);
        return;
      }
      if (result.status === "needs_approval") {
        console.log(`
[needs approval — ${result.riskLevel}] ${result.reason}`);
        console.log(`  "${message}"`);
        let confirmed;
        if (result.riskLevel && rememberedRiskLevels.has(result.riskLevel)) {
          console.log(`["don't ask again" active this session for risk level ${result.riskLevel} — auto-approved]`);
          confirmed = true;
        } else {
          const decision = await askSelect("Proceed?", APPROVAL_OPTIONS);
          confirmed = decision !== "n";
          if (decision === "a" && result.riskLevel) rememberedRiskLevels.add(result.riskLevel);
        }
        if (confirmed) {
          await handleTurn(message, true);
        } else {
          lastTrace = void 0;
          lastNoTraceReason = "No harness trace — the last turn was blocked on an approval gate and declined before the harness ran.";
          await assistant.recordDeclinedRequest("cli", message, result.reason ?? "This request needed approval.");
          console.log("Cancelled.\n");
        }
        return;
      }
      if (result.status === "needs_clarification") {
        await handleClarification(result);
        return;
      }
      if (result.status === "needs_plan_approval") {
        if (!result.planApprovalId) {
          console.log(`
[needs plan approval] ${result.reason ?? "A plan is awaiting approval, but its approval id is missing."}
`);
          return;
        }
        const id = result.planApprovalId;
        const snapshot = result.planApproval;
        if (result.reason) console.log(`
${result.reason}`);
        if (snapshot) printPlanApproval(snapshot);
        pendingPlanApproval = { id, message, snapshot };
        lastTrace = void 0;
        lastNoTraceReason = "No harness trace — the last turn staged a plan for approval (pending /plan approve|decline|edit).";
        if (!snapshot) {
          console.log("Decide with /plan approve or /plan decline.\n");
          return;
        }
        const choice = await askSelect("Approve this plan?", PLAN_APPROVAL_OPTIONS);
        if (choice === "d") {
          console.log("Left pending — /plan to review, /plan approve|edit|decline to decide.\n");
          return;
        }
        pendingPlanApproval = void 0;
        let decision;
        let edits;
        if (choice === "t") {
          decision = "approve_trusted";
        } else if (choice === "e") {
          edits = await promptPlanEdits(snapshot);
          decision = "approve_with_edits";
        } else if (choice === "y") {
          decision = "approve";
        } else {
          decision = "decline";
        }
        lastNoTraceReason = `No harness trace — the last turn staged a plan that was ${decision === "decline" ? "declined" : "approved"} before the harness ran.`;
        await handleTurn(message, false, void 0, void 0, void 0, id, decision, edits);
        return;
      }
      if (result.status === "escalated") {
        lastTrace = void 0;
        lastNoTraceReason = `No harness trace — the last turn escalated (${result.reason}) before completing.`;
        console.log(`
[escalated] ${result.reason}
`);
        return;
      }
      if (!pendingActionId) {
        lastTrace = result.harnessSkipped ? void 0 : result.trace;
        lastNoTraceReason = result.harnessSkipped ? "No harness trace — the last turn was a simple, self-contained question answered directly without activating the harness (fast path)." : void 0;
      }
      lastSources = result.sources;
      if (!pendingActionId && (!result.harnessSkipped || result.planStatus)) lastPlanStatus = result.planStatus;
      lastTurnUsage = result.usage ? withCostEstimate(result.usage) : void 0;
      const riskSuffix = result.riskLevel && result.riskLevel !== "LOW" ? ` [risk: ${result.riskLevel}]` : "";
      const sourcesHint = result.sources && result.sources.length > 0 ? ` (${result.sources.length} source${result.sources.length > 1 ? "s" : ""} — /sources)` : "";
      const planHint = result.planStatus ? ` (plan: ${result.planStatus.completionPct.toFixed(0)}% — /plan)` : "";
      const contradictionNotice = result.contradictionNotice ? `

${result.contradictionNotice}` : "";
      const reviewNotice = result.reviewNotice ? `

${result.reviewNotice}` : "";
      lastNextSteps = result.nextSteps && result.nextSteps.length > 0 ? result.nextSteps : void 0;
      const nextStepsBlock = lastNextSteps ? `

${formatNextSteps(lastNextSteps)}` : "";
      if (streamedAnyTokens) {
        const pausedNoteText = result.pausedNote ? `

${result.pausedNote}` : "";
        process.stdout.write(`${pausedNoteText}${riskSuffix}${sourcesHint}${planHint}${contradictionNotice}${reviewNotice}${nextStepsBlock}

`);
      } else {
        console.log(`
Aielia>${riskSuffix} ${result.reply}${sourcesHint}${planHint}${contradictionNotice}${reviewNotice}${nextStepsBlock}
`);
      }
    } catch (err) {
      clearProgress();
      const { message: errorMessage, retryable } = classifyError(err, config.llmBackend);
      console.log(`
[error] ${errorMessage}${retryable ? " Type the message again to retry." : ""}
`);
    }
  }
  function askYesNo(question) {
    if (options.askYesNo) return options.askYesNo(question);
    if (nonInteractiveApprovalMode === "decline") {
      console.log(`
[non-interactive mode: auto-declining — ASSISTANT_NON_INTERACTIVE_APPROVAL=decline]`);
      return Promise.resolve(false);
    }
    return new Promise((resolve2) => {
      try {
        rl.question(question, (answer) => resolve2(answer.trim().toLowerCase().startsWith("y")));
      } catch {
        console.log(`
[could not read a response — treating as declined]`);
        resolve2(false);
      }
    });
  }
  function askLine(question) {
    if (options.askLine) return options.askLine(question);
    return new Promise((resolve2) => {
      try {
        rl.question(question, (answer) => resolve2(answer.trim()));
      } catch {
        console.log(`
[could not read a response — treating as blank]`);
        resolve2("");
      }
    });
  }
  function askSelect(question, selectOptions) {
    if (options.askSelect) return options.askSelect(question, selectOptions);
    const fallbackKey = selectOptions[selectOptions.length - 1].key;
    if (nonInteractiveApprovalMode === "decline") {
      console.log(`
[non-interactive mode: auto-declining — ASSISTANT_NON_INTERACTIVE_APPROVAL=decline]`);
      return Promise.resolve(fallbackKey);
    }
    const optionLines = selectOptions.map((option, i) => `  ${i + 1}) [${option.key}] ${option.label}`).join("\n");
    return new Promise((resolve2) => {
      try {
        rl.question(`${question}
${optionLines}
> `, (answer) => {
          var _a;
          const trimmed = answer.trim().toLowerCase();
          const byKey = selectOptions.find((option) => option.key.toLowerCase() === trimmed);
          const byIndex = /^\d+$/.test(trimmed) ? selectOptions[Number(trimmed) - 1] : void 0;
          resolve2(((_a = byKey ?? byIndex) == null ? void 0 : _a.key) ?? fallbackKey);
        });
      } catch {
        console.log(`
[could not read a response — treating as declined]`);
        resolve2(fallbackKey);
      }
    });
  }
  async function reloadAssistant() {
    const nextPersisted = await configStore.load();
    ({ config, overriddenKeys } = resolveConfig(nextPersisted, envOverrides));
    layerPins = applyLayerSettings(sanitizeLayerChoices(config.layers), process.env).pinned;
    assistant = options.assistant ?? await buildAssistant(config, { dataDir, backend, remindersFile });
  }
  async function handleConfigCommand(args) {
    if (args.length === 0) {
      console.log(`
${formatConfigListing(config, overriddenKeys)}
`);
      return;
    }
    if (args[0] === "set") {
      const key = args[1];
      const raw = args.slice(2).join(" ");
      if (!key || !isConfigKey(key)) {
        console.log(`
✗ Unknown config key "${key ?? ""}". Known keys: ${CONFIG_KEYS.join(", ")}
`);
        return;
      }
      if (!raw) {
        console.log(`
Usage: /config set ${key} <value>
`);
        return;
      }
      if (overriddenKeys.has(key)) {
        console.log(`
✗ "${key}" is pinned by ${ENV_VAR_FOR_CONFIG_KEY[key]} — unset that env var to change it here.
`);
        return;
      }
      let value;
      try {
        value = parseConfigValue(key, raw);
      } catch (err) {
        if (!(err instanceof ConfigValueParseError)) throw err;
        console.log(`
✗ ${err.message}
`);
        return;
      }
      const patch = { [key]: value };
      try {
        validateConfig(patch, config);
      } catch (err) {
        if (!(err instanceof ConfigValidationError)) throw err;
        console.log(`
✗ ${err.message}
`);
        return;
      }
      await configStore.save(patch);
      await reloadAssistant();
      console.log(`
✓ ${key} updated (took effect immediately, no restart needed)
`);
      return;
    }
    if (args[0] === "reset") {
      const key = args[1];
      if (key && !isConfigKey(key)) {
        console.log(`
✗ Unknown config key "${key}". Known keys: ${CONFIG_KEYS.join(", ")}
`);
        return;
      }
      const target = key ? `"${key}"` : "ALL settings";
      const confirmed = await askYesNo(`
Reset ${target} to default? This takes effect immediately. (y/N) `);
      if (!confirmed) {
        console.log("\nCancelled — nothing was reset.\n");
        return;
      }
      const clearPatch = key ? { [key]: void 0 } : Object.fromEntries(CONFIG_KEYS.map((k) => [k, void 0]));
      await configStore.save(clearPatch);
      await reloadAssistant();
      console.log(`
✓ Reset ${key ?? "all settings"} to default
`);
      return;
    }
    console.log("\nUsage: /config | /config set <key> <value> | /config reset [key]\n");
  }
  async function handleLayers(args) {
    const [sub, id] = args;
    if (sub === "settings" || sub === "list") {
      console.log(`
${formatLayerListing(sanitizeLayerChoices(config.layers), layerPins, process.env)}
`);
      return;
    }
    try {
      if (sub === "on" || sub === "off") {
        if (!id) {
          console.log(`
Usage: /layers ${sub} <id>
`);
          return;
        }
        const layers = withLayerChoice(sanitizeLayerChoices(config.layers), id, sub === "on");
        await configStore.save({ layers });
      } else if (sub === "reset") {
        const layers = id ? withLayerChoice(sanitizeLayerChoices(config.layers), id, void 0) : {};
        await configStore.save({ layers });
      } else {
        console.log("\nUsage: /layers settings | /layers on <id> | /layers off <id> | /layers reset [id]\n");
        return;
      }
    } catch (err) {
      if (!(err instanceof LayerSettingError)) throw err;
      console.log(`
✗ ${err.message}
`);
      return;
    }
    await reloadAssistant();
    const pinned = id !== void 0 && layerPins.has(id);
    console.log(pinned ? `
✗ Saved, but "${id}" is pinned by its AUDIT_* env flag, so the saved choice has no effect until that is unset.
` : `
✓ Layers updated (took effect immediately, no restart needed)
`);
  }
  async function handleModel(args) {
    if (args.length === 0) {
      console.log(`
${config.model ?? "(using each backend's default)"}
`);
      return;
    }
    await handleConfigCommand(["set", "model", args.join(" ")]);
  }
  async function handleProject(args) {
    if (args.length === 0) {
      console.log(`
${assistant.getActiveProject() || "(none)"}
`);
      return;
    }
    if (args[0] === "clear") {
      await handleConfigCommand(["reset", "activeProject"]);
      return;
    }
    await handleConfigCommand(["set", "activeProject", args.join(" ")]);
  }
  let turnInProgress = false;
  let lastNextSteps;
  const steeringChannel = new LiveSteeringChannel();
  const commands = {
    "/why": () => printWhy(),
    // Bare /layers is the last-turn fired/skipped view; its subcommands (settings/on/off/reset) edit the on/off choices.
    "/layers": (args) => args.length === 0 ? printLayers() : handleLayers(args),
    "/sources": () => printSources(),
    "/plan": (args) => handlePlan(args),
    "/help": () => printHelp(),
    "/clear": () => handleClear(),
    "/new": () => handleClear(),
    "/status": () => printStatus(),
    "/export": (args) => handleExport(args),
    "/undo": () => handleUndo(),
    "/undo-action": (args) => handleUndoAction(args),
    "/memory": (args) => handleMemory(args),
    "/search": (args) => handleSearch(args),
    "/goals": () => handleGoals(),
    "/model": (args) => handleModel(args),
    "/project": (args) => handleProject(args),
    "/cost": () => printCost(),
    "/doctor": () => handleDoctor(),
    "/config": (args) => handleConfigCommand(args),
    "/checkpoint": (args) => handleCheckpoint(args)
  };
  async function dispatchOne(message) {
    if (quitting) return;
    if (isQuitCommand(message)) {
      quitting = true;
      try {
        await assistant.endSession("cli");
      } catch {
      }
      console.log("Exiting.");
      rl.close();
      return;
    }
    const pick = /^[1-3]$/.test(message) && lastNextSteps ? lastNextSteps[Number(message) - 1] : void 0;
    lastNextSteps = void 0;
    if (pick) {
      console.log(`  → ${pick.description}`);
      message = pick.description;
    }
    const [token, ...args] = message.split(/\s+/);
    const handler = commands[token];
    if (handler) {
      await handler(args);
      return;
    }
    turnInProgress = true;
    try {
      await handleTurn(message);
    } finally {
      turnInProgress = false;
      if (isGoalGraphEnabled(config.goalGraphMode)) {
        for (const event of steeringChannel.poll()) {
          void enqueue(event.message);
        }
      }
    }
  }
  let quitting = false;
  let dispatchQueue = Promise.resolve();
  function enqueue(message) {
    const result = dispatchQueue.then(() => dispatchOne(message)).catch((err) => {
      console.error("[unexpected error]", err);
    });
    dispatchQueue = result;
    return result;
  }
  function isKnownCommand(message) {
    const [token] = message.split(/\s+/);
    return token in commands || isQuitCommand(message);
  }
  function routeMessage(message) {
    if (isGoalGraphEnabled(config.goalGraphMode) && turnInProgress && !isKnownCommand(message)) {
      steeringChannel.enqueue(message);
      console.log("\n[queued — the current turn is still running; this will be taken into account once it finishes]\n");
      return Promise.resolve();
    }
    return enqueue(message);
  }
  rl.on("line", (line) => {
    const message = line.trim();
    if (!message) {
      rl.prompt();
      return;
    }
    void routeMessage(message).finally(() => rl.prompt());
  });
  rl.resume();
  return {
    dispatchLine: async (line) => {
      const message = line.trim();
      if (!message) return;
      await routeMessage(message);
    },
    close: () => rl.close(),
    getPlanGraphNodes: async (live) => isPlanGraphEnabled(config.planGraphMode) ? loadPlanGraphNodes(live) : void 0,
    getStatusIndicators: async () => {
      const indicators = [];
      indicators.push(`Workspace: ${config.workspaceRoot ?? process.cwd()}`);
      if (config.dangerouslySkipPermissions) indicators.push("⚠ Permissions: auto-approved (dangerouslySkipPermissions)");
      if (lastPlanStatus !== void 0) indicators.push("Plan mode: active");
      indicators.push(`Model: ${config.model ?? backendDisplayModel[config.llmBackend]}`);
      const spendState = await assistant.getSpendState("cli");
      indicators.push(
        `↑${spendState.cumulativeInputTokens.toLocaleString()} ↓${spendState.cumulativeOutputTokens.toLocaleString()} tokens (~$${spendState.cumulativeCostUsd.toFixed(4)})`
      );
      const spendCapLine = formatSpendCapStatus(spendState, { sessionCostLimitUsd: config.sessionCostLimitUsd, sessionCallLimit: config.sessionCallLimit });
      if (spendCapLine) indicators.push(spendCapLine);
      return indicators;
    }
  };
}
async function main(argv = process.argv.slice(2)) {
  const parsed = parseCliArgs(argv);
  if (parsed.command === "version") {
    console.log(CLI_VERSION);
    return;
  }
  if (parsed.command === "help") {
    console.log(cliHelpText(CLI_VERSION));
    return;
  }
  if (parsed.command === "update") {
    process.exitCode = await runUpdateCommand({ dryRun: parsed.dryRun });
    return;
  }
  const persisted = await defaultConfigStore.load();
  const { config } = resolveConfig(persisted, defaultEnvOverrides);
  const isSea = isRunningAsSea();
  if (isSea) cleanupStaleUpdateFiles();
  if (shouldRunPassiveUpdateCheck({ updateCheck: config.updateCheck, env: process.env, stdinIsTty: Boolean(process.stdin.isTTY) })) {
    void checkForUpdate().then((result) => {
      if (result == null ? void 0 : result.updateAvailable) console.log(updateAvailableNotice(result.latestVersion, CLI_VERSION, isSea));
    });
  }
  if (shouldLaunchTuiApp(config.tuiMode ?? "disabled", Boolean(process.stdout.isTTY), Boolean(process.stdin.isTTY))) {
    const { runTuiApp } = await import("./tui-app-C15sFwGS.js");
    await runTuiApp();
    return;
  }
  await runCli();
}
function entryArgMatchesModule(entryArg, moduleHref, resolveReal = realpathSync) {
  if (entryArg === void 0) return false;
  try {
    return moduleHref === pathToFileURL(resolveReal(entryArg)).href;
  } catch {
    return false;
  }
}
function isEntryModule() {
  return entryArgMatchesModule(process.argv[1], import.meta.url);
}
if (isEntryModule()) void main();
void main();
export {
  ICONS as I,
  PLAN_LINE_PREFIX as P,
  runCli as a,
  renderPlan as r,
  toLines as t
};
//# sourceMappingURL=bin-ntOYB5dE.js.map
