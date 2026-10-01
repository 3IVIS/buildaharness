// Node-level conformance runner (TS side). Reads every fixtures-nodes/*.json, runs the named harness node
// on state hydrated from TS-wire-format JSON, and prints { <fixtureId>: projection } as JSON on stdout.
// Projection = the toJSON() of every structure the node may mutate + the node's return value, floats rounded
// to 6 dp and volatile fields (wall-clock timestamps) masked. compare-nodes.mjs diffs it against run_py_nodes.py.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  WorldModel, HypothesisSet, TaskGraph, FailureDiagnostics, BeliefDepGraph, DepGraphBudget, Diagnostics,
  MemoryState, EvidenceStore, ControlState, CallerState, StrategyState, InMemoryExperienceStore,
} from '../../packages/harness/src/index.js'
import { updateDiagnostics } from '../../packages/harness/src/nodes/update-diagnostics.js'
import { estimateRisk } from '../../packages/harness/src/nodes/estimate-risk.js'
import { estimateVOI } from '../../packages/harness/src/nodes/estimate-voi.js'
import { generateUpdateHypotheses } from '../../packages/harness/src/nodes/generate-update-hypotheses.js'
import { detectContradictions } from '../../packages/harness/src/nodes/detect-contradictions.js'
import { propagateBeliefs } from '../../packages/harness/src/nodes/update-world-model.js'
import { contextCompression } from '../../packages/harness/src/nodes/context-compression.js'
import { mergeWorldModels, reconcileParallelBranches } from '../../packages/harness/src/nodes/parallel-merge.js'
import { warmStart } from '../../packages/harness/src/nodes/warm-start.js'
import { learnFromJournal } from '../../packages/harness/src/experience-learning.js'

const dir = join(dirname(fileURLToPath(import.meta.url)), 'fixtures-nodes')
const VOLATILE = new Set(['timestamp', 'recorded_at', 'last_update', 'escalated_at'])
const BELIEF_OPTIONALS = new Set(['reliability', 'supporting_evidence', 'applied_contradiction_ids', 'pending_sweep'])
const norm = (v: any): any => {
  if (typeof v === 'number') return Math.round(v * 1e6) / 1e6
  if (Array.isArray(v)) return v.map(norm)
  if (v && typeof v === 'object') {
    const o: any = {}
    // Belief optionals: TS omits them when unset, Python always emits the empty default — "unset" == default (see README).
    const isBelief = 'statement' in v && 'derived_from' in v
    for (const k of Object.keys(v).sort()) {
      if (isBelief && BELIEF_OPTIONALS.has(k) && (v[k] === undefined || v[k] === '' || v[k] === false || (Array.isArray(v[k]) && v[k].length === 0))) continue
      o[k] = VOLATILE.has(k) ? '<volatile>' : norm(v[k])
    }
    return o
  }
  return v
}
// Contradiction ids are random per run on both sides: rename them by position in worldModel.contradictions.
function canon(r: any): any {
  const list = r?.worldModel?.contradictions
  if (!Array.isArray(list)) return r
  const map = new Map<string, string>(list.map((c: any, i: number) => [c.id, `<c${i}>`]))
  const walk = (v: any): any => {
    if (typeof v === 'string') return map.get(v) ?? v
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]))
    return v
  }
  return walk(r)
}
const J = (x: any) => (x && typeof x.toJSON === 'function' ? x.toJSON() : x)

function build(s: any) {
  const m = (C: any, k: string) => (s[k] !== undefined ? C.fromJSON({ ...new C().toJSON(), ...s[k] }) : new C())
  return {
    wm: m(WorldModel, 'worldModel'), hs: m(HypothesisSet, 'hypothesisSet'), tg: m(TaskGraph, 'taskGraph'),
    fd: m(FailureDiagnostics, 'failureDiagnostics'), dg: m(BeliefDepGraph, 'depGraph'), dgb: m(DepGraphBudget, 'depGraphBudget'),
    diag: m(Diagnostics, 'diagnostics'), mem: m(MemoryState, 'memoryState'), ev: m(EvidenceStore, 'evidenceStore'),
    cs: m(ControlState, 'controlState'), cl: m(CallerState, 'callerState'), ss: m(StrategyState, 'strategyState'),
  }
}

function store(spec: any) {
  const st = new InMemoryExperienceStore()
  for (const [k, v] of Object.entries(spec?.weights ?? {})) st.setStrategyWeight(k, v as number)
  for (const [k, v] of Object.entries(spec?.priors ?? {})) st.setClassPrior(k, v as number)
  return st
}

function run(fx: any): any {
  const saved: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(fx.env ?? {})) { saved[k] = process.env[k]; process.env[k] = v as string }
  try { return runNode(fx) } finally { for (const [k, v] of Object.entries(saved)) { if (v === undefined) delete process.env[k]; else process.env[k] = v } }
}

function runNode(fx: any): any {
  const x = build(fx.state ?? {})
  const a = fx.args ?? {}
  switch (fx.node) {
    case 'update_diagnostics':
      updateDiagnostics(x.wm, x.hs, x.tg, x.fd, x.dg, x.diag, !!a.force)
      return { diagnostics: J(x.diag) }
    case 'estimate_risk':
      return { risk: estimateRisk({ metadata: {}, ...a.action }, x.tg, x.wm) }
    case 'estimate_voi': {
      const r = estimateVOI(x.diag, x.wm, x.hs, a.tools ?? {})
      return { voi: r, diagnostics: J(x.diag) }
    }
    case 'generate_update_hypotheses':
      generateUpdateHypotheses(x.wm, x.ev, x.hs, x.fd, x.mem)
      return { hypothesisSet: J(x.hs), memoryState: J(x.mem) }
    case 'detect_contradictions':
      detectContradictions(x.wm, x.ev, x.hs, null, x.dg)
      return { worldModel: J(x.wm), depGraph: J(x.dg) }
    case 'propagate_beliefs':
      propagateBeliefs(x.dg, x.dgb, x.wm)
      return { depGraph: J(x.dg) }
    case 'context_compression':
      contextCompression(x.mem, x.wm, x.dg, x.dgb, x.hs, x.tg, x.diag, x.cs, x.cl)
      return { memoryState: J(x.mem), worldModel: J(x.wm), depGraph: J(x.dg), depGraphBudget: J(x.dgb) }
    case 'merge_world_models': {
      const other = WorldModel.fromJSON({ ...new WorldModel().toJSON(), ...a.other })
      return { worldModel: J(mergeWorldModels(x.wm, other)) }
    }
    case 'reconcile_parallel_branches': {
      const branches = a.branches.map((b: any) => ({ worldModel: WorldModel.fromJSON({ ...new WorldModel().toJSON(), ...b.worldModel }), controlState: new ControlState() }))
      const r: any = reconcileParallelBranches(branches, x.tg, x.diag, x.fd, x.ev, x.hs, () => new ControlState(), a.parallelDomainPairs)
      return { worldModel: J(r.worldModel), controlState: J(r.controlState), taskGraph: J(x.tg) }
    }
    case 'warm_start': {
      warmStart(store(a.store), x.ss, x.fd, x.dgb, x.tg)
      return { strategyState: J(x.ss), failureDiagnostics: J(x.fd), depGraphBudget: J(x.dgb) }
    }
    case 'learn_from_journal': {
      const st = store(a.store)
      learnFromJournal(a.journal, st)
      return { weights: st.getStrategyWeights(), priors: st.getClassPriors() }
    }
    default: throw new Error('unknown node ' + fx.node)
  }
}

const out: Record<string, any> = {}
for (const f of readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
  const id = f.replace(/\.json$/, '')
  try { out[id] = norm(canon(run(JSON.parse(readFileSync(join(dir, f), 'utf-8'))))) } catch (e: any) { out[id] = { error: String(e?.constructor?.name ?? 'Error') } }
}
process.stdout.write(JSON.stringify(out))
