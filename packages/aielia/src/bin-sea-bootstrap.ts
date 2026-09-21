/**
 * The Node Single Executable Application (SEA) entry point — the `main` script injected into the
 * standalone `aielia` binary (see scripts/build-sea-bundle.mjs). Bundled to CommonJS, because
 * Node always runs a SEA's main via embedderRunCjs and rejects ESM there.
 *
 * The real app can't itself be CJS (ink's reconciler and yoga-layout use top-level await, which
 * esbuild refuses to emit as CJS), so it is embedded as a second asset, `app-bundle`. This shell
 * extracts that ESM bundle to disk once per CLI version and `import()`s it. Only node builtins
 * are used here, so there is nothing for the CJS bundling step to trip over.
 */
import { pathToFileURL } from 'node:url'
import { CLI_VERSION } from './version.js'
import { extractAssetOnce, seaCacheDir } from './sea-cache.js'

async function bootstrap(): Promise<void> {
  // `require` (not `import`) — `node:sea` only resolves inside a real SEA, and this file is CJS.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const sea = require('node:sea') as {
    isSea(): boolean
    getRawAsset(key: string): ArrayBuffer
  }
  if (!sea.isSea()) {
    throw new Error('bin-sea-bootstrap must only run inside a Node single executable application (use dist/cli.js otherwise).')
  }
  const appPath = extractAssetOnce(seaCacheDir(CLI_VERSION), 'app.mjs', () => sea.getRawAsset('app-bundle'))
  await import(pathToFileURL(appPath).href)
}

bootstrap().catch((err: unknown) => {
  process.stderr.write(`aielia: failed to start: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`)
  process.exit(1)
})
