// AL4b: heuristic scanner for natural-language regex/keyword decisions in shipped source.
// Shared by packages/aielia/src/lexical-gates-lint.test.ts (runs inside `npm run test:aielia`)
// and scripts/check-lexical-gates.mjs (thin CLI wrapper for CI).
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const SCAN_ROOTS = ['packages/harness/src', 'packages/aielia/src', 'packages/runtime/src']
const EXT = /\.(ts|tsx|mjs)$/
const SKIP = /(\.test\.|\.spec\.|\.d\.ts$|[\\/]__tests__[\\/]|[\\/]node_modules[\\/]|[\\/]dist[\\/])/

// A regex literal that alternates >=2 alphabetic words (e.g. /\b(yes|no)\b/) is a keyword list;
// a regex literal containing a run of >=5 letters outside escapes is a spelled-out word.
const WORD_ALTERNATION = /(?:^|[(|:?])[A-Za-z]{3,}(?:\|[A-Za-z]{3,})+/
const SPELLED_WORD = /(?:^|[^\\A-Za-z])[A-Za-z]{5,}/
const REGEX_PRECEDERS = new Set(['(', ',', '=', ':', '[', '!', '&', '|', '?', '{', '}', ';', '+', '-', '*', '%', '<', '>', '~', '^'])

export function isNaturalLanguageRegex(body) {
  const stripped = body.replace(/\\[A-Za-z]/g, '\\_')
  return WORD_ALTERNATION.test(stripped) || SPELLED_WORD.test(stripped)
}

/** Regex-literal bodies and `new RegExp(` call sites in source text, skipping comments and strings. */
export function extractRegexes(text) {
  const out = []
  let i = 0
  let prev = '' // last significant (non-space) char outside comments
  let prevWord = ''
  const n = text.length
  while (i < n) {
    const c = text[i]
    const d = text[i + 1]
    if (c === '/' && d === '/') { while (i < n && text[i] !== '\n') i++; continue }
    if (c === '/' && d === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; continue }
    if (c === '"' || c === "'" || c === '`') {
      i++
      while (i < n && text[i] !== c) { if (text[i] === '\\') i++; else if (c !== '`' && text[i] === '\n') break; i++ }
      i++; prev = 'a'; prevWord = ''; continue
    }
    if (c === '/') {
      const isRegex = prev === '' || REGEX_PRECEDERS.has(prev) || prevWord === 'return' || prevWord === 'typeof'
      if (isRegex) {
        let j = i + 1
        let inClass = false
        while (j < n && text[j] !== '\n' && (inClass || text[j] !== '/')) {
          if (text[j] === '\\') j++
          else if (text[j] === '[') inClass = true
          else if (text[j] === ']') inClass = false
          j++
        }
        if (text[j] === '/') { out.push(text.slice(i + 1, j)); i = j + 1; while (/[a-z]/.test(text[i] ?? '')) i++; prev = 'a'; prevWord = ''; continue }
      }
    }
    if (/\s/.test(c)) { i++; continue }
    if (/[A-Za-z_$]/.test(c)) {
      let j = i
      while (j < n && /[\w$]/.test(text[j])) j++
      prevWord = text.slice(i, j)
      if (prevWord === 'RegExp' && text[j] === '(' && /new\s+$/.test(text.slice(Math.max(0, i - 6), i))) out.push(null)
      i = j; prev = 'a'; continue
    }
    prev = c; prevWord = ''; i++
  }
  return out
}

/** Count natural-language regex hits (keyword-list literals and dynamic `new RegExp`) in one file's source. */
export function scanSource(text) {
  return extractRegexes(text).filter((body) => body === null || isNaturalLanguageRegex(body)).length
}

function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (EXT.test(name) && !SKIP.test(p)) out.push(p)
  }
}

/** Map of repo-relative file -> hit count, for files with at least one hit. */
export function scanTree(root = repoRoot) {
  const files = []
  for (const r of SCAN_ROOTS) walk(join(root, r), files)
  const result = {}
  for (const f of files.sort()) {
    const n = scanSource(readFileSync(f, 'utf8'))
    if (n > 0) result[relative(root, f)] = n
  }
  return result
}

/**
 * Compare a scan against the inventory. Returns human-readable violations:
 * a file with hits but no inventory site, or more hits than its recorded baseline (a new gate).
 * Class-A-only files are fine so long as the count does not grow past the baseline.
 */
export function findViolations(scan, inventory) {
  const known = new Set(inventory.sites.map((s) => s.file))
  const baseline = inventory.scanBaseline ?? {}
  const out = []
  for (const [file, n] of Object.entries(scan)) {
    if (!known.has(file)) out.push(`${file}: ${n} natural-language regex hit(s) but no site in scripts/lexical-gates.json — classify it (A/B/C)`)
    else if (n > (baseline[file] ?? 0)) out.push(`${file}: ${n} hit(s), baseline ${baseline[file] ?? 0} — a new lexical gate; add/classify it in scripts/lexical-gates.json and update scanBaseline`)
  }
  return out
}
