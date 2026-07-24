import { spawn } from 'node:child_process'
import type { ShellExecutionResult } from './file-tools.js'
import type { ShellCommandExecutor } from './shell-tools.js'
import { getNetworkContainmentProxy } from './network-containment.js'

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

/**
 * Forces the child's HTTP(S)_PROXY env vars at a loopback-only containment proxy scoped to
 * `networkAllowlist` (see network-containment.ts) — Decision 6's network-reachability half,
 * alongside allowlistedEnv()'s existing secret-stripping half. An empty/undefined allowlist still
 * starts the proxy, just with nothing in it, so every attempt is refused with a 403 rather than
 * skipping containment entirely — deny-all is the safe default until the user opts a host in.
 *
 * Deliberately does NOT set NO_PROXY/no_proxy for 127.0.0.1/localhost: most HTTP clients (curl
 * included) skip the configured proxy entirely for any host listed in NO_PROXY, which would let a
 * command reach an arbitrary loopback service (a local metadata endpoint, an unauthenticated
 * internal API, a Docker socket proxy) without ever going through the allowlist check — a
 * loopback target is not inherently safe and must be subject to the same allowlist as anything
 * else. The one loopback address that does need to stay reachable unconditionally is the
 * containment proxy's own listener, which this env never routes through itself (a client connects
 * to it directly via the proxy env vars, not through the proxy), so no exemption is needed there.
 */
async function networkContainmentEnv(networkAllowlist: readonly string[]): Promise<NodeJS.ProcessEnv> {
  const proxy = await getNetworkContainmentProxy(networkAllowlist)
  const proxyUrl = `http://127.0.0.1:${proxy.port}`
  return {
    HTTP_PROXY: proxyUrl,
    http_proxy: proxyUrl,
    HTTPS_PROXY: proxyUrl,
    https_proxy: proxyUrl,
  }
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
 * secret like ASSISTANT_PROXY_TOKEN/ANTHROPIC_API_KEY can't leak into the command's environment,
 * plus network-containment.ts's loopback-only proxy forced via HTTP(S)_PROXY (Decision 6 — see
 * networkContainmentEnv's doc comment). A hard timeout SIGKILLs the whole process group (not just
 * the immediate child — `detached: true` + a negative-pid kill reaches anything the shell itself
 * spawned) rather than leaving it running. A non-zero exit code is not a thrown error — it's
 * reported normally, same as a real shell; only a spawn failure (e.g. the shell itself couldn't
 * start) throws.
 */
export const runApprovedShellCommand: ShellCommandExecutor = async (
  command: string,
  cwd: string,
  options: { timeoutMs?: number; maxOutputBytes?: number; networkAllowlist?: string[] } = {},
): Promise<ShellExecutionResult> => {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const maxOutputBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  const containmentEnv = await networkContainmentEnv(options.networkAllowlist ?? [])

  return new Promise((resolvePromise, reject) => {
    const proc = spawn(command, {
      shell: true,
      cwd,
      env: { ...allowlistedEnv(), ...containmentEnv },
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
