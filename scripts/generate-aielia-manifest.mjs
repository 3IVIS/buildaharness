#!/usr/bin/env node
/**
 * Builds `aielia-latest.json` — the product-scoped update manifest that `aielia update` /
 * `install.sh` resolve (never GitHub's repo-wide `/releases/latest`, which is shared with every
 * other `*-v*` release line in this repo). Run by `.github/workflows/publish-aielia-manifest.yml`.
 *
 * Schema (must match `parseManifest` in packages/aielia/src/self-update.ts):
 *   { tag, version, assets: { "<platform>-<arch>": { url, sha256, size } } }
 *
 * Inputs: a directory holding the release's binaries (`aielia-<platform>-<arch>[.exe]`) and their
 * `.sha256` sidecars (as written by packages/aielia/scripts/build-sea-bundle.mjs).
 *
 * Usage: node scripts/generate-aielia-manifest.mjs --tag aielia-v0.3.1 --repo 3IVIS/buildaharness \
 *          --assets-dir <dir> --out aielia-latest.json [--check-urls]
 *   --check-urls  HEAD every asset URL and fail unless each resolves to a 200 (redirects followed),
 *                 so a broken manifest is never published.
 */
import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const TAG_PREFIX = 'aielia-v'
/** The four binaries a complete release must carry (Stage 3's matrix). */
export const REQUIRED_PLATFORMS = ['darwin-arm64', 'darwin-x64', 'linux-x64', 'win32-x64']

/** `aielia-linux-x64` / `aielia-win32-x64.exe` → `linux-x64` / `win32-x64`; anything else (e.g. `.sha256`) → null. */
export function platformKeyFromAssetName(name) {
  const m = /^aielia-([a-z0-9]+-[a-z0-9]+?)(?:\.exe)?$/.exec(name)
  return m ? m[1] : null
}

/**
 * Pure: `files` is `[{name, size, sidecar}]` where `sidecar` is the text of `<name>.sha256`.
 * Throws on a bad tag, a missing/malformed checksum, or a missing required platform.
 */
export function buildManifest({ tag, repo, files, requiredPlatforms = REQUIRED_PLATFORMS }) {
  if (!tag.startsWith(TAG_PREFIX)) throw new Error(`Tag "${tag}" does not start with "${TAG_PREFIX}"`)
  const version = tag.slice(TAG_PREFIX.length)
  if (!/^\d+\.\d+\.\d+/.test(version)) throw new Error(`Tag "${tag}" carries no semver version`)
  const assets = {}
  for (const f of files) {
    const key = platformKeyFromAssetName(f.name)
    if (!key) continue
    const m = /\b[0-9a-fA-F]{64}\b/.exec(f.sidecar ?? '')
    if (!m) throw new Error(`No sha256 found in the sidecar for ${f.name}`)
    assets[key] = {
      url: `https://github.com/${repo}/releases/download/${tag}/${f.name}`,
      sha256: m[0].toLowerCase(),
      size: f.size,
    }
  }
  const missing = requiredPlatforms.filter((p) => !assets[p])
  if (missing.length) throw new Error(`Release ${tag} is missing binaries for: ${missing.join(', ')}`)
  const sorted = Object.fromEntries(Object.entries(assets).sort(([a], [b]) => a.localeCompare(b)))
  return { tag, version, assets: sorted }
}

/** HEADs every asset URL (following redirects — GitHub serves release assets via a CDN redirect). Returns the failures. */
export async function checkAssetUrls(manifest, fetchFn = fetch) {
  const failures = []
  for (const [key, a] of Object.entries(manifest.assets)) {
    try {
      const res = await fetchFn(a.url, { method: 'HEAD', redirect: 'follow' })
      if (res.status !== 200) failures.push(`${key}: HTTP ${res.status} for ${a.url}`)
    } catch (err) {
      failures.push(`${key}: ${err?.message ?? err} for ${a.url}`)
    }
  }
  return failures
}

export function readAssetDir(dir) {
  return readdirSync(dir)
    .filter((n) => platformKeyFromAssetName(n))
    .map((name) => {
      let sidecar
      try { sidecar = readFileSync(join(dir, `${name}.sha256`), 'utf8') } catch { /* reported by buildManifest */ }
      return { name, size: statSync(join(dir, name)).size, sidecar }
    })
}

async function main() {
  const args = process.argv.slice(2)
  const flag = (n) => { const i = args.indexOf(n); return i === -1 ? undefined : args[i + 1] }
  const tag = flag('--tag')
  const repo = flag('--repo')
  const dir = flag('--assets-dir')
  const out = flag('--out')
  if (!tag || !repo || !dir || !out) {
    console.error('usage: generate-aielia-manifest.mjs --tag <aielia-vX.Y.Z> --repo <owner/repo> --assets-dir <dir> --out <file> [--check-urls]')
    process.exit(2)
  }
  const manifest = buildManifest({ tag, repo, files: readAssetDir(resolve(dir)) })
  if (args.includes('--check-urls')) {
    const failures = await checkAssetUrls(manifest)
    if (failures.length) {
      console.error(`❌  Refusing to publish a manifest with unreachable assets:\n  ${failures.join('\n  ')}`)
      process.exit(1)
    }
  }
  writeFileSync(resolve(out), JSON.stringify(manifest, null, 2) + '\n')
  console.log(`✅  Wrote ${out}: ${tag}, ${Object.keys(manifest.assets).join(', ')}`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(`❌  ${err.message}`)
    process.exit(1)
  })
}
