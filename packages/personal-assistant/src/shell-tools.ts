import type { FsBackend, ToolDefinition } from '@buildaharness/runtime'
import {
  resolveInWorkspace,
  assertRealPathInWorkspace,
  stagePendingAction,
  findCachedShellResult,
  type ShellExecutionResult,
} from './file-tools.js'

/**
 * Executes a previously staged, already-sandboxed command for real — see shell-executor.ts's
 * runApprovedShellCommand for the Node implementation. Typed here (not in shell-executor.ts)
 * so ShellToolsContext can reference it without this module — which assistant.ts/index.ts
 * import unconditionally, including into the browser build — ever importing node:child_process.
 */
export type ShellCommandExecutor = (
  command: string,
  cwd: string,
  options?: { timeoutMs?: number; maxOutputBytes?: number; networkAllowlist?: string[] },
) => Promise<ShellExecutionResult>

/**
 * Heuristic-only: flags a command whose text contains a literal `..` parent-directory path
 * segment (e.g. `cd ..`, `mkdir ../foo`, `cat ../../etc/passwd`). Unlike write_file, there is no
 * real filesystem containment for run_shell_command once approved — shell-executor.ts's
 * runApprovedShellCommand validates only that the *starting* `cwd` resolves inside the workspace
 * (assertRealPathInWorkspace below); the command text itself then runs with the process's real
 * OS-level filesystem access, so `cd ..` or a `../`-relative path genuinely escapes the workspace
 * root on disk (confirmed live — see the conv06 batch finding this heuristic exists to surface).
 * This exists purely to append an honest heads-up to the approval prompt so a human approver
 * isn't misled by write_file's "sandboxed workspace" framing into assuming the same containment
 * applies here. It is NOT a guard: it doesn't block anything, and it cannot catch every escape
 * vector (absolute paths, symlinks, `cd $(pwd)/..`, indirection through env vars, etc.) — treat a
 * `false` result as "this particular heuristic didn't fire," not "this command is contained."
 */
export function commandMayLeaveWorkspace(command: string): boolean {
  return /(?:^|[\s"'`(;&|])\.\.(?:[\/\\]|[\s;&|]|$)/.test(command)
}

export const RUN_SHELL_COMMAND_TOOL: ToolDefinition = {
  name: 'run_shell_command',
  description:
    'Propose running a shell command with its working directory validated to start inside the workspace. This ' +
    'never runs the command immediately — it always stages the proposal for the user to explicitly approve or ' +
    'decline before anything executes, regardless of what the command looks like (there is no "safe" subset that ' +
    'skips approval). `cwd` outside the workspace is rejected immediately, before anything is staged — but unlike ' +
    'write_file/read_file, the command itself is NOT filesystem-sandboxed once approved: a `cd ..`, `../`-relative ' +
    'path, or absolute path in the command text can read or write outside the workspace with the real OS-level ' +
    'permissions of the process. Approval is the only gate against that, not a containment boundary. An identical ' +
    'repeat of a command already resolved earlier in this conversation (same command, same cwd) returns that cached result ' +
    'immediately instead of staging a new approval — you do not need to avoid calling this for a genuine repeat; ' +
    "it's handled automatically.",
  input_schema: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'The shell command to run.' },
      cwd: {
        type: 'string',
        description: 'Working directory for the command, relative to the workspace root. Defaults to the workspace root.',
      },
    },
    required: ['command'],
  },
}

export const SHELL_TOOLS: ToolDefinition[] = [RUN_SHELL_COMMAND_TOOL]

/** Everything executeShellTool needs to validate + stage a proposal — no execution capability required. */
export interface ShellStagingContext {
  backend: FsBackend
  workspaceRoot: string
}

/**
 * Everything PersonalAssistant needs to both stage and, once approved, actually apply a shell
 * action. `executeCommand` is required (not just an optional extra) because assistant.ts itself
 * never imports node:child_process — it's bundled into the browser build (via index.ts) too, so
 * the real Node implementation (shell-executor.ts's runApprovedShellCommand) is only ever wired
 * in by a Node-only caller (cli.ts), exactly like node-fs-backend.ts already is.
 */
export interface ShellToolsContext extends ShellStagingContext {
  /** Hard timeout for an approved command, in ms. Passed through to executeCommand at apply time. Default 30000. */
  timeoutMs?: number
  /**
   * Hostnames an approved command's HTTP(S)_PROXY traffic may reach (exact match or subdomain) —
   * see network-containment.ts and shell-executor.ts's networkContainmentEnv. Passed through to
   * executeCommand at apply time, same as timeoutMs. Undefined/empty denies all network access,
   * the safe default (Decision 6, plans/lexical_functions_hardening_plan.html Phase 4).
   */
  networkAllowlist?: string[]
  executeCommand: ShellCommandExecutor
}

export type ShellToolResult =
  | { kind: 'staged_shell'; id: string; command: string; cwd: string }
  | { kind: 'cached_shell'; command: string; cwd: string; execution: ShellExecutionResult }

function requireStringArg(input: Record<string, unknown>, key: string): string {
  const value = input[key]
  if (typeof value !== 'string') throw new Error(`"${key}" argument must be a string`)
  return value
}

/**
 * Executes run_shell_command by name. Never spawns anything itself — only stages, exactly like
 * write_file does for file-tools — UNLESS an identical (command, cwd) pair was already resolved
 * earlier this session (see file-tools.ts's shell-result-cache doc comment for why this exists),
 * in which case it returns that cached result directly instead of staging a new approval.
 *
 * The cwd validation above and the stagePendingAction call below both run unconditionally on this
 * call's own concrete (command, cwd) arguments, regardless of what risk-classifier.ts concluded
 * about the user's message text — see stagePendingAction's doc comment in file-tools.ts for the
 * general "gate on the concrete tool call, not the free text" principle this follows.
 */
export async function executeShellTool(
  ctx: ShellStagingContext,
  toolName: string,
  input: Record<string, unknown>,
): Promise<ShellToolResult> {
  if (toolName !== 'run_shell_command') throw new Error(`Unknown shell tool: ${toolName}`)

  const command = requireStringArg(input, 'command')
  const requestedCwd = typeof input.cwd === 'string' ? input.cwd : '.'

  // Validate now — a proposal for an out-of-scope cwd fails immediately rather than getting staged.
  const resolvedCwd = resolveInWorkspace(ctx.workspaceRoot, requestedCwd)
  await assertRealPathInWorkspace(ctx.backend, ctx.workspaceRoot, resolvedCwd)

  const cached = await findCachedShellResult(ctx.backend, ctx.workspaceRoot, command, resolvedCwd)
  if (cached) {
    return { kind: 'cached_shell', command, cwd: resolvedCwd, execution: cached.execution }
  }

  const { id } = await stagePendingAction(ctx.backend, ctx.workspaceRoot, { kind: 'shell', command, cwd: resolvedCwd })
  return { kind: 'staged_shell', id, command, cwd: resolvedCwd }
}
