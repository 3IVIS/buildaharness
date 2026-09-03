#!/usr/bin/env node
/**
 * F9 (plans/adoption_plan.html): the /harness-comparison page and the assistant-first
 * README make specific, checkable factual claims about what Aielia does and doesn't do.
 * The personal-assistant README itself warns "nothing in this repo will catch that
 * drifting silently" — this is that check.
 *
 * Each CLAIM below is a machine-readable fact the marketing depends on, its expected
 * truth value, and a resolver that decides the fact from the actual source. CI fails when
 * a claim and the code disagree — whether the code regressed (a boundary was removed) or
 * advanced past the copy (a "not yet" became true and the pages/README weren't updated).
 *
 * When you change one of these facts in code, update `expected` here in the same commit,
 * and mirror the change into the pages repo's harness-comparison.html.
 *
 * Run manually:  node scripts/check-comparison-claims.mjs
 * Run in CI:     same command; exits 1 on any claim/code disagreement.
 */
import { readFileSync, existsSync } from 'fs'
import { execSync } from 'child_process'
import { pathToFileURL } from 'url'

function fileHas(path, pattern) {
  if (!existsSync(path)) return false
  return pattern.test(readFileSync(path, 'utf8'))
}

/** True if `pattern` (a ripgrep-style ERE) matches any non-test source file under packages/. */
function sourceHas(ere) {
  try {
    const out = execSync(
      `grep -rlE ${JSON.stringify(ere)} packages --include='*.ts' --include='*.mjs' 2>/dev/null || true`,
      { encoding: 'utf8' },
    )
    return out.split('\n').some((f) => f && !/\.test\.[tj]sx?$/.test(f) && !f.endsWith('.test.mjs'))
  } catch {
    return false
  }
}

export const CLAIMS = [
  {
    id: 'control_state_resolver',
    description: 'A tiered Control State resolver (ALLOW / CAUTIOUS / BLOCKED) governs the turn.',
    expected: true,
    resolve: () =>
      fileHas('packages/harness/src/nodes/resolve-control-state.ts', /export function resolveControlState\b/) &&
      fileHas('adapter/harness/control_state.py', /\bCAUTION_THRESHOLD\b|\bBLOCKED\b/),
  },
  {
    id: 'reviewer_pass',
    description: 'A reviewer/output gate runs before a reply is returned.',
    expected: true,
    resolve: () => fileHas('packages/harness/src/nodes/reviewer-pass.ts', /review/i),
  },
  {
    id: 'control_state_and_reviewer_shipped_together',
    description: 'Aielia is the one of the four that ships BOTH a tiered Control State resolver and a reviewer gate.',
    expected: true,
    resolve: () =>
      fileHas('packages/harness/src/nodes/resolve-control-state.ts', /export function resolveControlState\b/) &&
      fileHas('packages/harness/src/nodes/reviewer-pass.ts', /review/i),
  },
  {
    id: 'fail_safe_classification',
    description: 'A classifier error requires approval (UNKNOWN), never silently defaults to low-risk.',
    expected: true,
    resolve: () =>
      fileHas('packages/personal-assistant/src/turn-intent-classifier.ts', /function failSafeClassification\b/) &&
      fileHas('packages/personal-assistant/src/turn-intent-classifier.ts', /'UNKNOWN'/) &&
      fileHas('packages/personal-assistant/src/task-mapping.ts', /'UNKNOWN'\s*\?\s*'HIGH'/),
  },
  {
    id: 'per_tool_call_control_state_gate',
    description: 'Every read-only tool call is checked against a live per-turn ControlState before it runs.',
    expected: true,
    resolve: () =>
      fileHas('packages/personal-assistant/src/tool-policy.ts', /export function evaluateToolPolicy\b/) &&
      existsSync('packages/personal-assistant/src/tool-control-plane.ts'),
  },
  {
    id: 'typed_fact_provenance',
    description: 'Facts carry a source; only user-asserted facts auto-promote to durable memory.',
    expected: true,
    resolve: () => fileHas('packages/personal-assistant/src/fact-extraction.ts', /\bFactSource\b|\buser_asserted\b/),
  },
  {
    id: 'untrusted_content_boundary',
    description: 'Web/shell output is wrapped as untrusted content the model is told not to obey.',
    expected: true,
    resolve: () =>
      fileHas('packages/personal-assistant/src/trust-tagging.ts', /export function wrapUntrusted\b/) &&
      fileHas('packages/personal-assistant/src/system-prompt.ts', /untrusted_external_content/),
  },
  {
    id: 'crash_safe_mid_turn_resume',
    description: 'A turn that dies mid-flight resumes from its last checkpoint.',
    expected: true,
    resolve: () => fileHas('packages/personal-assistant/src/assistant-session.ts', /loadHarnessCheckpoint\(/),
  },
  {
    id: 'answer_claim',
    description: 'Replies distinguish verified-against-evidence from found-but-unconfirmed.',
    expected: true,
    resolve: () => fileHas('packages/personal-assistant/src/answer-claim.ts', /export function buildAnswerClaim\b/),
  },
  {
    id: 'web_search_on_claude_cli',
    description: 'The keyless claude-cli backend can run web_search (not just fetch_url).',
    expected: true, // F3 — flip to false only if the wiring is removed
    resolve: () =>
      fileHas('packages/personal-assistant/src/claude-cli-llm-client.ts', /this\.webTools\b/) &&
      fileHas('packages/personal-assistant/src/file-tools-mcp-server.mjs', /\bWEB_SEARCH_BACKEND\b/),
  },
  {
    id: 'send_effect_tool',
    description: 'Aielia has a real "send" tool (email) it can be asked to use — staged behind approval like write_file.',
    expected: true, // F2(a) — send_email; flip to false only if action-tools.ts is removed
    resolve: () =>
      sourceHas("name:\\s*['\\\"]send_email['\\\"]") &&
      fileHas('packages/personal-assistant/src/file-tools.ts', /kind: 'email'/),
  },
  {
    id: 'os_level_shell_sandbox',
    description: 'Approved shell commands run inside an OS-level sandbox (seccomp / landlock / sandbox-exec / container).',
    expected: false, // explicitly a non-goal — see docs/threat-model.md
    resolve: () => sourceHas('seccomp|landlock|sandbox-exec|firejail|bwrap'),
  },
]

export function evaluateClaims() {
  const disagreements = []
  for (const claim of CLAIMS) {
    let actual
    try {
      actual = claim.resolve()
    } catch (err) {
      disagreements.push({ claim, actual: `(resolver threw: ${err instanceof Error ? err.message : err})` })
      continue
    }
    if (actual !== claim.expected) disagreements.push({ claim, actual })
  }
  return disagreements
}

// Only run the check when invoked directly — not when imported by the test.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const disagreements = evaluateClaims()
  if (disagreements.length > 0) {
    console.error('❌  Comparison-page / README claims disagree with the code:')
    for (const { claim, actual } of disagreements) {
      console.error(`     - ${claim.id}: expected ${claim.expected}, code says ${actual}`)
      console.error(`       "${claim.description}"`)
    }
    console.error('\nUpdate `expected` in scripts/check-comparison-claims.mjs AND the pages repo / README in the same change.')
    process.exit(1)
  }
  console.log(`✅  Comparison claims OK — ${CLAIMS.length} marketing-critical facts match the code.`)
}
