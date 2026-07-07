import { invoke } from '@tauri-apps/api/core'
import type { FsBackend } from '@buildaharness/runtime'
import type { DoctorCheck } from '@buildaharness/personal-assistant'

/**
 * Browser/desktop equivalents of personal-assistant's doctor-checks.ts (CLI-only, Node-only —
 * uses node:child_process/node:fs/promises, so it can't be imported here). Same checks, same
 * DoctorCheck shape (reused from the package so SettingsScreen's formatDoctorReport renders
 * both consistently), different plumbing per platform: `fetch` in a plain browser,
 * `@tauri-apps/api/core`'s `invoke` on desktop.
 */

const DOCTOR_CHECK_TIMEOUT_MS = 3000

/** Browser-only: GET <proxyUrl>/health, expecting {status:'ok'} — same contract as the CLI's checkProxyHealth. */
export async function checkProxyReachable(proxyUrl: string): Promise<DoctorCheck> {
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

/** Desktop-only: invokes the check_claude_available Tauri command (src-tauri/src/lib.rs), the GUI equivalent of the CLI's `claude --version` check. */
export async function checkClaudeAvailable(): Promise<DoctorCheck> {
  const label = 'claude binary (desktop)'
  try {
    const available = await invoke<boolean>('check_claude_available')
    return available ? { label, ok: true } : { label, ok: false, detail: 'not found' }
  } catch (err) {
    return { label, ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}

/** Desktop-only: confirms a workspace root actually resolved (a persisted pick, or the dev fallback) — parity with the CLI's checkWorkspaceRoot, without a redundant Tauri round-trip when the caller already has the resolved path. */
export function checkWorkspaceConfigured(workspaceRoot: string | undefined): DoctorCheck {
  const label = 'workspace root'
  return workspaceRoot ? { label: `${label} (${workspaceRoot})`, ok: true } : { label, ok: false, detail: 'not resolved' }
}

/**
 * Desktop-only: write+remove a throwaway probe file via the same FsBackend transcripts/config
 * already use — parity with the CLI's checkDataDirWritable. Unlike the CLI's `.doctor-check`,
 * this one avoids a leading dot: Tauri's fs scope defaults `require_literal_leading_dot` to
 * true on Unix (dotfiles aren't exposed by `$APPLOCALDATA/**` globs without it), so a dotfile
 * probe would always report a false "forbidden path" failure regardless of real writability.
 */
export async function checkDataDirWritable(backend: FsBackend, dataDir: string): Promise<DoctorCheck> {
  const label = `data dir writable (${dataDir})`
  const probePath = `${dataDir}/doctor-check.tmp`
  try {
    await backend.mkdir(dataDir)
    await backend.writeTextFile(probePath, 'ok')
    await backend.removeFile(probePath)
    return { label, ok: true }
  } catch (err) {
    return { label, ok: false, detail: err instanceof Error ? err.message : String(err) }
  }
}
