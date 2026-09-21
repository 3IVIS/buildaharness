#!/usr/bin/env node
/**
 * Builds the standalone `aielia` binary (a Node Single Executable Application) for the CURRENT
 * platform — SEA has no cross-compile story, so CI runs this once per OS/arch (see the plan's
 * Stage 3). Independent of the npm/vite build (`npm run build`), which is untouched.
 *
 * Pipeline (all output under packages/aielia/sea-build/, gitignored via packages/aielia/.gitignore):
 *   1. esbuild  src/bin.ts                  → app.mjs         (ESM, one self-contained file)
 *   2. esbuild  src/bin-sea-bootstrap.ts    → bootstrap.cjs   (CJS SEA `main`, node builtins only)
 *   3. esbuild  src/file-tools-mcp-server.mjs → file-tools-mcp-server.mjs (self-contained: the
 *      extracted copy lives under ~/.buildaharness with no node_modules beside it to resolve
 *      `zod` / `@modelcontextprotocol/sdk` from)
 *   4. sea-config.json (generated) → `node --experimental-sea-config` → sea-prep.blob
 *   5. copy this platform's own `node`, inject the blob with postject, chmod +x
 *   6. write a <binary>.sha256 sidecar
 *
 * Usage: node scripts/build-sea-bundle.mjs [--out-dir <dir>]
 */
import { build } from 'esbuild'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const pkgDir = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(import.meta.url)

const outFlag = process.argv.indexOf('--out-dir')
const outDir = resolve(outFlag !== -1 ? process.argv[outFlag + 1] : join(pkgDir, 'sea-build'))

/** `aielia-<platform>-<arch>[.exe]`, e.g. aielia-linux-x64, aielia-darwin-arm64, aielia-win32-x64.exe. */
export function binaryName(platform = process.platform, arch = process.arch) {
  return `aielia-${platform}-${arch}${platform === 'win32' ? '.exe' : ''}`
}

/**
 * ink's reconciler has a dev-only dynamic import of the optional peer `react-devtools-core`;
 * esbuild hoists it to a real top-level import, which crashes at startup when the package is
 * absent. Resolve it to an inert stub instead.
 */
const stubDevtoolsPlugin = {
  name: 'stub-react-devtools-core',
  setup(b) {
    b.onResolve({ filter: /^react-devtools-core$/ }, () => ({ path: 'react-devtools-core', namespace: 'devtools-stub' }))
    b.onLoad({ filter: /.*/, namespace: 'devtools-stub' }, () => ({
      contents: 'export default { initialize() {}, connectToDevTools() {} }; export function initialize() {} export function connectToDevTools() {}',
      loader: 'js',
    }))
  },
}

// Some bundled CJS dependencies call `require(...)` / use __dirname; an ESM bundle has neither.
const esmCompatBanner = [
  "import { createRequire as __createRequire } from 'node:module';",
  "import { fileURLToPath as __fileURLToPath } from 'node:url';",
  "import { dirname as __dirname_ } from 'node:path';",
  'const require = __createRequire(import.meta.url);',
  'const __filename = __fileURLToPath(import.meta.url);',
  'const __dirname = __dirname_(__filename);',
].join('\n')

async function main() {
  rmSync(outDir, { recursive: true, force: true })
  mkdirSync(outDir, { recursive: true })
  const appBundle = join(outDir, 'app.mjs')
  const bootstrap = join(outDir, 'bootstrap.cjs')
  const mcpServer = join(outDir, 'file-tools-mcp-server.mjs')

  const common = { bundle: true, platform: 'node', target: 'node22', logLevel: 'warning' }
  await build({
    ...common,
    entryPoints: [join(pkgDir, 'src/bin.ts')],
    outfile: appBundle,
    format: 'esm',
    banner: { js: esmCompatBanner },
    jsx: 'automatic',
    plugins: [stubDevtoolsPlugin],
    define: { 'process.env.NODE_ENV': '"production"' },
  })
  await build({ ...common, entryPoints: [join(pkgDir, 'src/bin-sea-bootstrap.ts')], outfile: bootstrap, format: 'cjs' })
  await build({
    ...common,
    entryPoints: [join(pkgDir, 'src/file-tools-mcp-server.mjs')],
    outfile: mcpServer,
    format: 'esm',
    // Not esmCompatBanner: the server declares its own top-level `__dirname`, which would collide.
    banner: { js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);" },
  })

  // Asset keys — must match what bin-sea-bootstrap.ts / mcp-server-asset.ts ask sea.getRawAsset() for.
  const assets = { 'app-bundle': appBundle, 'file-tools-mcp-server.mjs': mcpServer }
  const patternsDir = join(pkgDir, 'src/lexical/patterns')
  for (const f of readdirSync(patternsDir).filter((n) => n.endsWith('.json')).sort()) {
    assets[`lexical/patterns/${f}`] = join(patternsDir, f)
  }

  const blob = join(outDir, 'sea-prep.blob')
  const seaConfig = join(outDir, 'sea-config.json')
  writeFileSync(seaConfig, JSON.stringify({ main: bootstrap, output: blob, disableExperimentalSEAWarning: true, assets }, null, 2))
  execFileSync(process.execPath, ['--experimental-sea-config', seaConfig], { stdio: 'inherit' })

  const binPath = join(outDir, binaryName())
  copyFileSync(process.execPath, binPath)
  if (process.platform === 'darwin') {
    // postject can't write into a signed Mach-O; the copied node binary's signature is dropped first.
    try { execFileSync('codesign', ['--remove-signature', binPath], { stdio: 'inherit' }) } catch { /* not signed / codesign absent */ }
  }
  const postjectBin = require.resolve('postject/dist/cli.js')
  const injectArgs = [
    postjectBin, binPath, 'NODE_SEA_BLOB', blob,
    '--sentinel-fuse', 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
  ]
  if (process.platform === 'darwin') injectArgs.push('--macho-segment-name', 'NODE_SEA')
  execFileSync(process.execPath, injectArgs, { stdio: 'inherit' })
  if (process.platform !== 'win32') chmodSync(binPath, 0o755)
  if (process.platform === 'darwin') {
    try { execFileSync('codesign', ['--sign', '-', binPath], { stdio: 'inherit' }) } catch { /* ad-hoc re-sign is best-effort */ }
  }

  const digest = createHash('sha256').update(readFileSync(binPath)).digest('hex')
  writeFileSync(`${binPath}.sha256`, `${digest}  ${binaryName()}\n`)
  console.log(`built ${binPath}\nsha256 ${digest}`)
}

if (existsSync(join(pkgDir, 'src/bin.ts'))) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
