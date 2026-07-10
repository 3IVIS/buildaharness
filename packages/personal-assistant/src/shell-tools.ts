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
  options?: { timeoutMs?: number; maxOutputBytes?: number },
) => Promise<ShellExecutionResult>

export const RUN_SHELL_COMMAND_TOOL: ToolDefinition = {
  name: 'run_shell_command',
  description:
    'Propose running a shell command inside the sandboxed workspace directory. This never runs the command ' +
    'immediately — it always stages the proposal for the user to explicitly approve or decline before anything ' +
    'executes, regardless of what the command looks like (there is no "safe" subset that skips approval). ' +
    '`cwd` outside the workspace is rejected immediately, before anything is staged. An identical repeat of a ' +
    'command already resolved earlier in this conversation (same command, same cwd) returns that cached result ' +
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
