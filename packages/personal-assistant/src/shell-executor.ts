import { spawn } from 'node:child_process'
import type { ShellExecutionResult } from './file-tools.js'
import type { ShellCommandExecutor } from './shell-tools.js'

/**
 * The real child_process.spawn-based implementation of ShellCommandExecutor — deliberately
 * not exported from this package's index (mirrors node-fs-backend.ts): assistant.ts is bundled
 * into the browser build too, so only a Node-only caller (cli.ts) may import this module and
 * wire it in as PersonalAssistantOptions.shellTools.executeCommand.
 */

const DEFAULT_TIMEOUT_MS = 30_000
const DEFAULT_MAX_OUTPUT_BYTES = 20_000
/** Never the parent process's full env (which would carry ASSISTANT_PROXY_TOKEN/ANTHROPIC_API_KEY/etc. into the command) — only these three. */
const ALLOWED_ENV_VARS = ['PATH', 'HOME', 'LANG'] as const

function allowlistedEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {}
  for (const key of ALLOWED_ENV_VARS) {
    const value = process.env[key]
    if (value !== undefined) env[key] = value
  }
  return env
}

function truncateOutput(text: string, maxBytes: number): string {
  const encoded = new TextEncoder().encode(text)
  if (encoded.length <= maxBytes) return text
  const truncated = new TextDecoder('utf-8', { fatal: false }).decode(encoded.slice(0, maxBytes))
  return `${truncated}\n… (truncated)`
}

/**
 * Actually runs a previously staged, already-sandboxed command — the real child_process.spawn call,
 * invoked only at approval time via file-tools.ts's applyPendingAction(..., { executeShell }). `cwd`
 * is pinned to the staged (already-validated) path; `env` is reduced to an explicit allowlist so a
 * secret like ASSISTANT_PROXY_TOKEN/ANTHROPIC_API_KEY can't leak into the command's environment. A
 * hard timeout SIGKILLs the whole process group (not just the immediate child — `detached: true` +
 * a negative-pid kill reaches anything the shell itself spawned) rather than leaving it running. A
 * non-zero exit code is not a thrown error — it's reported normally, same as a real shell; only a
 * spawn failure (e.g. the shell itself couldn't start) throws.
 */
export const runApprovedShellCommand: ShellCommandExecutor = (
  command: string,
  cwd: string,
  options: { timeoutMs?: number; maxOutputBytes?: number } = {},
): Promise<ShellExecutionResult> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES

  return new Promise((resolvePromise, reject) => {
    const proc = spawn(command, {
      shell: true,
      cwd,
      env: allowlistedEnv(),
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let output = ''
    let timedOut = false
    let settled = false

    const timer = setTimeout(() => {
      timedOut = true
      try {
        if (proc.pid) process.kill(-proc.pid, 'SIGKILL')
        else proc.kill('SIGKILL')
      } catch {
        proc.kill('SIGKILL')
      }
    }, timeoutMs)

    proc.stdout?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf-8')
    })
    proc.stderr?.on('data', (chunk: Buffer) => {
      output += chunk.toString('utf-8')
    })
    proc.on('error', (err: Error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(err)
    })
    proc.on('close', (exitCode: number | null) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolvePromise({
        output: truncateOutput(output, maxOutputBytes),
        exitCode: timedOut ? null : exitCode,
        timedOut,
      })
    })
  })
}
