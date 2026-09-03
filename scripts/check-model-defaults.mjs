#!/usr/bin/env node
/**
 * F1 (plans/adoption_plan.html): the per-provider default model id must live in exactly one
 * place — packages/runtime/src/model-defaults.ts — and every runtime client + every surface
 * that displays "the model that will be used" must import it rather than hand-type a literal
 * that silently rots a generation behind (the repo shipped `claude-3-5-sonnet-20241022` /
 * `gpt-4o-mini` as live defaults roughly a year past their prime before this check existed).
 *
 * This fails CI if a previous-generation or dated-snapshot model id (`claude-1/2/3-*`,
 * `claude-instant`, `gpt-3*`, `gpt-4*`, a `-20YYMMDD` / `-20YY-MM-DD` suffix for a year
 * through 2024) appears as a string literal in any scanned file OUTSIDE a comment. Test
 * files are not scanned — they pin explicit-override behaviour and legitimately name old ids.
 *
 * To bump a default: edit model-defaults.ts only. If a genuinely current id ever needs a
 * date suffix, widen DATED_SNAPSHOT below rather than suppressing the whole check.
 *
 * Run manually:  node scripts/check-model-defaults.mjs
 * Run in CI:     same command; exits 1 on a stale literal.
 */
import { readFileSync } from 'fs'

// The runtime LLM clients + the CLI/browser surfaces that render a default-model string.
// model-defaults.ts is included on purpose: it must itself stay current, and it's the only
// file where a bare id is allowed to appear (it will pass — the ids there are current).
const SCANNED_FILES = [
  'packages/runtime/src/model-defaults.ts',
  'packages/runtime/src/anthropic-client.ts',
  'packages/runtime/src/llm-client.ts',
  'packages/runtime/src/openai-compatible-client.ts',
  'packages/personal-assistant/src/cli.ts',
  'packages/personal-assistant/src/assistant-session.ts',
  'packages/chat-ui/src/App.tsx',
  'packages/chat-ui/src/components/SettingsScreen.tsx',
]

const STALE_FAMILY = /\b(?:claude-instant|claude-[123][.-]|claude-2\b|gpt-3(?:\.\d)?\b|gpt-3[-.]|gpt-4)/i
const DATED_SNAPSHOT = /-20(?:1\d|2[0-4])(?:\d{2}|-\d{2}-\d{2})\b/

/** Remove /* *\/ block comments and // line comments so ids mentioned in prose don't trip the check. */
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:'"`\\])\/\/.*$/gm, '$1')
}

/** All single/double/back-quoted string literals in a (comment-stripped) source. */
function stringLiterals(src) {
  const out = []
  const re = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/g
  let m
  while ((m = re.exec(src)) !== null) out.push(m[2])
  return out
}

const violations = []
for (const file of SCANNED_FILES) {
  let src
  try {
    src = readFileSync(file, 'utf8')
  } catch {
    violations.push({ file, literal: '(file missing — update SCANNED_FILES)' })
    continue
  }
  for (const literal of stringLiterals(stripComments(src))) {
    if (STALE_FAMILY.test(literal) || DATED_SNAPSHOT.test(literal)) {
      violations.push({ file, literal })
    }
  }
}

if (violations.length > 0) {
  console.error('❌  Stale / previous-generation model id used as a literal (edit packages/runtime/src/model-defaults.ts and import from it):')
  for (const { file, literal } of violations) {
    console.error(`     - ${file}: "${literal}"`)
  }
  process.exit(1)
}

console.log(`✅  Model defaults OK — ${SCANNED_FILES.length} files scanned, no stale model literal.`)
