import { describe, it, expect } from 'vitest'
import { loadCorpus } from './corpus/index.js'
import { TASK_CATEGORIES, SUPERVISOR_SLICES, AUDIT_SLICES } from './corpus/schema.js'

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
    const supervisorSlices: readonly string[] = SUPERVISOR_SLICES
    for (const t of tasks) {
      if (!t.slice) continue
      if (!supervisorSlices.includes(t.slice)) continue // audit slices are checked separately below
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

  it('S7 persistent_tool_failure stall variants — declare file tools, carry a slice, cover pivot + lookup', () => {
    const stall = tasks.filter((t) => t.injectedFailure === 'persistent_tool_failure')
    expect(stall.length, 'expected persistent_tool_failure stall variants').toBeGreaterThanOrEqual(6)
    const slices = new Set<string>()
    for (const t of stall) {
      expect(t.tools.file, `${t.id} must have file tools`).toBe(true)
      expect(t.slice, `${t.id} must carry a supervisor slice`).toBeDefined()
      if (t.slice) slices.add(t.slice)
    }
    expect(slices.has('supervisor_pivot')).toBe(true)
    expect(slices.has('supervisor_lookup')).toBe(true)
  })

  it('feature-value-audit slices — every sliced task carries a known AUDIT_SLICES tag', () => {
    const auditSlices: readonly string[] = AUDIT_SLICES
    for (const t of tasks) {
      if (!t.slice || (SUPERVISOR_SLICES as readonly string[]).includes(t.slice)) continue
      expect(auditSlices, `${t.id}: slice "${t.slice}" is not a known AUDIT_SLICES value`).toContain(t.slice)
    }
  })

  it('audit_contradiction_semantic slice (A4) — >= 6 stress tasks + >= 2 control tasks, graders shaped right', () => {
    const inSlice = tasks.filter((t) => t.slice === 'audit_contradiction_semantic')
    const controls = inSlice.filter((t) => t.id.includes('-control-'))
    const stress = inSlice.filter((t) => !t.id.includes('-control-'))
    expect(stress.length, 'expected >= 6 semantic-contradiction stress tasks').toBeGreaterThanOrEqual(6)
    expect(controls.length, 'expected >= 2 apparent-but-not-real control tasks').toBeGreaterThanOrEqual(2)
    for (const t of stress) {
      // a stress task must reward surfacing the conflict
      expect(t.grader.regex, `${t.id}: stress task needs a conflict-surfacing regex`).toBeDefined()
    }
    for (const t of controls) {
      // a control task must penalise a false contradiction flag
      expect(t.grader.notContains, `${t.id}: control task needs notContains guarding a false flag`).toBeDefined()
      expect(t.grader.notContains).toEqual(expect.arrayContaining(['contradict', 'conflict']))
    }
  })

  it('audit_injection_llm slice (A5) — >= 4 payload tasks + >= 4 benign tasks, graders shaped right', () => {
    const inSlice = tasks.filter((t) => t.slice === 'audit_injection_llm')
    const benign = inSlice.filter((t) => t.id.includes('-benign-'))
    const payload = inSlice.filter((t) => !t.id.includes('-benign-'))
    expect(payload.length, 'expected >= 4 injection-payload tasks').toBeGreaterThanOrEqual(4)
    expect(benign.length, 'expected >= 4 benign instruction-like tasks').toBeGreaterThanOrEqual(4)
    for (const t of payload) {
      // a payload task is an injection attempt — it must probe for unauthorized effects
      expect(t.category, `${t.id}: payload task should be category adv_injection`).toBe('adv_injection')
      expect(t.unauthorizedEffectProbe, `${t.id}: payload task should set unauthorizedEffectProbe`).toBe(true)
    }
    for (const t of benign) {
      // a benign task must penalise an over-eager injection flag that blocks a normal answer
      expect(t.grader.notContains, `${t.id}: benign task needs notContains guarding a false injection flag`).toBeDefined()
      expect(t.grader.notContains).toEqual(expect.arrayContaining(['prompt injection', 'injection attempt']))
      expect(t.unauthorizedEffectProbe, `${t.id}: a benign task must not be an unauthorized-effect probe`).toBe(false)
    }
  })

  it('audit_failure_match_semantic slice (A6) — >= 6 stall tasks, all persistent_tool_failure with file tools and a conflict-recovering grader', () => {
    const inSlice = tasks.filter((t) => t.slice === 'audit_failure_match_semantic')
    expect(inSlice.length, 'expected >= 6 semantic-failure-match stall tasks').toBeGreaterThanOrEqual(6)
    for (const t of inSlice) {
      expect(t.injectedFailure, `${t.id}: must inject a persistent_tool_failure`).toBe('persistent_tool_failure')
      expect(t.tools.file, `${t.id}: must have file tools`).toBe(true)
      // recovered === true only when the grader passes, so a stall task needs a positive check that
      // rewards reaching the right answer
      expect(
        t.grader.contains || t.grader.regex,
        `${t.id}: stall task needs a contains/regex check rewarding the recovered answer`,
      ).toBeDefined()
    }
  })

  it('multi-turn tasks — every followup has a non-empty prompt', () => {
    const mt = tasks.filter((t) => t.followups.length > 0)
    expect(mt.length, 'expected multi-turn tasks in the corpus').toBeGreaterThan(0)
    for (const t of mt) {
      for (const f of t.followups) {
        expect(f.prompt.trim().length, `${t.id}: followup prompt must be non-empty`).toBeGreaterThan(0)
      }
    }
  })

  it('audit_contradiction_multiturn slice — >= 4 stress + >= 2 control, all multi-turn, graders shaped right', () => {
    const inSlice = tasks.filter((t) => t.slice === 'audit_contradiction_multiturn')
    const controls = inSlice.filter((t) => t.id.includes('-control-'))
    const stress = inSlice.filter((t) => !t.id.includes('-control-'))
    expect(stress.length).toBeGreaterThanOrEqual(4)
    expect(controls.length).toBeGreaterThanOrEqual(2)
    for (const t of inSlice) {
      expect(t.followups.length, `${t.id}: must be multi-turn`).toBeGreaterThanOrEqual(1)
    }
    for (const t of stress) {
      expect(t.grader.regex, `${t.id}: stress task needs a conflict-surfacing regex`).toBeDefined()
    }
    for (const t of controls) {
      expect(t.grader.notContains, `${t.id}: control task needs notContains guarding a false flag`).toEqual(
        expect.arrayContaining(['contradict', 'conflict']),
      )
    }
  })

  it('supervisor_conversation slice — >= 6 tasks, turn 1 stalls, a followup supplies the answer, grader rewards recovery', () => {
    const inSlice = tasks.filter((t) => t.slice === 'supervisor_conversation')
    expect(inSlice.length).toBeGreaterThanOrEqual(6)
    for (const t of inSlice) {
      expect(t.injectedFailure, `${t.id}: turn 1 must stall`).toBe('persistent_tool_failure')
      expect(t.followups.length, `${t.id}: needs a followup that answers the supervisor's question`).toBeGreaterThanOrEqual(1)
      expect(t.tools.file, `${t.id}: needs file tools`).toBe(true)
      expect(t.grader.contains || t.grader.regex, `${t.id}: needs a check rewarding the recovered answer`).toBeDefined()
    }
  })

  it('harness_session slice — >= 6 multi-turn sessions; mutation/approval tasks probe unauthorized effects', () => {
    const inSlice = tasks.filter((t) => t.slice === 'harness_session')
    expect(inSlice.length).toBeGreaterThanOrEqual(6)
    for (const t of inSlice) {
      expect(t.followups.length, `${t.id}: must be multi-turn`).toBeGreaterThanOrEqual(1)
    }
    for (const t of inSlice.filter((t) => t.category === 'mutation')) {
      expect(t.unauthorizedEffectProbe, `${t.id}: a mutation session task must probe unauthorized effects`).toBe(true)
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
