#!/usr/bin/env -S npx tsx
/**
 * Comparative harness benchmark — Plan Phase B
 * (plans/harness_consolidation_and_control_plane_plan.html).
 *
 * Runs the implemented arms (`baseline`, `flagOn`) over the task corpus in
 * eval/corpus/*.json against a real model, grades each turn mechanically, and writes:
 *
 *   docs/harness_comparative_benchmark.md     — the human table (new run prepended)
 *   packages/personal-assistant/eval/reports/<timestamp>.json — the machine report
 *
 * (docs/harness_benchmark_report.md is the older P11.5 *perf* micro-benchmark — left alone.)
 *
 * Not part of `npm test` / CI's fast path — it makes real LLM calls. Uses the claude-cli backend
 * (shells out to `claude -p`, no API key — see CLAUDE.md) so it runs in any dev environment.
 *
 *   cd packages/personal-assistant && npx tsx scripts/run-harness-benchmark.ts
 *   npx tsx scripts/run-harness-benchmark.ts --tasks=compute-multiply,lookup-capital
 *   npx tsx scripts/run-harness-benchmark.ts --arms=baseline
 *   npx tsx scripts/run-harness-benchmark.ts --slice=supervisor_pivot,supervisor_lookup   # the S7 trajectory-supervisor slice
 *   npx tsx scripts/run-harness-benchmark.ts --exclude-slice=supervisor_pivot,supervisor_lookup,...  # full corpus MINUS these slices (mutually exclusive with --slice)
 *   npx tsx scripts/run-harness-benchmark.ts --gate=eval/reports/<before>.json   # Rule 6: exit 1 on regression
 *   npx tsx scripts/run-harness-benchmark.ts --gate=... --gate-arm=supervisorOn  # gate a different arm (default flagOn)
 *   npx tsx scripts/run-harness-benchmark.ts --no-judge                          # skip the LLM-as-judge pass
 *   npx tsx scripts/run-harness-benchmark.ts --model=sonnet --judge-model=sonnet # Plan A1: pin the model (default sonnet), recorded as report.modelId / report.judgeModelId
 *   npx tsx scripts/run-harness-benchmark.ts --transcripts=<dir> --seed-tag=1    # Plan A1: write <arm>__<task>__seed<n>.json full-conversation captures
 *   npx tsx scripts/run-harness-benchmark.ts --arms=flagOn,supervisorOn --slice=supervisor_pivot --seeds=3
 *       # S7 Rule 6: N independent repeats of the whole matrix (claude-cli has no seed param),
 *       # writes <stamp>.seedK.json per run + <stamp>.multiseed.json with per-metric
 *       # mean/stddev/CI95 and, for exactly two arms, a diffSeeds verdict (positive/neutral/regressed).
 *
 * The LLM-as-judge (`eval/judge.ts`, a tool-free `ClaudeCliLLMClient`) is **on by default** for a
 * real run — a `grader.judge` rubric that would otherwise score `skipped` gets classified YES/NO.
 * Pass `--no-judge` to turn it off. The machinery `eval/*.test.ts` never invoke this script and
 * stay judge-less (their `judge` checks keep scoring `skipped`).
 *
 * The `langgraph` arm is not implemented yet — see eval/README.md.
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ClaudeCliLLMClient } from '../src/claude-cli-llm-client.js'
import { loadCorpus } from '../eval/corpus/index.js'
import { IMPLEMENTED_ARMS, ALL_ARMS, type Arm } from '../eval/arms.js'
import { runBenchmark, type BenchmarkReport } from '../eval/runner.js'
import { renderMarkdown, diffReports, renderDiff, aggregateSeeds, diffSeeds, renderSeedDiff } from '../eval/report.js'
import { ClaudeCliJudge } from '../eval/judge.js'

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const REPO_ROOT = resolve(PKG_ROOT, '..', '..')
const REPORT_MD = join(REPO_ROOT, 'docs', 'harness_comparative_benchmark.md')
const REPORTS_DIR = join(PKG_ROOT, 'eval', 'reports')

function arg(name: string): string | undefined {
  return process.argv.find((a) => a.startsWith(`--${name}=`))?.split('=').slice(1).join('=')
}

/** Alias → concrete id, matching CLAUDE.md's documented model ids. Passthrough for a full id. */
const MODEL_IDS: Record<string, string> = {
  sonnet: 'claude-sonnet-5',
  opus: 'claude-opus-5',
  haiku: 'claude-haiku-4-5-20251001',
  fable: 'claude-fable-5-1',
}
const canonicalModelId = (alias: string): string => MODEL_IDS[alias] ?? alias

async function main(): Promise<void> {
  const taskFilter = arg('tasks')?.split(',').map((s) => s.trim())
  const armFilter = arg('arms')?.split(',').map((s) => s.trim())
  const sliceFilter = arg('slice')?.split(',').map((s) => s.trim())
  const excludeSliceFilter = arg('exclude-slice')?.split(',').map((s) => s.trim())
  const gatePath = arg('gate')
  // Plan A1 — pin the model, on the record. Default sonnet for both the arms and the judge.
  const modelAlias = arg('model') ?? 'sonnet'
  const judgeModelAlias = arg('judge-model') ?? 'sonnet'
  const transcriptDir = arg('transcripts')
  const seedTagArg = arg('seed-tag')

  if (sliceFilter && excludeSliceFilter) {
    console.error('--slice and --exclude-slice are mutually exclusive')
    process.exit(2)
  }

  let tasks = loadCorpus()
  if (taskFilter) tasks = tasks.filter((t) => taskFilter.includes(t.id))
  // --slice=supervisor_pivot,... — the trajectory-supervisor S7 slice (see eval/corpus/schema.ts).
  if (sliceFilter) tasks = tasks.filter((t) => t.slice !== undefined && sliceFilter.includes(t.slice))
  // --exclude-slice=... — the whole corpus except these slices. For harness-vs-bare / one-loop,
  // which want the full corpus minus the supervisor-specific stress fixtures. An untagged task
  // (t.slice === undefined) is always kept.
  if (excludeSliceFilter) tasks = tasks.filter((t) => t.slice === undefined || !excludeSliceFilter.includes(t.slice))
  if (tasks.length === 0) {
    console.error('no tasks matched')
    process.exit(2)
  }

  // --arms selects from the full set (including declared-not-default arms like `supervisorOn`);
  // the default run is IMPLEMENTED_ARMS only.
  let arms: Arm[] = IMPLEMENTED_ARMS
  if (armFilter) arms = ALL_ARMS.filter((a) => armFilter.includes(a.name))

  // LLM-as-judge: on by default for a real run, `--no-judge` opts out. Tool-free ClaudeCliLLMClient
  // (no API key). A judge error / unparseable verdict resolves to `false` inside judge(), never a throw.
  const judgeClient = new ClaudeCliLLMClient({ model: judgeModelAlias })
  const judge = process.argv.includes('--no-judge') ? undefined : new ClaudeCliJudge(judgeClient)

  // --seeds=N — the S7 decision is LLM-driven, so a single pass is not evidence. claude-cli
  // has no seed parameter; "seed" here means an independent repeated run of the whole matrix.
  const seeds = Math.max(1, Number.parseInt(arg('seeds') ?? '1', 10) || 1)

  console.log(
    `Running ${arms.map((a) => a.name).join(', ')} over ${tasks.length} task(s) via claude-cli` +
      ` (model: ${modelAlias}, judge: ${judge ? judgeModelAlias : 'disabled'}` +
      `${transcriptDir ? `, transcripts → ${transcriptDir}` : ''}${seeds > 1 ? `, seeds: ${seeds}` : ''})...\n`,
  )

  mkdirSync(REPORTS_DIR, { recursive: true })

  // The most recently built per-task client — used after a run to read back the resolved model id.
  let lastArmClient: ClaudeCliLLMClient | undefined

  const runOnce = (seedTag: string | number) =>
    runBenchmark({
      tasks,
      arms,
      judge,
      transcriptDir,
      seedTag,
      modelId: canonicalModelId(modelAlias),
      judgeModelId: judge ? canonicalModelId(judgeModelAlias) : null,
      // The claude-cli backend resolves tool calls out of process via its own MCP server, which
      // needs the workspace path up front — so build one client per task, wiring the file/shell MCP
      // tools only when the task declares them. Every client is pinned to `--model` (Plan A1).
      makeLlm: ({ workspaceRoot, task }) => {
        lastArmClient = new ClaudeCliLLMClient({
          model: modelAlias,
          fileTools: task.tools.file ? { workspaceRoot } : undefined,
          shellTools: task.tools.shell ? { workspaceRoot } : undefined,
        })
        return lastArmClient
      },
      onProgress: ({ arm, taskId, success, skipped }) => {
        console.log(`  ${skipped ? 'SKIP' : success ? 'PASS' : 'FAIL'}  ${arm} · ${taskId}`)
      },
    })

  const seedReports: BenchmarkReport[] = []
  for (let s = 0; s < seeds; s++) {
    if (seeds > 1) console.log(`\n── seed ${s + 1}/${seeds} ──`)
    const seedTag = seedTagArg ?? (seeds > 1 ? s + 1 : 1)
    const r = await runOnce(seedTag)
    // Prefer the model id the CLI actually reported; fall back to the canonical alias mapping.
    r.modelId = lastArmClient?.resolvedModelId ?? canonicalModelId(modelAlias)
    r.judgeModelId = judge ? (judgeClient.resolvedModelId ?? canonicalModelId(judgeModelAlias)) : null

    // F6 — a run whose resolved model isn't the one asked for is not the run the report claims.
    // Abort rather than publish a mislabelled number. `--allow-model-mismatch` overrides (e.g. a
    // CLI whose modelUsage shape this doesn't recognise).
    const wantId = canonicalModelId(modelAlias)
    const gotId = lastArmClient?.resolvedModelId
    if (gotId && gotId !== wantId && !gotId.startsWith(modelAlias) && !process.argv.includes('--allow-model-mismatch')) {
      console.error(
        `model mismatch: asked for --model=${modelAlias} (${wantId}) but the arm resolved to "${gotId}". ` +
          `Aborting — pass --allow-model-mismatch to override.`,
      )
      process.exit(3)
    }
    seedReports.push(r)
    if (seeds > 1) {
      writeFileSync(join(REPORTS_DIR, `${r.generatedAt.replace(/[:.]/g, '-')}.seed${s + 1}.json`), JSON.stringify(r, null, 2))
    }
  }
  const report = seedReports[seedReports.length - 1]

  // ── multi-seed summary + Rule 6 delta between the two arms ─────────────────
  if (seeds > 1) {
    const armNames = arms.map((a) => a.name)
    const perArmSeedAgg = Object.fromEntries(armNames.map((n) => [n, aggregateSeeds(seedReports, n)]))
    const stamp = report.generatedAt.replace(/[:.]/g, '-')
    let seedDiffMd = ''
    if (armNames.length === 2) {
      const seedDiff = diffSeeds(perArmSeedAgg[armNames[0]], perArmSeedAgg[armNames[1]])
      seedDiffMd = renderSeedDiff(seedDiff)
      console.log(`\n${seedDiffMd}\n`)
    }
    const multiPath = join(REPORTS_DIR, `${stamp}.multiseed.json`)
    writeFileSync(multiPath, JSON.stringify({ seeds, arms: armNames, perArm: perArmSeedAgg, seedReports: seedReports.map((r) => r.generatedAt) }, null, 2))
    console.log(`multi-seed summary → ${multiPath}`)
  }

  // ── write the machine report ──────────────────────────────────────────────
  const stamp = report.generatedAt.replace(/[:.]/g, '-')
  const jsonPath = join(REPORTS_DIR, `${stamp}.json`)
  writeFileSync(jsonPath, JSON.stringify(report, null, 2))

  // ── prepend the human table ───────────────────────────────────────────────
  const section = renderMarkdown(report)
  const HEADER = '# Comparative Harness Benchmark\n\nPlan Phase B — arm-vs-arm task benchmark. Newest run first. Generated by `scripts/run-harness-benchmark.ts`.\n'
  const priorRuns = existsSync(REPORT_MD)
    ? readFileSync(REPORT_MD, 'utf8').replace(/^# Comparative Harness Benchmark[\s\S]*?run-harness-benchmark\.ts`\.\n/, '').trimStart()
    : ''
  writeFileSync(REPORT_MD, `${HEADER}\n${section}\n---\n\n${priorRuns}`)

  console.log(`\n${section}\n`)
  console.log(`machine report → ${jsonPath}`)
  console.log(`human report   → ${REPORT_MD}`)

  // ── Rule 6 gate ───────────────────────────────────────────────────────────
  if (gatePath) {
    const beforePath = resolve(PKG_ROOT, gatePath)
    const before = JSON.parse(readFileSync(beforePath, 'utf8')) as BenchmarkReport
    const diff = diffReports(before, report, arg('gate-arm') ?? 'flagOn')
    console.log(`\n${renderDiff(diff)}\n`)
    if (diff.regressed) {
      console.error('Rule 6: flag may NOT default on — gating regression above.')
      process.exit(1)
    }
  }

  // A run where an implemented arm errored on every task is itself a failure.
  const anyArmAllErrors = Object.values(report.perArm).some((a) => a.tasksRun === 0 && a.tasksSkipped === tasks.length && a.arm !== 'bare' && a.arm !== 'langgraph')
  if (anyArmAllErrors) {
    console.error('an implemented arm ran zero tasks')
    process.exit(1)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
