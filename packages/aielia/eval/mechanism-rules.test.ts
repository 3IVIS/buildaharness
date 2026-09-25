// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { loadCorpus } from './corpus/index.js'
import { AUDIT_SLICES, TaskSpecSchema, type TaskSpec } from './corpus/schema.js'
import { MECHANISMS, MECHANISM_IDS, AUDIT_SLICE_MECHANISM } from './corpus/mechanisms.js'
import {
  checkCorpusMechanisms,
  checkMechanismTasks,
  mechanismOf,
  nearDuplicatePrompts,
  MIN_CALM_CONTROLS,
  MIN_FAMILIES,
  MIN_STRESS_PER_FAMILY,
} from './corpus/mechanism-rules.js'

const NOTE = 'Must surface the conflict and must not silently pick one of the two sources.'
const WORDS = ['alpha', 'bravo', 'charlie', 'delta', 'echo', 'foxtrot', 'golf', 'hotel', 'india', 'juliet', 'kilo', 'lima', 'mike', 'november', 'oscar', 'papa', 'quebec', 'romeo', 'sierra', 'tango']

let n = 0
function task(role: 'stress' | 'calm-control', family: string, over: Partial<TaskSpec> = {}): TaskSpec {
  n++
  const prompt = [n, n * 7, n * 3 + 1, n * 11, n * 13, n * 17].map((k) => `${WORDS[k % 20]}${WORDS[Math.floor(k / 20) % 20]}`).join(' ')
  return TaskSpecSchema.parse({
    id: `t-${n}`,
    category: 'lookup',
    intent: 'x',
    prompt,
    grader: { judge: { rubric: 'r' } },
    note: NOTE,
    mechanism: 'semantic_contradiction',
    role,
    family,
    ...over,
  })
}

function goodSet(): TaskSpec[] {
  const ts: TaskSpec[] = []
  for (const f of ['fam-a', 'fam-b', 'fam-c']) for (let i = 0; i < MIN_STRESS_PER_FAMILY; i++) ts.push(task('stress', f))
  for (let i = 0; i < MIN_CALM_CONTROLS; i++) ts.push(task('calm-control', 'calm'))
  return ts
}

describe('layer mechanism registry + docs/layer_mechanisms.md', () => {
  const doc = readFileSync(fileURLToPath(new URL('../../../docs/layer_mechanisms.md', import.meta.url)), 'utf8')
  const sections = new Map<string, string>()
  for (const part of doc.split(/^## /m).slice(1)) sections.set(part.split('\n')[0].trim(), part)

  it('ids are unique and cover every layer class', () => {
    expect(new Set(MECHANISM_IDS).size).toBe(MECHANISM_IDS.length)
    const cls = new Set(MECHANISMS.map((m) => m.cls))
    expect(cls.size).toBe(6)
  })

  it('covers the nine verification sub-layers and each non-default supervisor directive', () => {
    expect(MECHANISMS.filter((m) => m.cls === 'verification_sublayer')).toHaveLength(9)
    expect(MECHANISMS.filter((m) => m.cls === 'supervisor_directive')).toHaveLength(5)
  })

  it('every layer has a doc section with a hypothesised regime, target metric, preconditions and taxonomy', () => {
    for (const { id } of MECHANISMS) {
      const s = sections.get(id)
      expect(s, `docs/layer_mechanisms.md has no "## ${id}" section`).toBeDefined()
      for (const label of ['Hypothesised regime', 'Target metric', 'Prevents / catches', 'Preconditions to fire', 'Failure-mode taxonomy', 'Correct outcome']) {
        const m = new RegExp(`\\*\\*${label}(?: \\(scenario families\\))?:\\*\\*\\s*(\\S.{9,})`).exec(s ?? '')
        expect(m, `${id}: missing or empty "${label}"`).not.toBeNull()
      }
    }
  })

  it('the doc has no sections for unknown layers', () => {
    for (const k of sections.keys()) expect(MECHANISM_IDS as readonly string[], `unknown section ${k}`).toContain(k)
  })

  it('every AUDIT_SLICE maps to a registered mechanism', () => {
    for (const s of AUDIT_SLICES) {
      if (s === 'harness_session') continue // cross-cutting multi-turn slice, not one layer
      expect(AUDIT_SLICE_MECHANISM[s], `AUDIT_SLICES "${s}" has no mechanism`).toBeDefined()
      expect(MECHANISM_IDS as readonly string[]).toContain(AUDIT_SLICE_MECHANISM[s])
    }
  })
})

describe('TaskSpecSchema mechanism/role/family', () => {
  it('rejects an unknown mechanism, a role without a mechanism, and a mechanism without a role', () => {
    const base = { id: 'a', category: 'lookup', intent: 'x', prompt: 'p', grader: { judge: { rubric: 'r' } } }
    expect(TaskSpecSchema.safeParse({ ...base, mechanism: 'nope', role: 'stress' }).success).toBe(false)
    expect(TaskSpecSchema.safeParse({ ...base, role: 'stress' }).success).toBe(false)
    expect(TaskSpecSchema.safeParse({ ...base, mechanism: 'supervisor' }).success).toBe(false)
    expect(TaskSpecSchema.safeParse({ ...base, mechanism: 'supervisor', role: 'calm-control' }).success).toBe(true)
    expect(TaskSpecSchema.safeParse(base).success).toBe(true)
  })

  it('a slice-tagged task without an explicit mechanism resolves to its slice mechanism', () => {
    const t = TaskSpecSchema.parse({ id: 'a', category: 'lookup', intent: 'x', prompt: 'p', grader: { judge: { rubric: 'r' } }, slice: 'audit_change_review' })
    expect(mechanismOf(t)).toBe('change_review')
  })
})

describe('per-layer corpus rules (fixtures)', () => {
  it('a complete layer passes', () => {
    expect(checkMechanismTasks('semantic_contradiction', goodSet())).toEqual([])
  })

  it('fails with too few families', () => {
    const ts = goodSet().filter((t) => t.family !== 'fam-c')
    expect(checkMechanismTasks('semantic_contradiction', ts).join('\n')).toMatch(new RegExp(`>= ${MIN_FAMILIES} families`))
  })

  it('fails when a family has too few stress tasks', () => {
    const ts = goodSet()
    ts.splice(ts.findIndex((t) => t.family === 'fam-a'), 1)
    expect(checkMechanismTasks('semantic_contradiction', ts).join('\n')).toMatch(/families/)
  })

  it('fails with too few calm controls', () => {
    const ts = goodSet()
    ts.splice(ts.findIndex((t) => t.role === 'calm-control'), 1)
    expect(checkMechanismTasks('semantic_contradiction', ts).join('\n')).toMatch(/calm controls/)
  })

  it('fails on a short or missing note', () => {
    const ts = goodSet()
    ts[0] = { ...ts[0], note: 'too short' }
    ts[1] = { ...ts[1], note: undefined }
    const out = checkMechanismTasks('semantic_contradiction', ts).filter((m) => m.includes('note must be'))
    expect(out).toHaveLength(2)
  })

  it('fails on a stress task with no family', () => {
    const ts = goodSet()
    ts[0] = { ...ts[0], family: undefined }
    expect(checkMechanismTasks('semantic_contradiction', ts).join('\n')).toMatch(/no scenario family/)
  })

  it('rejects near-duplicate prompts and accepts distinct ones', () => {
    const a = task('stress', 'fam-a', { prompt: 'Compare the quarterly revenue totals in the two spreadsheets and tell me which is right' })
    const b = task('stress', 'fam-a', { prompt: 'Compare the quarterly revenue totals in the two spreadsheets and tell me which one is right' })
    const c = task('stress', 'fam-a', { prompt: 'Summarise the incident timeline from the postmortem file' })
    expect(nearDuplicatePrompts([a, b])).toHaveLength(1)
    expect(nearDuplicatePrompts([a, c])).toEqual([])
    const ts = [...goodSet(), b, a]
    expect(checkMechanismTasks('semantic_contradiction', ts).join('\n')).toMatch(/near-duplicate/)
  })

  it('checkCorpusMechanisms groups by layer and ignores untagged tasks', () => {
    const untagged = TaskSpecSchema.parse({ id: 'u', category: 'lookup', intent: 'x', prompt: 'p', grader: { judge: { rubric: 'r' } } })
    expect(checkCorpusMechanisms([untagged, ...goodSet()])).toEqual([])
    const bad = task('stress', 'fam-a', { mechanism: 'supervisor' })
    expect(checkCorpusMechanisms([bad]).join('\n')).toMatch(/^supervisor: /m)
  })
})

describe('real corpus — per-layer rules apply to every layer that declares tasks', () => {
  it('no explicitly tagged layer violates the rules (layers with no tagged tasks are built in AL1c–AL1e)', () => {
    expect(checkCorpusMechanisms(loadCorpus())).toEqual([])
  })
})
