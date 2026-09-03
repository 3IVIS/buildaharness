#!/usr/bin/env node
/**
 * F8 (plans/adoption_plan.html): the comparison page and README lean on Aielia being
 * "safer than an unsandboxed agent". That claim is only defensible if the trust model is
 * written down AND the boundaries it names still exist in the code. This gate fails CI when:
 *
 *   - SECURITY.md or docs/threat-model.md is missing;
 *   - SECURITY.md has no private reporting channel;
 *   - README.md stops linking either doc;
 *   - a source symbol docs/threat-model.md cites as enforcing a boundary has disappeared
 *     from the file named next to it (the doc would then be describing code that's gone).
 *
 * Run manually:  node scripts/check-security-docs.mjs
 * Run in CI:     same command; exits 1 on any of the above.
 */
import { readFileSync } from 'fs'

function read(path) {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

const errors = []

const security = read('SECURITY.md')
if (security === null) {
  errors.push('SECURITY.md is missing')
} else {
  if (!/##\s*Reporting a vulnerability/i.test(security)) {
    errors.push('SECURITY.md has no "## Reporting a vulnerability" section')
  }
  if (!/security\/advisories/.test(security) && !/mailto:|@/.test(security)) {
    errors.push('SECURITY.md names no private reporting channel (a security/advisories link or an email)')
  }
}

const threatModel = read('docs/threat-model.md')
if (threatModel === null) errors.push('docs/threat-model.md is missing')

const readme = read('README.md')
if (readme === null) {
  errors.push('README.md is missing')
} else {
  if (!readme.includes('docs/threat-model.md')) errors.push('README.md no longer links docs/threat-model.md')
  if (!readme.includes('SECURITY.md')) errors.push('README.md no longer links SECURITY.md')
}

// Each boundary the threat model claims → the source symbol + file that enforces it.
// If the doc cites it, the code must still define it.
const CITED_SYMBOLS = [
  ['stagePendingAction', 'packages/personal-assistant/src/file-tools.ts'],
  ['resolveInWorkspace', 'packages/personal-assistant/src/file-tools.ts'],
  ['assertRealPathInWorkspace', 'packages/personal-assistant/src/file-tools.ts'],
  ['failSafeClassification', 'packages/personal-assistant/src/turn-intent-classifier.ts'],
  ['toTaskRiskLevel', 'packages/personal-assistant/src/task-mapping.ts'],
  ['wrapUntrusted', 'packages/personal-assistant/src/trust-tagging.ts'],
  ['detectInjectionLikely', 'packages/personal-assistant/src/trust-tagging.ts'],
  ['assertPublicHttpUrl', 'packages/personal-assistant/src/web-tools.ts'],
  ['ALLOWED_ENV_VARS', 'packages/personal-assistant/src/shell-executor.ts'],
  ['allowlistedEnv', 'packages/personal-assistant/src/shell-executor.ts'],
  ['getNetworkContainmentProxy', 'packages/personal-assistant/src/network-containment.ts'],
]

if (threatModel !== null) {
  for (const [symbol, file] of CITED_SYMBOLS) {
    if (!threatModel.includes(symbol)) continue // the doc no longer cites it — nothing to verify
    const src = read(file)
    if (src === null) {
      errors.push(`docs/threat-model.md cites ${symbol}, but ${file} is missing`)
    } else if (!new RegExp(`\\b${symbol}\\b`).test(src)) {
      errors.push(`docs/threat-model.md cites ${symbol} as living in ${file}, but that symbol is no longer there`)
    }
  }
}

if (errors.length > 0) {
  console.error('❌  Security docs / threat-model check failed:')
  for (const e of errors) console.error(`     - ${e}`)
  process.exit(1)
}

console.log('✅  Security docs OK — SECURITY.md + docs/threat-model.md present, linked, and their cited boundaries still exist.')
