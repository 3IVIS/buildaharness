import { describe, it, expect, vi } from 'vitest'
import { InMemoryExperienceStore, UnavailableExperienceStore, EXPERIENCE_STORE_SCHEMA_VERSION, type ExperienceStoreData } from './experience-store.js'

describe('ExperienceStoreData schema versioning', () => {
  it('toJSON stamps the current schemaVersion', () => {
    const store = new InMemoryExperienceStore()
    expect(store.toJSON().schemaVersion).toBe(EXPERIENCE_STORE_SCHEMA_VERSION)
    expect(new UnavailableExperienceStore().toJSON().schemaVersion).toBe(EXPERIENCE_STORE_SCHEMA_VERSION)
  })

  it('round-trips through toJSON/fromJSON unchanged', () => {
    const store = new InMemoryExperienceStore()
    store.setStrategyWeight('DIRECT_EDIT:timeout', 0.5)
    store.setClassPrior('timeout', 0.2)
    store.addDecomposition({ task_type: 'refactor', decomposition: ['plan'], success_rate: 0.9 })
    store.addToolWorkflow({ tool_id: 'search', workflow_steps: ['query'], success_rate: 0.8 })
    store.addVerificationPlan({ task_type: 'refactor', layers: ['syntax'], success_rate: 0.95 })
    store.addRecoverySequence({ failure_class: 'timeout', strategy_sequence: ['retry'], success_rate: 0.6 })

    const restored = InMemoryExperienceStore.fromJSON(store.toJSON())
    expect(restored.toJSON()).toEqual(store.toJSON())
  })

  it('fromJSON never throws on a legacy pre-versioning blob (no schemaVersion field)', () => {
    const legacy = {
      strategy_weights: { 'a:b': 0.3 },
      class_priors: { timeout: 0.1 },
      decompositions: [],
      tool_workflows: [],
      verification_plans: [],
      recovery_sequences: [],
      // schemaVersion intentionally absent — this is exactly what every snapshot written
      // before this field existed looks like.
    } as ExperienceStoreData
    const restored = InMemoryExperienceStore.fromJSON(legacy)
    expect(restored.getStrategyWeights()).toEqual({ 'a:b': 0.3 })
    expect(restored.getClassPriors()).toEqual({ timeout: 0.1 })
  })

  it('fromJSON never throws on a partially-shaped blob — missing arrays default to empty, not undefined', () => {
    const partial = { strategy_weights: { x: 1 } } as unknown as ExperienceStoreData
    expect(() => InMemoryExperienceStore.fromJSON(partial)).not.toThrow()
    const restored = InMemoryExperienceStore.fromJSON(partial)
    expect(restored.getDecompositions()).toEqual([])
    expect(restored.getToolWorkflows()).toEqual([])
    expect(restored.getStrategyWeights()).toEqual({ x: 1 })
  })

  it('fromJSON degrades to a fresh empty store (never throws) on null/undefined input', () => {
    expect(InMemoryExperienceStore.fromJSON(null as unknown as ExperienceStoreData).toJSON().decompositions).toEqual([])
    expect(InMemoryExperienceStore.fromJSON(undefined as unknown as ExperienceStoreData).toJSON().decompositions).toEqual([])
  })

  it('fromJSON degrades to a fresh store and warns on a schemaVersion newer than this build understands', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const fromTheFuture: ExperienceStoreData = {
      strategy_weights: { 'a:b': 0.9 },
      class_priors: {},
      decompositions: [],
      tool_workflows: [],
      verification_plans: [],
      recovery_sequences: [],
      schemaVersion: EXPERIENCE_STORE_SCHEMA_VERSION + 1,
    }
    const restored = InMemoryExperienceStore.fromJSON(fromTheFuture)
    expect(restored.getStrategyWeights()).toEqual({})
    expect(warn).toHaveBeenCalledOnce()
    warn.mockRestore()
  })
})
