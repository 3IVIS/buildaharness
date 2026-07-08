use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::mpsc;
use std::time::SystemTime;
use tauri::Emitter;
use tauri_plugin_dialog::DialogExt;

/// The monorepo root, computed from this crate's compile-time location
/// (`packages/desktop/src-tauri`) rather than the process's runtime cwd — dev-mode-only
/// wiring so "what is this repo about"-style questions have something real to read via
/// read_file/list_directory (see run_claude_prompt_with_file_tools below). A production
/// desktop build would need this bundled as a proper Tauri resource instead of reaching
/// into the monorepo by relative path.
fn dev_workspace_root() -> Result<PathBuf, String> {
  Path::new(env!("CARGO_MANIFEST_DIR"))
    .join("../../..")
    .canonicalize()
    .map_err(|e| format!("Couldn't resolve the dev workspace root: {e}"))
}

/// Path to personal-assistant's plain-Node-ESM MCP server script — see that file's own doc
/// comment for why it's plain .mjs rather than compiled TS. Read directly from `src/`
/// (identical to what the package's build script copies verbatim into `dist/`) so editing
/// the MCP server doesn't require a personal-assistant rebuild to take effect here.
fn dev_file_tools_mcp_server_path() -> Result<PathBuf, String> {
  let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../personal-assistant/src/file-tools-mcp-server.mjs");
  path
    .canonicalize()
    .map_err(|e| format!("Couldn't resolve the file-tools MCP server path: {e}"))
}

/// Exposes dev_workspace_root() to the frontend so PersonalAssistant's own `fileTools`
/// option (used for resuming/applying an approved write — see file-tools.ts's
/// applyPendingAction) points at the exact same directory run_claude_prompt_with_file_tools
/// scopes read_file/list_directory/write_file to.
#[tauri::command]
fn get_dev_workspace_root() -> Result<String, String> {
  Ok(dev_workspace_root()?.to_string_lossy().to_string())
}

/// Desktop equivalent of personal-assistant's doctor-checks.ts checkClaudeCli — backs the
/// Settings screen's Diagnostics > Health section (see chat-ui's gui-doctor-checks.ts). Same
/// `claude --version` probe and CLAUDE_PATH resolution as run_claude_prompt/
/// run_claude_prompt_with_file_tools, just checking exit status rather than running a real
/// turn. Returns `Ok(false)` (not an `Err`) for "the binary isn't there or didn't exit 0" —
/// that's an expected, common outcome for a health check, not an internal failure; only a
/// genuine inability to spawn a process at all is treated as an error here.
///
/// Known simplification vs. the CLI's checkClaudeCli: no hard timeout on a hung binary — `Command::status()`
/// blocks synchronously with no easy cancellation short of a polling wait_timeout loop, and `claude --version`
/// returning near-instantly is the overwhelmingly common case. Accepted tradeoff for a Settings-screen
/// diagnostic check, not treated as equivalent to the CLI's 3s-timeout guarantee.
#[tauri::command]
async fn check_claude_available() -> Result<bool, String> {
  tauri::async_runtime::spawn_blocking(|| {
    let claude_path = std::env::var("CLAUDE_PATH").unwrap_or_else(|_| "claude".to_string());
    match Command::new(&claude_path).arg("--version").stdout(Stdio::null()).stderr(Stdio::null()).status() {
      Ok(status) => Ok(status.success()),
      Err(_) => Ok(false),
    }
  })
  .await
  .map_err(|e| format!("Internal error checking claude availability: {e}"))?
}

/// Opens a native folder-picker dialog and returns the chosen path, or `None` if the user
/// cancelled. Backs the settings screen's Workspace section (chat-ui's SettingsScreen) — the
/// path returned here is what persists via tauri-config-store.ts's `workspaceRoot`, taking
/// over from get_dev_workspace_root() as the source of truth once a user has picked one.
/// The dialog plugin's callback fires on its own thread, not this command's async context, so
/// a channel bridges it back to the `await`-able return value the frontend expects.
#[tauri::command]
async fn pick_workspace_directory(app_handle: tauri::AppHandle) -> Result<Option<String>, String> {
  let (tx, rx) = mpsc::channel();
  app_handle.dialog().file().pick_folder(move |folder| {
    let _ = tx.send(folder);
  });
  let folder = tauri::async_runtime::spawn_blocking(move || rx.recv())
    .await
    .map_err(|e| format!("Internal error waiting on folder picker: {e}"))?
    .map_err(|e| format!("Folder picker channel closed unexpectedly: {e}"))?;
  Ok(folder.map(|p| p.to_string()))
}

#[derive(serde::Serialize)]
struct ToolCallOutcome {
  stdout: String,
  /// Raw JSON text of a `.pending-actions/<id>.json` record staged mid-call, if any — the
  /// frontend parses and reduces it via personal-assistant's shared `stagedActionInput`
  /// (see claude-cli-prompt.ts), the same way claude-cli-llm-client.ts's
  /// findPendingActionStagedSince result feeds into it for the CLI front end.
  staged_action: Option<String>,
}

/// Scans `<workspace_root>/.pending-actions/` for a record staged during this call — mirrors
/// claude-cli-llm-client.ts's findPendingActionStagedSince, done here in Rust instead of a
/// second Tauri fs-plugin round-trip since this directory has nothing to do with the
/// webview's own fs permissions (it's read by this Rust process directly, off the main
/// thread, the same way the `claude`/MCP-server subprocess tree wrote it).
fn find_staged_action(workspace_root: &Path, since: SystemTime) -> Option<String> {
  let dir = workspace_root.join(".pending-actions");
  let entries = std::fs::read_dir(dir).ok()?;
  for entry in entries.flatten() {
    let path = entry.path();
    if path.extension().and_then(|e| e.to_str()) != Some("json") {
      continue;
    }
    let modified = entry.metadata().ok()?.modified().ok()?;
    // Small buffer against filesystem mtime rounding being coarser than SystemTime's
    // precision — mirrors claude-cli-llm-client.ts's 1s buffer for the same reason.
    if modified + std::time::Duration::from_secs(1) < since {
      continue;
    }
    if let Ok(contents) = std::fs::read_to_string(&path) {
      return Some(contents);
    }
  }
  None
}

/// Strips an MCP-qualified tool name (`mcp__<server>__<tool>`, how Claude Code CLI surfaces
/// a tool registered via --mcp-config) down to the bare name — mirrors personal-assistant's
/// stripMcpToolPrefix (tool-step.ts) exactly; kept in sync by hand since Rust can't import
/// that TS module, the same tradeoff already accepted for file-tools-mcp-server.mjs
/// duplicating file-tools.ts's sandboxing logic.
fn strip_mcp_prefix(name: &str) -> String {
  if let Some(rest) = name.strip_prefix("mcp__") {
    if let Some(idx) = rest.find("__") {
      return rest[idx + 2..].to_string();
    }
  }
  name.to_string()
}

#[derive(serde::Serialize, Clone)]
struct ToolStepPayload {
  tool: String,
  input: serde_json::Value,
}

/// Event name the frontend listens for (see chat-ui's TauriClaudeCliLLMClient) — one per
/// tool_use block, emitted as the stream is parsed, live.
const TOOL_STEP_EVENT: &str = "claude-tool-step";

/// The desktop-app equivalent of ClaudeCliLLMClient.callChatStructured's MCP-wiring branch:
/// wires personal-assistant's file-tools MCP server into a single `claude -p` call and lets
/// Claude Code's own agentic loop call read_file/list_directory/write_file autonomously —
/// scoped to whatever `workspace_root` the frontend resolved (config.workspaceRoot if the user
/// picked one via Settings' Workspace section, otherwise get_dev_workspace_root()'s fallback —
/// see App.tsx's createTauriBackedAssistant). Fix: this command used to call dev_workspace_root()
/// itself unconditionally here, silently ignoring a user-picked workspace and always scoping the
/// MCP server (and thus every read_file/list_directory/write_file/run_shell_command call) to the
/// monorepo root regardless of Settings — the JS side's own fileTools.workspaceRoot (used for
/// applying an approved write/shell action) was already correct, so the two could point at
/// different directories. write_file/run_shell_command only ever stage (never execute inline),
/// exactly like the CLI backend; a staged action is detected via find_staged_action and surfaced
/// to the frontend as raw JSON instead of applied here — actually running an approved shell
/// command happens later, via run_shell_command below, once the user approves. Uses
/// --output-format stream-json (not the single-object 'json') and reads stdout line-by-line
/// as the process runs, emitting a TOOL_STEP_EVENT for every tool_use block as soon as it
/// appears — otherwise these calls are invisible until the whole subprocess call finishes,
/// since Claude Code's own agentic loop resolves them internally. Mirrors
/// claude-cli-llm-client.ts's invokeClaudeStreaming. `enable_shell_tools` mirrors the CLI's
/// `config.enableShell` gate (see cli.ts) — run_shell_command is only registered on the MCP
/// server when the user has turned Shell on in Settings, same opt-in as everywhere else.
#[tauri::command]
async fn run_claude_prompt_with_file_tools(
  app_handle: tauri::AppHandle,
  system_prompt: String,
  prompt: String,
  model: Option<String>,
  enable_shell_tools: bool,
  workspace_root: String,
) -> Result<ToolCallOutcome, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let claude_path = std::env::var("CLAUDE_PATH").unwrap_or_else(|_| "claude".to_string());
    let workspace_root = PathBuf::from(workspace_root);
    let mcp_server_path = dev_file_tools_mcp_server_path()?;

    let mut mcp_env = serde_json::json!({ "WORKSPACE_ROOT": workspace_root.to_string_lossy() });
    if enable_shell_tools {
      mcp_env["ENABLE_SHELL_TOOLS"] = serde_json::Value::String("1".to_string());
    }

    let mcp_config = serde_json::json!({
      "mcpServers": {
        "file-tools": {
          "command": "node",
          "args": [mcp_server_path.to_string_lossy()],
          "env": mcp_env
        }
      }
    })
    .to_string();

    let mut args: Vec<String> = vec![
      "--print".into(),
      "--output-format".into(),
      "stream-json".into(), // streamed so tool_use events can be reported live, not just the final answer
      "--verbose".into(),   // required by --print whenever --output-format is stream-json
      "--tools".into(),
      "".into(),
      "--no-session-persistence".into(),
      "--system-prompt".into(),
      system_prompt,
      "--mcp-config".into(),
      mcp_config,
      "--strict-mcp-config".into(),
      "--dangerously-skip-permissions".into(), // headless -p mode has no way to answer an interactive tool-permission prompt
    ];
    if let Some(m) = model {
      args.push("--model".into());
      args.push(m);
    }
    args.push(prompt);

    let call_started_at = SystemTime::now();

    // cwd still pinned to the OS temp dir, same as the tool-free path — read_file/
    // list_directory/write_file are scoped to workspace_root via WORKSPACE_ROOT above,
    // which is independent of claude's own cwd (only used for its own CLAUDE.md/.mcp.json
    // auto-loading, which this deliberately avoids — see run_claude_prompt's doc comment).
    let mut child = Command::new(&claude_path)
      .args(&args)
      .current_dir(std::env::temp_dir())
      .stdout(Stdio::piped())
      .stderr(Stdio::piped())
      .spawn()
      .map_err(|e| format!("Couldn't run \"{claude_path}\": {e}"))?;

    let stdout = child.stdout.take().expect("piped stdout");
    let mut final_result_line: Option<String> = None;

    for line in BufReader::new(stdout).lines() {
      let Ok(line) = line else { break };
      if line.trim().is_empty() {
        continue;
      }
      let Ok(event) = serde_json::from_str::<serde_json::Value>(&line) else {
        continue; // stream-json is one complete JSON object per line — an unparseable line is never expected, but must never crash the stream
      };

      match event.get("type").and_then(|v| v.as_str()) {
        Some("assistant") => {
          let blocks = event
            .get("message")
            .and_then(|m| m.get("content"))
            .and_then(|c| c.as_array())
            .cloned()
            .unwrap_or_default();
          for block in blocks {
            if block.get("type").and_then(|v| v.as_str()) != Some("tool_use") {
              continue;
            }
            let name = block.get("name").and_then(|v| v.as_str()).unwrap_or_default();
            let input = block.get("input").cloned().unwrap_or_else(|| serde_json::json!({}));
            let _ = app_handle.emit(TOOL_STEP_EVENT, ToolStepPayload { tool: strip_mcp_prefix(name), input });
          }
        }
        Some("result") => final_result_line = Some(line),
        _ => {}
      }
    }

    let mut stderr_text = String::new();
    if let Some(mut stderr) = child.stderr.take() {
      use std::io::Read;
      let _ = stderr.read_to_string(&mut stderr_text);
    }
    let status = child.wait().map_err(|e| format!("Couldn't wait on \"{claude_path}\": {e}"))?;

    if !status.success() {
      let stderr_text = stderr_text.trim().to_string();
      let err = if stderr_text.is_empty() { format!("claude exited with status {status}") } else { stderr_text };
      // invoke() rejections reach the frontend as a bare string with no code/name, and the
      // catch site only shows classifyError's generic fallback copy — this is the only place
      // the real cause is visible. Goes to this process's stderr, i.e. the `tauri dev` terminal.
      eprintln!("[run_claude_prompt_with_file_tools] {err}");
      return Err(err);
    }

    if final_result_line.is_none() {
      eprintln!("[run_claude_prompt_with_file_tools] stream ended with no `result` event (stderr: {stderr_text:?})");
    }

    let staged_action = find_staged_action(&workspace_root, call_started_at);
    Ok(ToolCallOutcome { stdout: final_result_line.unwrap_or_default(), staged_action })
  })
  .await
  .map_err(|e| format!("Internal error running claude: {e}"))?
}

/// Runs a single `claude -p` turn on the host — the desktop-app equivalent of
/// personal-assistant's ClaudeCliLLMClient, which can't run inside a webview because it
/// needs node:child_process. `system_prompt`/`prompt` are built on the JS side by the
/// shared `buildClaudePrompt` helper (@buildaharness/personal-assistant) so the CLI and
/// desktop front ends stay byte-for-byte consistent in how a transcript becomes a prompt;
/// this command is deliberately a dumb pipe (spawn, capture stdout/stderr, return raw
/// stdout) rather than re-parsing --output-format json itself — that parsing lives in the
/// same shared module's `parseClaudeCliOutput`, called back on the JS side, so the
/// --output-format json → reply-text logic exists in exactly one place. No --mcp-config /
/// --dangerously-skip-permissions here (matches ClaudeCliLLMClient's own callChatSync,
/// used for a tool-free plain chat turn) — file/web/shell tools aren't wired into the
/// desktop app yet (see chat-ui's App.tsx doc comment).
#[tauri::command]
async fn run_claude_prompt(
  system_prompt: String,
  prompt: String,
  model: Option<String>,
) -> Result<String, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let claude_path = std::env::var("CLAUDE_PATH").unwrap_or_else(|_| "claude".to_string());

    // --tools "" only disables Claude Code's own built-in tools — it has no effect on MCP
    // servers, which are controlled entirely by --mcp-config/--strict-mcp-config. Without
    // an empty --mcp-config plus --strict-mcp-config, this call would silently inherit
    // whatever MCP servers happen to be configured ambiently on the host (a project
    // .mcp.json, or the user's own global Claude Code config) — see
    // claude-cli-llm-client.ts's EMPTY_MCP_CONFIG doc comment for the CLI-side version of
    // this same fix.
    let mut args: Vec<String> = vec![
      "--print".into(),
      "--output-format".into(),
      "json".into(),
      "--tools".into(),
      "".into(),
      "--no-session-persistence".into(),
      "--system-prompt".into(),
      system_prompt,
      "--mcp-config".into(),
      "{\"mcpServers\":{}}".into(),
      "--strict-mcp-config".into(),
    ];
    if let Some(m) = model {
      args.push("--model".into());
      args.push(m);
    }
    args.push(prompt);

    // Pin cwd to the OS temp dir, never this app's own launch directory — `claude` has no
    // flag to suppress project-context loading, it infers project CLAUDE.md/.mcp.json/
    // skills entirely from the process's cwd regardless of --system-prompt/--tools. See
    // claude-cli-llm-client.ts's invokeClaude for the same fix on the CLI front end.
    let output = Command::new(&claude_path)
      .args(&args)
      .current_dir(std::env::temp_dir())
      .output()
      .map_err(|e| format!("Couldn't run \"{claude_path}\": {e}"))?;

    if !output.status.success() {
      let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
      let err = if stderr.is_empty() { format!("claude exited with status {}", output.status) } else { stderr };
      // See run_claude_prompt_with_file_tools's matching eprintln! — same reasoning.
      eprintln!("[run_claude_prompt] {err}");
      return Err(err);
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
  })
  .await
  .map_err(|e| format!("Internal error running claude: {e}"))?
}

#[derive(serde::Serialize)]
struct ShellCommandOutcome {
  /// Combined stdout+stderr, truncated to SHELL_MAX_OUTPUT_BYTES — mirrors
  /// shell-executor.ts's ShellExecutionResult shape exactly, so the frontend can hand this
  /// straight to personal-assistant's applyPendingAction without reshaping it.
  output: String,
  exit_code: Option<i32>,
  timed_out: bool,
}

const SHELL_DEFAULT_TIMEOUT_MS: u64 = 30_000;
const SHELL_MAX_OUTPUT_BYTES: usize = 20_000;
/// Never the app's own full env (which could carry unrelated secrets into the command) —
/// only these, mirroring shell-executor.ts's ALLOWED_ENV_VARS. USERPROFILE is Windows' HOME.
const SHELL_ALLOWED_ENV_VARS: [&str; 4] = ["PATH", "HOME", "USERPROFILE", "LANG"];

fn truncate_output(text: String, max_bytes: usize) -> String {
  if text.len() <= max_bytes {
    return text;
  }
  let mut end = max_bytes.min(text.len());
  while end > 0 && !text.is_char_boundary(end) {
    end -= 1;
  }
  format!("{}\n… (truncated)", &text[..end])
}

/// Actually runs a previously staged, already-sandboxed command — the Rust equivalent of
/// personal-assistant's shell-executor.ts (which can't run inside a webview because it needs
/// node:child_process). Invoked only at approval time, via the frontend's ShellCommandExecutor
/// (tauri-shell-executor.ts) passed into PersonalAssistant's `shellTools.executeCommand` — the
/// same generic resolvePendingAction path the CLI uses, just backed by a Tauri command instead
/// of a direct node:child_process.spawn call. `cwd` is the staged (already-validated-in-workspace)
/// path from the pending-action record, not user input taken fresh here. No process-group kill
/// on timeout (unlike shell-executor.ts's `detached` + negative-pid kill) — accepted simplification
/// for a first cut, same tradeoff already noted on check_claude_available's doc comment; a killed
/// shell's own unwaited grandchildren can outlive the timeout.
#[tauri::command]
async fn run_shell_command(command: String, cwd: String, timeout_ms: Option<u64>) -> Result<ShellCommandOutcome, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let timeout = std::time::Duration::from_millis(timeout_ms.unwrap_or(SHELL_DEFAULT_TIMEOUT_MS));

    #[cfg(unix)]
    let mut cmd = {
      let mut c = Command::new("/bin/sh");
      c.arg("-c").arg(&command);
      c
    };
    #[cfg(windows)]
    let mut cmd = {
      let mut c = Command::new("cmd");
      c.arg("/C").arg(&command);
      c
    };

    cmd.current_dir(&cwd).env_clear();
    for key in SHELL_ALLOWED_ENV_VARS {
      if let Ok(value) = std::env::var(key) {
        cmd.env(key, value);
      }
    }
    cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());

    let mut child = cmd.spawn().map_err(|e| format!("Couldn't run the command: {e}"))?;
    let stdout = child.stdout.take();
    let stderr = child.stderr.take();
    let stdout_handle = std::thread::spawn(move || {
      use std::io::Read;
      let mut s = String::new();
      if let Some(mut o) = stdout {
        let _ = o.read_to_string(&mut s);
      }
      s
    });
    let stderr_handle = std::thread::spawn(move || {
      use std::io::Read;
      let mut s = String::new();
      if let Some(mut e) = stderr {
        let _ = e.read_to_string(&mut s);
      }
      s
    });

    let start = std::time::Instant::now();
    let mut timed_out = false;
    let exit_status = loop {
      match child.try_wait() {
        Ok(Some(status)) => break Some(status),
        Ok(None) => {
          if start.elapsed() >= timeout {
            timed_out = true;
            let _ = child.kill();
            let _ = child.wait();
            break None;
          }
          std::thread::sleep(std::time::Duration::from_millis(50));
        }
        Err(_) => break None,
      }
    };

    let stdout_text = stdout_handle.join().unwrap_or_default();
    let stderr_text = stderr_handle.join().unwrap_or_default();

    Ok(ShellCommandOutcome {
      output: truncate_output(format!("{stdout_text}{stderr_text}"), SHELL_MAX_OUTPUT_BYTES),
      exit_code: if timed_out { None } else { exit_status.and_then(|s| s.code()) },
      timed_out,
    })
  })
  .await
  .map_err(|e| format!("Internal error running shell command: {e}"))?
}

// ── Workspace-scoped file I/O (raw std::fs, not @tauri-apps/plugin-fs) ──
//
// personal-assistant's fileTools/shellTools (read_file/list_directory/write_file/
// run_shell_command, and the .pending-actions staging both share) need real read/write
// access to `workspaceRoot` — a path chosen at runtime (the dev fallback from
// get_dev_workspace_root, or a directory the user picks via Settings), never known at
// build time. @tauri-apps/plugin-fs's capability system requires a *static* scope
// declared in capabilities/default.json ($APPLOCALDATA only, for transcripts/config/
// experience — see tauri-fs-backend.ts) — there's no way to declare a scope for "whatever
// directory gets picked later" short of a wildcard covering the whole filesystem, which
// would be a real security regression (every file the OS account can read/write becomes
// reachable from the webview's JS, not just the one workspace the user chose).
//
// So these commands bypass the fs plugin entirely and do raw std::fs I/O instead, with
// their own containment check (assert_within_workspace, mirroring file-tools.ts's
// resolveInWorkspace/assertRealPathInWorkspace and file-tools-mcp-server.mjs's equivalent
// for the claude-cli backend) as the only gate — the same tradeoff run_claude_prompt/
// run_shell_command already made for their own custom commands. Bug this fixes: before
// this, fileTools/shellTools on desktop used tauri-fs-backend.ts (the $APPLOCALDATA-scoped
// one) directly against workspaceRoot paths, which always failed with a "forbidden path"
// error — invisible as long as claude-cli was the only backend (its file tools run inside
// a Rust-spawned Node subprocess via file-tools-mcp-server.mjs, never touching this JS
// backend at all), but broke the moment desktop could use the anthropic/openai/openrouter
// backends too, since those route file tools through the generic JS-side dispatch.
//
// Resolves the nearest *existing* ancestor of `path` and canonicalizes it — `path` itself
// often doesn't exist yet (write_file on a new file, mkdir on a new directory), so it can't
// be canonicalized directly; its closest real ancestor can. Mirrors file-tools.ts's
// realpathOfNearestExistingAncestor exactly, just in Rust.
fn nearest_existing_ancestor(path: &Path) -> std::io::Result<PathBuf> {
  if path.exists() {
    return path.canonicalize();
  }
  match path.parent() {
    Some(parent) if parent != path => {
      let real_parent = nearest_existing_ancestor(parent)?;
      Ok(match path.file_name() {
        Some(name) => real_parent.join(name),
        None => real_parent,
      })
    }
    _ => Ok(path.to_path_buf()),
  }
}

/// Validates `path` resolves inside `workspace_root` (following symlinks on whichever
/// prefix of it already exists) before any of the commands below touch disk. Returns the
/// original (non-canonicalized) `path` as a `PathBuf` — I/O still happens against the path
/// as given, this only gates whether it's allowed to.
fn assert_within_workspace(workspace_root: &str, path: &str) -> Result<PathBuf, String> {
  let root = Path::new(workspace_root)
    .canonicalize()
    .map_err(|e| format!("Couldn't resolve workspace root \"{workspace_root}\": {e}"))?;
  let target = Path::new(path);
  let real_target = nearest_existing_ancestor(target).map_err(|e| format!("Couldn't resolve \"{path}\": {e}"))?;
  if real_target != root && !real_target.starts_with(&root) {
    return Err(format!("Path \"{path}\" resolves outside the workspace root."));
  }
  Ok(target.to_path_buf())
}

/// Desktop equivalent of tauri-fs-backend.ts's readTextFile: resolves `undefined` (here,
/// `None`) for a missing file rather than erroring — matches FsBackend's contract exactly.
#[tauri::command]
async fn workspace_read_text_file(workspace_root: String, path: String) -> Result<Option<String>, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let target = assert_within_workspace(&workspace_root, &path)?;
    match std::fs::read_to_string(&target) {
      Ok(contents) => Ok(Some(contents)),
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
      Err(e) => Err(format!("Couldn't read \"{path}\": {e}")),
    }
  })
  .await
  .map_err(|e| format!("Internal error reading a workspace file: {e}"))?
}

#[tauri::command]
async fn workspace_write_text_file(workspace_root: String, path: String, contents: String) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || {
    let target = assert_within_workspace(&workspace_root, &path)?;
    // stagePendingAction (file-tools.ts) calls mkdir(.pending-actions) then
    // writeTextFile(.pending-actions/<id>.json) as two separate FsBackend calls, so this
    // create_dir_all is usually a no-op by the time it runs — kept anyway so this command
    // is a correct standalone FsBackend.writeTextFile implementation on its own.
    if let Some(parent) = target.parent() {
      std::fs::create_dir_all(parent).map_err(|e| format!("Couldn't create parent directory for \"{path}\": {e}"))?;
    }
    std::fs::write(&target, contents).map_err(|e| format!("Couldn't write \"{path}\": {e}"))
  })
  .await
  .map_err(|e| format!("Internal error writing a workspace file: {e}"))?
}

/// No-op if the file doesn't exist — matches FsBackend.removeFile's contract.
#[tauri::command]
async fn workspace_remove_file(workspace_root: String, path: String) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || {
    let target = assert_within_workspace(&workspace_root, &path)?;
    match std::fs::remove_file(&target) {
      Ok(()) => Ok(()),
      Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
      Err(e) => Err(format!("Couldn't remove \"{path}\": {e}")),
    }
  })
  .await
  .map_err(|e| format!("Internal error removing a workspace file: {e}"))?
}

/// Recursive; no-op if the directory already exists — matches FsBackend.mkdir's contract.
#[tauri::command]
async fn workspace_mkdir(workspace_root: String, path: String) -> Result<(), String> {
  tauri::async_runtime::spawn_blocking(move || {
    let target = assert_within_workspace(&workspace_root, &path)?;
    std::fs::create_dir_all(&target).map_err(|e| format!("Couldn't create directory \"{path}\": {e}"))
  })
  .await
  .map_err(|e| format!("Internal error creating a workspace directory: {e}"))?
}

/// File names only, non-recursive — matches FsBackend.readDir's contract and
/// tauri-fs-backend.ts's own `.filter(e => e.isFile)` behavior exactly (list_directory
/// should list files, not subdirectory names, on either backend).
#[tauri::command]
async fn workspace_read_dir(workspace_root: String, path: String) -> Result<Vec<String>, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let target = assert_within_workspace(&workspace_root, &path)?;
    let entries = std::fs::read_dir(&target).map_err(|e| format!("Couldn't list \"{path}\": {e}"))?;
    let mut names = Vec::new();
    for entry in entries {
      let entry = entry.map_err(|e| format!("Couldn't read a directory entry in \"{path}\": {e}"))?;
      let file_type = entry.file_type().map_err(|e| format!("Couldn't stat an entry in \"{path}\": {e}"))?;
      if file_type.is_file() {
        if let Some(name) = entry.file_name().to_str() {
          names.push(name.to_string());
        }
      }
    }
    Ok(names)
  })
  .await
  .map_err(|e| format!("Internal error listing a workspace directory: {e}"))?
}

/// Resolves symlinks and returns the canonical path — matches FsBackend.realpath's
/// contract (rejects if `path` doesn't exist). Wired as fileTools'/shellTools' backend's
/// `realpath`, which is what makes assertRealPathInWorkspace's symlink-escape defense (in
/// file-tools.ts, on the JS side) actually active for this backend instead of a silent
/// no-op — see that function's own doc comment.
#[tauri::command]
async fn workspace_realpath(workspace_root: String, path: String) -> Result<String, String> {
  tauri::async_runtime::spawn_blocking(move || {
    let target = assert_within_workspace(&workspace_root, &path)?;
    let real = target.canonicalize().map_err(|e| format!("Couldn't resolve real path of \"{path}\": {e}"))?;
    Ok(real.to_string_lossy().to_string())
  })
  .await
  .map_err(|e| format!("Internal error resolving a workspace path: {e}"))?
}

/// Resolves `hostname` to its IP addresses — backs fetch_url's SSRF guard (web-tools.ts's
/// assertPublicHttpUrl) on desktop, where the guard's default resolver (`node:dns/promises`)
/// doesn't exist at all — a webview has no DNS API exposed to its JS, of any kind. Without
/// this, fetch_url doesn't degrade gracefully so much as never work at all on desktop: every
/// call throws before the fetch itself even happens. `ToSocketAddrs` needs a port to resolve
/// against; `:0` is a placeholder — only the resolved IP addresses are used here, never the
/// port.
#[tauri::command]
async fn dns_lookup(hostname: String) -> Result<Vec<String>, String> {
  tauri::async_runtime::spawn_blocking(move || {
    use std::net::ToSocketAddrs;
    let addrs = format!("{hostname}:0")
      .to_socket_addrs()
      .map_err(|e| format!("Couldn't resolve \"{hostname}\": {e}"))?;
    Ok(addrs.map(|addr| addr.ip().to_string()).collect())
  })
  .await
  .map_err(|e| format!("Internal error during DNS resolution: {e}"))?
}

#[cfg(test)]
mod workspace_fs_tests {
  use super::assert_within_workspace;
  use std::fs;

  #[test]
  fn allows_a_path_inside_the_workspace() {
    let dir = std::env::temp_dir().join(format!("waw-test-{}", std::process::id()));
    fs::create_dir_all(dir.join("sub")).unwrap();
    let root = dir.to_str().unwrap();
    assert!(assert_within_workspace(root, &format!("{root}/sub/file.txt")).is_ok());
    fs::remove_dir_all(&dir).ok();
  }

  #[test]
  fn rejects_a_path_outside_the_workspace_via_traversal() {
    let dir = std::env::temp_dir().join(format!("waw-test-outside-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    let root = dir.to_str().unwrap();
    let escaped = format!("{root}/../etc/passwd");
    assert!(assert_within_workspace(root, &escaped).is_err());
    fs::remove_dir_all(&dir).ok();
  }

  #[test]
  fn rejects_a_symlink_that_escapes_the_workspace() {
    let base = std::env::temp_dir().join(format!("waw-test-symlink-{}", std::process::id()));
    let root = base.join("workspace");
    let outside = base.join("outside");
    fs::create_dir_all(&root).unwrap();
    fs::create_dir_all(&outside).unwrap();
    let link = root.join("escape");
    std::os::unix::fs::symlink(&outside, &link).unwrap();

    let root_str = root.to_str().unwrap();
    let escape_str = link.join("secret.txt").to_str().unwrap().to_string();
    assert!(assert_within_workspace(root_str, &escape_str).is_err());
    fs::remove_dir_all(&base).ok();
  }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
  tauri::Builder::default()
    .plugin(tauri_plugin_fs::init())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_http::init())
    .invoke_handler(tauri::generate_handler![
      run_claude_prompt,
      run_claude_prompt_with_file_tools,
      run_shell_command,
      get_dev_workspace_root,
      check_claude_available,
      pick_workspace_directory,
      workspace_read_text_file,
      workspace_write_text_file,
      workspace_remove_file,
      workspace_mkdir,
      workspace_read_dir,
      workspace_realpath,
      dns_lookup
    ])
    .setup(|app| {
      if cfg!(debug_assertions) {
        app.handle().plugin(
          tauri_plugin_log::Builder::default()
            .level(log::LevelFilter::Info)
            .build(),
        )?;
      }
      Ok(())
    })
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
