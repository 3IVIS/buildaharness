import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { CLI_VERSION } from './version.js'
import { extractAssetOnce, seaCacheDir } from './sea-cache.js'

export const MCP_SERVER_FILE_NAME = 'file-tools-mcp-server.mjs'

/**
 * The lexical pattern files file-tools-mcp-server.mjs reads at startup via
 * `join(__dirname, 'lexical/patterns/<name>')` — they have to sit beside the extracted server,
 * so they are embedded as SEA assets (under this same relative key) and extracted with it.
 */
export const MCP_SERVER_PATTERN_FILES = ['injection-patterns.json', 'fact-markers.json', 'risk-patterns.json'] as const

interface SeaModule {
  isSea(): boolean
  getRawAsset(key: string): ArrayBuffer
}

/** `node:sea` if this process is a Node single executable application, else null. Never throws. */
function loadSea(): SeaModule | null {
  try {
    // createRequire keeps this out of the bundlers' static import graph — `node:sea` is absent on
    // older Node versions, and only meaningful inside a SEA.
    const sea = createRequire(import.meta.url)('node:sea') as SeaModule
    return sea.isSea() ? sea : null
  } catch {
    return null
  }
}

/**
 * Absolute on-disk path to file-tools-mcp-server.mjs, which the claude-cli backend hands to the
 * separate `claude` binary to spawn as a `node <path>` MCP subprocess.
 *
 * - Inside a SEA binary, `import.meta.url` is not a real file location, so the embedded asset is
 *   extracted once (version-gated, see sea-cache.ts) and that path returned.
 * - Otherwise (npm install, tsx), it is the file sitting next to this module, as before.
 *
 * `seaOverride` and `home` exist for tests; production callers pass nothing.
 */
export function resolveMcpServerPath(seaOverride?: SeaModule | null, home?: string): string {
  const sea = seaOverride === undefined ? loadSea() : seaOverride
  if (sea) {
    const dir = seaCacheDir(CLI_VERSION, home)
    for (const name of MCP_SERVER_PATTERN_FILES) {
      const key = `lexical/patterns/${name}`
      extractAssetOnce(join(dir, 'lexical', 'patterns'), name, () => sea.getRawAsset(key))
    }
    return extractAssetOnce(dir, MCP_SERVER_FILE_NAME, () => sea.getRawAsset(MCP_SERVER_FILE_NAME))
  }
  // Deliberately not `new URL('./file-tools-mcp-server.mjs', import.meta.url)` as a single literal —
  // Vite's asset-URL plugin statically detects that exact pattern and inlines the whole file as a
  // base64 data: URL at build time, which fileURLToPath can't turn back into a real path.
  return fileURLToPath(new URL(MCP_SERVER_FILE_NAME, import.meta.url))
}
