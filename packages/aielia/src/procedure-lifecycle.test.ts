import { describe, it, expect } from 'vitest'
import {
  DEFAULT_LIFECYCLE_CONFIG, addDraft, applyCuratorOp, curateDrafts, driftFlags, emptyLifecycleState, loadedProcedures,
  promotableDrafts, recordCarryEvent, recordRound, retireItems,
  type CuratorOp, type LifecycleConfig, type ProcedureCurator, type ProcedureLifecycleState,
} from './procedure-lifecycle.js'

const mk = (id: string, cls = 'decomposition') => ({
  id, procedureClass: cls, evidenceStatus: 'provisional', description: `Procedure ${id}.`,
  whenToUse: { taskClass: 'multi_step_plan', condition: 'Several asks.' },
  preconditions: [], checks: [], verification: 'All asks covered.', steps: ['do it'],
})
const cfg: LifecycleConfig = { ...DEFAULT_LIFECYCLE_CONFIG, minSupport: 2, capPerClass: 2 }
const scripted = (ops: CuratorOp[]): ProcedureCurator & { calls: number } => {
  const c = { calls: 0, async decide() { return ops[c.calls++] ?? { verb: 'SKIP' as const } } }
  return c
}
function withDraft(state: ProcedureLifecycleState, id: string, sources: string[], cls?: string): ProcedureLifecycleState {
  let s = state
  for (const src of sources) s = addDraft(s, mk(id, cls), src).state
  return s
}
async function accept(state: ProcedureLifecycleState, id: string): Promise<ProcedureLifecycleState> {
  return (await curateDrafts(withDraft(state, id, ['a', 'b']), scripted([{ verb: 'ACCEPT' }]), cfg)).state
}

describe('procedure lifecycle', () => {
  it('keeps drafts out of the loaded library', () => {
    const s = withDraft(emptyLifecycleState(), 'p1', ['a'])
    expect(s.drafts).toHaveLength(1)
    expect(loadedProcedures(s)).toEqual([])
  })

  it('rejects an invalid draft and counts a repeat source once', () => {
    expect(addDraft(emptyLifecycleState(), { id: 'x' }, 'a').ok).toBe(false)
    const s = withDraft(emptyLifecycleState(), 'p1', ['a', 'a'])
    expect(s.drafts[0].supporters).toEqual(['a'])
  })

  it('offers a draft to the curator only at the support threshold', async () => {
    const s = withDraft(emptyLifecycleState(), 'p1', ['a'])
    const c = scripted([{ verb: 'ACCEPT' }])
    expect(promotableDrafts(s, cfg)).toHaveLength(0)
    const r = await curateDrafts(s, c, cfg)
    expect(c.calls).toBe(0)
    expect(r.state.library).toEqual([])
    const s2 = withDraft(s, 'p1', ['b'])
    const r2 = await curateDrafts(s2, c, cfg)
    expect(c.calls).toBe(1)
    expect(r2.state.library.map(e => e.id)).toEqual(['p1'])
    expect(r2.state.drafts).toEqual([])
  })

  it('SKIP drops the draft without adding it', async () => {
    const r = await curateDrafts(withDraft(emptyLifecycleState(), 'p1', ['a', 'b']), scripted([{ verb: 'SKIP' }]), cfg)
    expect(r.state.library).toEqual([])
    expect(r.state.drafts).toEqual([])
  })

  it('REPLACE swaps the target and resets its stats', async () => {
    let s = await accept(emptyLifecycleState(), 'p1')
    s = recordCarryEvent(s, 'p1', 'against')
    const r = await curateDrafts(withDraft(s, 'p2', ['a', 'b']), scripted([{ verb: 'REPLACE', targetId: 'p1' }]), cfg)
    expect(r.state.library.map(e => e.id)).toEqual(['p2'])
    expect(r.state.stats.p1).toBeUndefined()
    expect(r.state.stats.p2.against).toBe(0)
  })

  it('MERGE writes the validated merged entry and keeps votes; an invalid merge is refused', async () => {
    let s = await accept(emptyLifecycleState(), 'p1')
    s = recordCarryEvent(s, 'p1', 'support')
    const draft = withDraft(s, 'p2', ['a', 'b']).drafts[0]
    const bad = applyCuratorOp(s, draft, { verb: 'MERGE', targetId: 'p1', merged: { id: 'm' } }, cfg)
    expect(bad.applied).toBe(false)
    const ok = applyCuratorOp(s, draft, { verb: 'MERGE', targetId: 'p1', merged: { ...mk('p1'), description: 'Merged.' } }, cfg)
    expect(ok.applied).toBe(true)
    expect(ok.state.library[0].description).toBe('Merged.')
    expect(ok.state.stats.p1.support).toBe(1)
  })

  it('PRUNE removes the target and keeps the draft for a following ACCEPT', async () => {
    let s = await accept(await accept(emptyLifecycleState(), 'p1'), 'p2')
    const draft = withDraft(s, 'p3', ['a', 'b']).drafts[0]
    const s3 = withDraft(s, 'p3', ['a', 'b'])
    const r = await curateDrafts(s3, scripted([{ verb: 'PRUNE', targetId: 'p1' }]), cfg)
    expect(r.state.library.map(e => e.id)).toEqual(['p2'])
    expect(r.state.drafts).toHaveLength(1)
    expect(applyCuratorOp(r.state, draft, { verb: 'ACCEPT' }, cfg).applied).toBe(true)
  })

  it('refuses a bare ACCEPT when the class is full, allows a refinement, and counts classes separately', async () => {
    const s = await accept(await accept(emptyLifecycleState(), 'p1'), 'p2')
    const full = await curateDrafts(withDraft(s, 'p3', ['a', 'b']), scripted([{ verb: 'ACCEPT' }]), cfg)
    expect(full.log[0].applied).toBe(false)
    expect(full.state.library).toHaveLength(2)
    const refine = await curateDrafts(withDraft(s, 'p3', ['a', 'b']), scripted([{ verb: 'REPLACE', targetId: 'p1' }]), cfg)
    expect(refine.state.library.map(e => e.id).sort()).toEqual(['p2', 'p3'])
    const other = await curateDrafts(withDraft(s, 'w1', ['a', 'b'], 'tool_workflow'), scripted([{ verb: 'ACCEPT' }]), cfg)
    expect(other.state.library).toHaveLength(3)
  })

  it('refuses unknown targets and cross-class replacement', async () => {
    const s = await accept(emptyLifecycleState(), 'p1')
    const d = withDraft(s, 'w1', ['a', 'b'], 'tool_workflow').drafts[0]
    expect(applyCuratorOp(s, d, { verb: 'REPLACE', targetId: 'nope' }, cfg).applied).toBe(false)
    expect(applyCuratorOp(s, d, { verb: 'REPLACE', targetId: 'p1' }, cfg).applied).toBe(false)
  })

  it('blocks retirement below the judge reliability threshold and retires at or above it', async () => {
    let s = await accept(emptyLifecycleState(), 'p1')
    for (let i = 0; i < 3; i++) s = recordCarryEvent(s, 'p1', 'against')
    const low = retireItems(s, 0.5, cfg)
    expect(low.retired).toEqual([])
    expect(low.state.library).toHaveLength(1)
    const ok = retireItems(s, 0.9, cfg)
    expect(ok.retired).toEqual(['p1'])
    expect(ok.state.library).toEqual([])
    expect(retireItems(s, Number.NaN, cfg).retired).toEqual([])
  })

  it('support votes offset votes against', async () => {
    let s = await accept(emptyLifecycleState(), 'p1')
    for (let i = 0; i < 3; i++) s = recordCarryEvent(s, 'p1', 'against')
    s = recordCarryEvent(s, 'p1', 'support')
    expect(retireItems(s, 1, cfg).retired).toEqual([])
  })

  it('flags drift for items idle too long, and clears it when the item is used', async () => {
    let s = await accept(await accept(emptyLifecycleState(), 'p1'), 'p2')
    const c = { ...cfg, driftRounds: 3 }
    for (let i = 0; i < 3; i++) s = recordRound(s, ['p2'])
    expect(driftFlags(s, c)).toEqual(['p1'])
    s = recordRound(s, ['p1'])
    expect(driftFlags(s, c)).toEqual([])
    expect(s.library).toHaveLength(2)
  })
})
