import { invoke } from '@tauri-apps/api/core'
import type { ShellCommandExecutor } from '@buildaharness/personal-assistant'

interface ShellCommandOutcome {
  output: string
  exit_code: number | null
  timed_out: boolean
}

/**
 * ShellCommandExecutor backed by the desktop shell's `run_shell_command` Tauri command
 * (see src-tauri/src/lib.rs) instead of node:child_process, which can't run inside a webview.
 * Wired into PersonalAssistant's `shellTools.executeCommand` (App.tsx) — the same generic
 * resolvePendingAction path the CLI's shell-executor.ts backs, just over an invoke() instead
 * of a direct spawn. `cwd` here is always the staged, already-validated-in-workspace path
 * from the pending-action record, never fresh user input.
 */
export const tauriExecuteShellCommand: ShellCommandExecutor = async (command, cwd, options = {}) => {
  const outcome = await invoke<ShellCommandOutcome>('run_shell_command', {
    command,
    cwd,
    timeoutMs: options.timeoutMs ?? null,
  })
  return { output: outcome.output, exitCode: outcome.exit_code, timedOut: outcome.timed_out }
}
