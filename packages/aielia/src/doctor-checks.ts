import { stat } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { join } from 'node:path'
import type { FsBackend } from '@buildaharness/runtime'
import type { DoctorCheck } from './cli-session.js'

/**
 * Real I/O backing /doctor's checks (network fetch, subprocess spawn, filesystem stat) —
 * split out of cli.ts, deliberately not exported from this package's index (mirrors
 * shell-executor.ts/node-fs-backend.ts): only cli.ts, a Node-only caller, imports this.
 * cli-session.ts's formatDoctorReport does the actual rendering — this file only produces
 * the DoctorCheck[] input to that.
 */

const DOCTOR_CHECK_TIMEOUT_MS = 3000

/** GET <proxyUrl>/health, expecting {status:'ok'} (see packages/proxy/src/index.ts) — hard-timed so a dead proxy can't hang /doctor. */
export async function checkProxyHealth(proxyUrl: string): Promise<DoctorCheck> {
  const label = `proxy reachable (${proxyUrl}/health)`
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), DOCTOR_CHECK_TIMEOUT_MS)
  try {
    const res = await fetch(`${proxyUrl}/health`, { signal: controller.signal })
    if (!res.ok) return { label, ok: false, detail: `HTTP ${res.status}` }
    const body = (await res.json().catch(() => undefined)) as { status?: string } | undefined
    return body?.status === 'ok' ? { label, ok: true } : { label, ok: false, detail: 'unexpected response body' }
  } catch (err) {
    const timedOut = err instanceof Error && err.name === 'AbortError'
    return { label, ok: false, detail: timedOut ? 'timed out' : err instanceof Error ? err.message : String(err) }
  } finally {
    clearTimeout(timeout)
  }
}

/** Spawns `<claudePath> --version`, same path resolution ClaudeCliLLMClient uses — hard-timed so a hung/missing binary can't hang /doctor. */
export function checkClaudeCli(claudePath: string): Promise<DoctorCheck> {
  const label = `claude binary (${claudePath})`
  return new Promise((resolvePromise) => {
    let settled = false
    const proc = spawn(claudePath, ['--version'], { stdio: ['ignore', 'ignore', 'ignore'] })
    const timeout = setTimeout(() => {
      if (settled) return
      settled = true
      proc.kill()
      resolvePromise({ label, ok: false, detail: 'timed out' })
    }, DOCTOR_CHECK_TIMEOUT_MS)
    proc.on('error', () => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolvePromise({ label, ok: false, detail: 'not found' })
    })
    proc.on('close', (code) => {
      if (settled) return
      settled = true
      clearTimeout(timeout)
      resolvePromise({ label, ok: code === 0, detail: code === 0 ? undefined : `exited with code ${code}` })
    })
  })
}

export async function checkWorkspaceRoot(workspaceRoot: string): Promise<DoctorCheck> {
  const label = `workspace root exists (${workspaceRoot})`
  try {
    const info = await stat(workspaceRoot)
    return info.isDirectory() ? { label, ok: true } : { label, ok: false, detail: 'not a directory' }
  } catch {
    return { label, ok: false, detail: 'not found' }
  }
}

export async function checkDataDirWritable(backend: FsBackend, dataDir: string): Promise<DoctorCheck> {
  const label = `data dir writable (${dataDir})`
  const probePath = join(dataDir, '.doctor-check')
  try {
    await backend.mkdir(dataDir)
    await backend.writeTextFile(probePath, 'ok')
    await backend.removeFile(probePath)
    return { label, ok: true }
  } catch (err) {
    return { label, ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}
