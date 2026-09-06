import { describe, it, expect } from 'vitest'
import { loadCorpus } from './corpus/index.js'
import { TASK_CATEGORIES, SUPERVISOR_SLICES } from './corpus/schema.js'

describe('benchmark corpus', () => {
  const tasks = loadCorpus()

  it('has at least one task and every file validates against the schema', () => {
    expect(tasks.length).toBeGreaterThan(0)
    // loadCorpus() throws on a malformed file / id-filename mismatch / dup id — reaching here means clean.
  })

  it('ids are unique and kebab-case', () => {
    const ids = tasks.map((t) => t.id)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ids) expect(id).toMatch(/^[a-z0-9-]+$/)
  })

  it('covers a spread of categories (not all one bucket)', () => {
    const cats = new Set(tasks.map((t) => t.category))
    expect(cats.size).toBeGreaterThanOrEqual(5)
    for (const c of cats) expect(TASK_CATEGORIES).toContain(c)
  })

  it('every mutation / injection task probes for unauthorized effects', () => {
    for (const t of tasks) {
      if (t.category === 'mutation' || t.category === 'adv_injection') {
        expect(t.unauthorizedEffectProbe, `${t.id} should set unauthorizedEffectProbe`).toBe(true)
      }
    }
  })

  it('every task that declares filesUnchanged actually ships those files in its workspace', () => {
    for (const t of tasks) {
      const declared = new Set(t.workspace.map((f) => f.path))
      for (const p of t.grader.filesUnchanged ?? []) {
        expect(declared.has(p), `${t.id}: grader.filesUnchanged names "${p}" not in workspace`).toBe(true)
      }
    }
  })

  it('trajectory-supervisor S7 slice — every sub-slice has at least 6 tasks, adversarial-digest probes effects', () => {
    const bySlice = new Map<string, typeof tasks>()
    for (const t of tasks) {
      if (!t.slice) continue
      expect(SUPERVISOR_SLICES).toContain(t.slice)
      const arr = bySlice.get(t.slice) ?? []
      arr.push(t)
      bySlice.set(t.slice, arr)
    }
    // pivot / lookup / clarification: minimum 6 each (plan S7 scope). adversarial-digest: the S1 cases.
    for (const s of ['supervisor_pivot', 'supervisor_lookup', 'supervisor_clarification'] as const) {
      expect(bySlice.get(s)?.length ?? 0, `slice ${s} should have >= 6 tasks`).toBeGreaterThanOrEqual(6)
    }
    expect(bySlice.get('supervisor_adversarial_digest')?.length ?? 0).toBeGreaterThanOrEqual(1)
    for (const t of bySlice.get('supervisor_adversarial_digest') ?? []) {
      expect(t.unauthorizedEffectProbe, `${t.id} (adversarial digest) should probe unauthorized effects`).toBe(true)
    }
  })

  it('every task that needs tools declares them', () => {
    for (const t of tasks) {
      if (t.workspace.length > 0) {
        // a task with a workspace almost always needs file tools
        expect(t.tools.file || t.tools.shell || t.tools.web, `${t.id} has a workspace but no tools`).toBe(true)
      }
    }
  })
})
