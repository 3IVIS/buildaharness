/**
 * Shared "extract an embedded SEA asset to disk once" helpers, used by both
 * bin-sea-bootstrap.ts (the CJS SEA entry, which pulls out the real ESM app bundle) and
 * mcp-server-asset.ts (which pulls out file-tools-mcp-server.mjs). Deliberately free of
 * `import.meta` and of any `node:sea` import so it bundles cleanly into the CJS bootstrap.
 *
 * A Node Single Executable Application can't execute an embedded asset in place, and the
 * `claude` CLI needs a real on-disk path to spawn the MCP server from — so each asset is written
 * under a per-version directory and reused on every later launch.
 */
import { mkdirSync, existsSync, writeFileSync, renameSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/** `~/.buildaharness/personal-assistant/sea-cache/<version>` — same data dir as cli.ts's `defaultDataDir`. */
export function seaCacheDir(version: string, home: string = homedir()): string {
  return join(home, '.buildaharness', 'personal-assistant', 'sea-cache', version)
}

/**
 * Writes `read()`'s bytes to `<dir>/<fileName>` unless that exact path already exists, and returns
 * the path. Version-gated by construction: `dir` embeds the CLI version, so a new release never
 * reuses a stale extraction. Written via a temp file + rename so a crash or a concurrent second
 * launch can never observe (and then import) a half-written file.
 */
export function extractAssetOnce(dir: string, fileName: string, read: () => string | ArrayBuffer): string {
  const target = join(dir, fileName)
  if (existsSync(target)) return target
  mkdirSync(dir, { recursive: true })
  const tmp = `${target}.${process.pid}.tmp`
  const data = read()
  writeFileSync(tmp, typeof data === 'string' ? data : new Uint8Array(data))
  renameSync(tmp, target)
  return target
}
