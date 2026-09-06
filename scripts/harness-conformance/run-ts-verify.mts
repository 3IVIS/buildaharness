// Loads a verify() conformance fixture and runs it through the TS harness's own
// verify() (packages/harness/src/nodes/verify.ts), printing a STATUS PROJECTION of
// the resulting VerificationResult as JSON on stdout.
//
// Invoked by compare-verify.mjs via `npx tsx run-ts-verify.mts <fixture.json>`; never
// wired into `packages/harness`'s own vitest suite, since this is a cross-language
// comparison, not a unit test of either implementation in isolation.
//
// Only the semantic fields are emitted — per-layer status, has_critical_failure,
// adversarial_passed, critical_failure_tiers. The `detail` prose is deliberately NOT
// compared: it is per-implementation human-facing text (each verify_* docstring owns its
// own wording), and the plan's scope for this pair is "each layer's PASS / FAIL / SKIPPED
// and has_critical_failure aggregation". See README.md's VERIFY-EQUIVALENCE CONTRACT.
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'
import {
  EvidenceStore,
  WorldModel,
  OutputContract,
  HypothesisSet,
  verify,
  type RiskLevel,
} from '../../packages/harness/src/index.js'

const __dirname = dirname(fileURLToPath(import.meta.url))

const fixturePath = process.argv[2]
if (!fixturePath) {
  console.error('usage: tsx run-ts-verify.mts <fixture.json>')
  process.exit(2)
}

const fx = JSON.parse(readFileSync(resolve(__dirname, fixturePath), 'utf-8'))

// The nine layer tool names, in verify()'s own order.
const ALL_LAYERS = [
  'syntax', 'unit', 'integration', 'consistency', 'requirements',
  'assumptions', 'goal_correctness', 'evidence_sufficiency', 'output_contract_partial',
] as const

// fixture.tools: { <layerToolName>: boolean }. verify() reads
// toolManifest?.tool_availability_manifest, so the manifest lives on an EvidenceStore.
const toolAvailabilityManifest: Record<string, { available: boolean; fallback_tool: string | null }> = {}
for (const [tool, available] of Object.entries(fx.tools ?? {})) {
  toolAvailabilityManifest[tool] = { available: Boolean(available), fallback_tool: null }
}
const toolManifest = new EvidenceStore({ tool_availability_manifest: toolAvailabilityManifest })

// fixture.evidence_store: null | { entries: [{ reliability }] }. verify_evidence_sufficiency
// reads evidenceStore.observations and each item's .reliability.
const evidenceStore =
  fx.evidence_store === null || fx.evidence_store === undefined
    ? null
    : new EvidenceStore({
        observations: (fx.evidence_store.entries ?? []).map((e: { reliability?: string }, i: number) => ({
          id: `e${i}`,
          obs: '',
          reliability: (e.reliability ?? 'LOW') as 'HIGH' | 'MEDIUM' | 'LOW',
          source: 'fixture',
          evidence_type: 'OBSERVATION' as const,
          freshness: '1',
        })),
      })

// fixture.world_model.contradictions: [{ severity }]. verify_consistency reads
// worldModel.contradictions and each item's .severity.
const worldModel =
  fx.world_model === null || fx.world_model === undefined
    ? null
    : new WorldModel({
        contradictions: (fx.world_model.contradictions ?? []).map((c: { severity?: string }, i: number) => ({
          id: `c${i}`,
          type: 'pairwise' as const,
          severity: (c.severity ?? 'LOW') as 'LOW' | 'MEDIUM' | 'HIGH' | 'SYSTEM_BREAKING',
          scope: 'local' as const,
          description: '',
          involved_belief_ids: [],
        })),
      })

// fixture.output_contract: null | { required_sections, ... }
const outputContract =
  fx.output_contract === null || fx.output_contract === undefined
    ? null
    : new OutputContract(fx.output_contract)

// fixture.hypothesis_set: null | { active: [{ confidence, predicted_observations }] }
const hypothesisSet =
  fx.hypothesis_set === null || fx.hypothesis_set === undefined
    ? null
    : new HypothesisSet({
        active: (fx.hypothesis_set.active ?? []).map((h: { id?: string; confidence?: number; predicted_observations?: string[] }, i: number) => ({
          id: h.id ?? `h${i}`,
          explanation: '',
          confidence: h.confidence ?? 0,
          predicted_observations: h.predicted_observations ?? [],
          discriminating_evidence: [],
          generation_sources: [],
          diversity_score: 0,
        })),
      })

const vr = verify(
  fx.result ?? null,
  fx.success_criteria ?? [],
  fx.assumptions ?? [],
  toolManifest,
  (fx.task_risk ?? 'LOW') as RiskLevel,
  evidenceStore,
  worldModel,
  outputContract,
  hypothesisSet,
  (fx.scope ?? 'local') as 'local' | 'global',
)

const layers: Record<string, string> = {}
for (const lr of vr.layer_results) layers[lr.layer] = lr.status
// Guard: every layer present exactly once, in the canonical order.
const emitted = ALL_LAYERS.map((l) => layers[l] ?? '<MISSING>')

console.log(
  JSON.stringify({
    layers: Object.fromEntries(ALL_LAYERS.map((l, i) => [l, emitted[i]])),
    has_critical_failure: vr.has_critical_failure,
    adversarial_passed: vr.adversarial_passed,
    critical_failure_tiers: [...vr.critical_failure_tiers].sort(),
  }),
)
