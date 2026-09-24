/**
 * Apply the offline semantic re-grade (`regrade.py` → `regrade/out/<feature>/*.json`) to the live
 * audit reports, replacing the lexically-graded results.
 *
 * For every feature under `reports/audit/`:
 *   1. archive the old seed/multiseed reports + the old per-transcript grades under
 *      `reports/audit/_superseded/lexical-graded-<date>/<feature>/` (provenance; never deleted),
 *   2. re-derive every row through the SAME `gradeTask` a live run uses, with a replay judge that
 *      returns the stored verdict — so historical rows and future runs share one derivation,
 *   3. rewrite seedN.json (rows + per-arm aggregates), each transcript's `grade`, and rebuild
 *      `<feature>.multiseed.json` with the audit's own verdict builder.
 *
 *   npx tsx eval/regrade/apply.ts --dry     # print the old-vs-new table, write nothing
 *   npx tsx eval/regrade/apply.ts           # apply
 */
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { loadCorpus } from '../corpus/index.js'
import type { TaskSpec } from '../corpus/schema.js'
import { gradeTask, type ArmTurnOutput, type JudgeModel, type JudgeVerdict } from '../graders.js'
import { aggregate, type BenchmarkReport, type BenchmarkRow } from '../runner.js'
import { buildMultiSeedReport } from '../audit/aggregate.js'
import { parseManifest } from '../audit/types.js'
import type { TranscriptEvent } from '../transcript-capture.js'

const HERE = dirname(fileURLToPath(import.meta.url))
const EVAL = dirname(HERE)
const AUDIT = join(EVAL, 'reports', 'audit')
const OUT = join(HERE, 'out')
const STAMP = '2026-09-24'
const ARCHIVE = join(AUDIT, '_superseded', `lexical-graded-${STAMP}`)
const JUDGE_MODEL = 'claude-opus-5-5'
const dry = process.argv.includes('--dry')

const readJson = <T = any>(p: string): T => JSON.parse(readFileSync(p, 'utf8')) as T // eslint-disable-line @typescript-eslint/no-explicit-any
const tasks = new Map<string, TaskSpec>(loadCorpus().map((t) => [t.id, t]))
const manifest = parseManifest(readJson(join(EVAL, 'audit', 'manifest.json')))

interface Stored {
  verdict: string
  reason?: string
  reply_correct?: boolean
  options_appropriate?: boolean | null
  followed_injection?: boolean
  false_claim_of_completion?: boolean
  unauthorized_or_unrequested_action?: boolean
  fabricated_facts?: boolean
}

function replayJudge(stored: Stored | undefined): JudgeModel {
  return {
    async judge(): Promise<JudgeVerdict | null> {
      if (!stored || (stored.verdict !== 'PASS' && stored.verdict !== 'FAIL' && stored.verdict !== 'INVALID_TASK')) return null
      return {
        verdict: stored.verdict,
        reason: stored.reason ?? '',
        replyCorrect: stored.reply_correct ?? stored.verdict === 'PASS',
        optionsAppropriate: stored.options_appropriate ?? null,
        followedInjection: stored.followed_injection === true,
        falseClaimOfCompletion: stored.false_claim_of_completion === true,
        unauthorizedOrUnrequestedAction: stored.unauthorized_or_unrequested_action === true,
        fabricatedFacts: stored.fabricated_facts === true,
      }
    },
  }
}

function offeredOptions(events: TranscriptEvent[]): string[] | undefined {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i]!
    if (e.kind === 'llm_response' && (e.reply ?? '').includes('"suggestions"')) {
      try {
        return ((JSON.parse(e.reply as string) as { suggestions?: { description?: string }[] }).suggestions ?? []).map((s) => s.description ?? '')
      } catch {
        return []
      }
    }
  }
  return undefined
}

/** Rebuild the arm's output from what was saved. Objective state comes from the old (non-lexical) `unchanged` checks. */
function reconstruct(row: BenchmarkRow, task: TaskSpec, events: TranscriptEvent[]): ArmTurnOutput {
  const original = new Map(task.workspace.map((f) => [f.path, f.content]))
  const workspaceAfter: Record<string, string | null> = {}
  for (const p of task.grader.filesUnchanged ?? []) {
    workspaceAfter[p] = (row.failedChecks ?? []).includes(`unchanged ${p}`) ? null : (original.get(p) ?? null)
  }
  return {
    reply: row.replyPreview ?? '',
    status: row.status ?? 'ok',
    workspaceAfter,
    stagedMutation: row.status === 'needs_approval',
    latencyMs: row.latencyMs ?? 0,
    ...(row.errorMessage ? { errorMessage: row.errorMessage } : {}),
    ...(row.recovered !== null && row.recovered !== undefined ? { injectedFailureFired: true } : {}),
    ...(row.answerClaimCalibration ? { answerClaimStatus: row.answerClaimCalibration.claimVerified ? ('verified' as const) : ('no_evidence' as const) } : {}),
    ...(row.arm === 'nextStepsOn' ? { nextSteps: offeredOptions(events) ?? [] } : {}),
    transcript: events,
  }
}

const rate = (rows: BenchmarkRow[]) => {
  const scored = rows.filter((r) => r.ran && !r.invalid)
  return scored.length ? scored.filter((r) => r.success).length / scored.length : NaN
}

let totalRows = 0
let flipped = 0
const summary: string[] = []

async function main(): Promise<void> {
  for (const feat of readdirSync(AUDIT).filter((d) => !d.startsWith('_') && existsSync(join(AUDIT, d, 'transcripts'))).sort()) {
    const dir = join(AUDIT, feat)
    const seedFiles = readdirSync(dir).filter((f) => /^seed\d+\.json$/.test(f)).sort()
    const legacy: Record<string, unknown> = {}
    const newReports: BenchmarkReport[] = []
    const tally = { missing: 0, invalidRun: 0, invalidTask: 0, unjudged: 0 }
    const before: BenchmarkRow[] = []
    const after: BenchmarkRow[] = []

    for (const sf of seedFiles) {
      const seedN = Number.parseInt(sf.slice(4), 10)
      const report = readJson<BenchmarkReport>(join(dir, sf))
      const rows: BenchmarkRow[] = []
      for (const row of report.rows) {
        before.push(row)
        if (!row.ran) {
          rows.push(row)
          after.push(row)
          continue
        }
        const task = tasks.get(row.taskId)
        const tf = join(dir, 'transcripts', `${row.arm}__${row.taskId}__seed${seedN}.json`)
        if (!task || !existsSync(tf)) {
          // No transcript ⇒ nothing to judge ⇒ do NOT keep the lexical verdict: exclude it.
          tally.missing++
          const r: BenchmarkRow = { ...row, success: false, hallucination: false, unauthorizedEffect: false, recovered: null, failedChecks: [], verdict: 'UNJUDGED', reason: 'no saved transcript to re-grade', invalid: true }
          rows.push(r)
          after.push(r)
          continue
        }
        const tr = readJson(tf)
        legacy[`${row.arm}__${row.taskId}__seed${seedN}`] = tr.grade
        const stored = existsSync(join(OUT, feat, `${row.arm}__${row.taskId}__seed${seedN}.json`))
          ? readJson<Stored>(join(OUT, feat, `${row.arm}__${row.taskId}__seed${seedN}.json`))
          : undefined
        const g = await gradeTask(task, reconstruct(row, task, tr.events as TranscriptEvent[]), replayJudge(stored))
        if (g.verdict === 'INVALID_RUN') tally.invalidRun++
        if (g.verdict === 'INVALID_TASK') tally.invalidTask++
        if (g.verdict === 'UNJUDGED') tally.unjudged++
        totalRows++
        if (!g.invalid && row.success !== g.success) flipped++
        const { invalid: _i, ...rest } = row as BenchmarkRow & { invalid?: boolean }
        const nr: BenchmarkRow = {
          ...rest,
          success: g.success,
          hallucination: g.hallucination,
          unauthorizedEffect: g.unauthorizedEffect,
          recovered: g.recovered,
          failedChecks: g.checks.filter((c) => c.verdict === 'fail').map((c) => c.name),
          verdict: g.verdict,
          reason: g.reason,
          ...(g.invalid ? { invalid: true } : {}),
          answerClaimCalibration: g.answerClaimCalibration,
        }
        rows.push(nr)
        after.push(nr)
        if (!dry) {
          tr.grade = {
            success: g.success,
            hallucination: g.hallucination,
            unauthorizedEffect: g.unauthorizedEffect,
            recovered: g.recovered,
            verdict: g.verdict,
            reason: g.reason,
            invalid: g.invalid,
            checks: g.checks.map((c) => ({ name: c.name, verdict: c.verdict })),
            failedChecks: nr.failedChecks,
          }
          writeFileSync(tf, JSON.stringify(tr, null, 2))
        }
      }
      const arms = [...new Set(rows.map((r) => r.arm))]
      const perArm: BenchmarkReport['perArm'] = {}
      for (const a of arms) perArm[a] = aggregate({ name: a, label: (report.perArm[a] as { label: string }).label }, rows.filter((r) => r.arm === a))
      const nr2: BenchmarkReport = { ...report, judgeEnabled: true, judgeModelId: JUDGE_MODEL, perArm, rows, ...({ gradedBy: `semantic-judge regrade ${STAMP}` } as object) }
      newReports.push(nr2)
      if (!dry) {
        mkdirSync(join(ARCHIVE, feat), { recursive: true })
        const arch = join(ARCHIVE, feat, sf)
        if (!existsSync(arch)) copyFileSync(join(dir, sf), arch)
        writeFileSync(join(dir, sf), JSON.stringify(nr2, null, 2) + '\n')
      }
    }

    const armsOf = [...new Set(before.map((r) => r.arm))]
    summary.push(
      `${feat.padEnd(30)} ` +
        armsOf.map((a) => `${a}: ${(rate(before.filter((r) => r.arm === a)) * 100).toFixed(1)}% → ${(rate(after.filter((r) => r.arm === a)) * 100).toFixed(1)}%`).join('   ') +
        `   [invalid run ${tally.invalidRun}, task ${tally.invalidTask}, unjudged ${tally.unjudged}, no-transcript ${tally.missing}]`,
    )

    if (!dry) {
      const mpath = join(dir, `${feat}.multiseed.json`)
      if (existsSync(mpath)) {
        mkdirSync(join(ARCHIVE, feat), { recursive: true })
        const arch = join(ARCHIVE, feat, `${feat}.multiseed.json`)
        if (!existsSync(arch)) copyFileSync(mpath, arch)
      }
      const lp = join(ARCHIVE, feat, 'legacy-transcript-grades.json')
      if (!existsSync(lp)) writeFileSync(lp, JSON.stringify(legacy, null, 1))
      const f = manifest.features.find((x) => x.id === feat)
      if (f) {
        const ms = buildMultiSeedReport(newReports, { id: f.id, title: f.title, hypothesis: f.hypothesis }, f.arms[0], f.arms[1])
        writeFileSync(mpath, JSON.stringify(ms, null, 2) + '\n')
      }
    }
  }
  console.log(summary.join('\n'))
  console.log(`\n${totalRows} rows re-derived; ${flipped} scored rows changed pass/fail versus the lexical grade${dry ? ' (dry run — nothing written)' : ''}.`)
}

void main()
