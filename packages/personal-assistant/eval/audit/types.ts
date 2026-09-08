/**
 * Feature Value Audit — manifest + progress schema.
 *
 * The audit (plans/feature_value_audit.html) tests, one reasoning feature at a time, whether that
 * feature earns its per-turn LLM / latency cost: state the hypothesis, build an arm that toggles
 * exactly it, stress it with a corpus slice, measure 3-seed, decide KEEP / CUT / INCONCLUSIVE.
 *
 * This module is the machine-readable queue that `~/clam/feature_audit_driver.py` works through —
 * one `(feature, seed)` cell per scheduler wakeup — plus the pure functions that pick the next
 * cell (`select.ts`) and fold a feature's seed reports into a verdict (`aggregate.ts`).
 *
 * Test/tooling only — nothing under `eval/audit/` is imported by product code.
 * See plans/feature_audit_automation_plan.html (phase A0) and eval/audit/README.md.
 */
import { z } from 'zod'
import type { ArmName } from '../arms.js'

/** Arm-pair convention: `[control, candidate]`. `candidate` is the arm whose feature we are
 * pricing — the one that is *present* / *on*. This matches `report.ts`'s `diffSeeds(a, b)` where
 * `b` is the candidate, so `aggregate.ts` can hand the pair straight through. Examples:
 *   trajectory-supervisor → ["flagOn", "supervisorOn"]   (supervisor present = candidate)
 *   harness-vs-bare       → ["bare", "flagOn"]            (the 11-layer harness = candidate)
 *   one-loop              → ["baseline", "flagOn"]        (in-loop proposer = candidate)
 *   semantic-contradiction→ ["contradictionOff", "flagOn"](the LLM contradiction call = candidate)
 */
export const AuditVerdictSchema = z.enum(['KEEP', 'CUT', 'INCONCLUSIVE'])
export type AuditVerdict = z.infer<typeof AuditVerdictSchema>

export const AuditFeatureStatusSchema = z.enum(['queued', 'running', 'done', 'needs_manual_review'])
export type AuditFeatureStatus = z.infer<typeof AuditFeatureStatusSchema>

export const AuditFeatureSchema = z.object({
  /** Kebab-case. Also the `eval/reports/audit/<id>/` subdirectory and the pages-repo section slug. */
  id: z.string().regex(/^[a-z0-9-]+$/),
  /** Human title for the registry row / transcript index heading. */
  title: z.string().min(1),
  /** One sentence — the belief the feature encodes, the thing that must be true for it to be worth the cost. */
  hypothesis: z.string().min(1),
  /** `[control, candidate]` — see the convention note above. Both must exist in `ALL_ARMS`. */
  arms: z.tuple([z.string(), z.string()]),
  /** Corpus `slice` tag to filter to, or `null` for the full corpus. */
  slice: z.string().nullable(),
  /** Optional extra `--tasks=` filter (comma-separated ids), applied on top of `slice`. */
  corpusFilter: z.string().optional(),
  /** Independent repeats of the whole matrix. 3 is the floor — one LLM-driven pass is not evidence. */
  seeds: z.number().int().min(1).max(10).default(3),
  /** Which runs get a dedicated transcript page. `'all'` for sliced (small) features; `'adv,injected'`
   * for full-corpus features where a page per run is ~260 files. Default depends on `slice`. */
  fullPages: z.enum(['all', 'adv,injected']).optional(),
  /** Per-feature real-dollar ceiling; the driver stops the feature and marks it needs_manual_review
   * if `policy.record_spend` accounting crosses it. Omit for no ceiling. */
  maxSpendUsd: z.number().positive().optional(),
  status: AuditFeatureStatusSchema.default('queued'),
  /** Set by the finalize step. */
  verdict: AuditVerdictSchema.optional(),
})
export type AuditFeature = z.infer<typeof AuditFeatureSchema>

export const AuditManifestSchema = z.object({
  features: z.array(AuditFeatureSchema),
})
export type AuditManifest = z.infer<typeof AuditManifestSchema>

/** Per-feature runtime state, persisted to `eval/reports/audit/progress.json` by the driver —
 * NOT in the manifest (the manifest is the plan; this is how far we got). */
export const AuditFeatureProgressSchema = z.object({
  seedsDone: z.number().int().min(0).default(0),
  finalized: z.boolean().default(false),
  /** Accumulated real spend across this feature's seed runs, for `maxSpendUsd`. */
  spendUsd: z.number().min(0).default(0),
  /** Set when a seed run hard-failed; the driver halts rather than retiring. */
  blocked: z.boolean().default(false),
  note: z.string().optional(),
})
export type AuditFeatureProgress = z.infer<typeof AuditFeatureProgressSchema>

export const AuditProgressSchema = z.object({
  /** Keyed by feature id. A missing key means "not started". */
  features: z.record(z.string(), AuditFeatureProgressSchema).default({}),
})
export type AuditProgress = z.infer<typeof AuditProgressSchema>

/** What the driver should do this invocation. */
export type AuditCell =
  | { kind: 'seed'; feature: string; arms: [string, string]; slice: string | null; seed: number; totalSeeds: number }
  | { kind: 'finalize'; feature: string; arms: [string, string]; slice: string | null; seeds: number }

export function parseManifest(raw: unknown): AuditManifest {
  return AuditManifestSchema.parse(raw)
}

export function parseProgress(raw: unknown): AuditProgress {
  return AuditProgressSchema.parse(raw ?? { features: {} })
}

/** Both arms of every feature must be real arm names. Called by `corpus.test.ts` / a check script. */
export function validateManifestArms(manifest: AuditManifest, knownArms: readonly string[]): string[] {
  const errs: string[] = []
  const known = new Set<string>(knownArms)
  for (const f of manifest.features) {
    for (const a of f.arms) {
      if (!known.has(a)) errs.push(`feature "${f.id}": unknown arm "${a}"`)
    }
    if (f.arms[0] === f.arms[1]) errs.push(`feature "${f.id}": control and candidate arms are identical ("${f.arms[0]}")`)
  }
  return errs
}

export type { ArmName }
