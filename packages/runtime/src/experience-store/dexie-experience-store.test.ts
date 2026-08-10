import 'fake-indexeddb/auto'
import { describe, it, expect } from 'vitest'
import { DexieExperienceStore } from './dexie-experience-store'
import { EXPERIENCE_STORE_SCHEMA_VERSION } from '@buildaharness/harness'

describe('DexieExperienceStore', () => {
  it('available is always true', async () => {
    const store = await DexieExperienceStore.create({ namespace: 'available-test' })
    expect(store.available).toBe(true)
  })

  it('mutations are readable synchronously right away (no await needed on the mutating call)', async () => {
    const store = await DexieExperienceStore.create({ namespace: 'sync-read-test' })
    store.setStrategyWeight('DIRECT_EDIT:timeout', 0.75)
    expect(store.getStrategyWeights()['DIRECT_EDIT:timeout']).toBe(0.75)
  })

  it('a second store instance sharing a namespace loads the persisted snapshot', async () => {
    const namespace = 'cross-instance-test'
    const store1 = await DexieExperienceStore.create({ namespace })
    store1.setStrategyWeight('DIRECT_EDIT:timeout', 0.42)
    store1.addDecomposition({ task_type: 'refactor', decomposition: ['plan', 'edit', 'verify'], success_rate: 0.9 })

    // Give the background persist a tick to land before the next instance reads it.
    await new Promise(resolve => setTimeout(resolve, 20))

    const store2 = await DexieExperienceStore.create({ namespace })
    expect(store2.getStrategyWeights()['DIRECT_EDIT:timeout']).toBe(0.42)
    expect(store2.getDecompositions()).toEqual([
      { task_type: 'refactor', decomposition: ['plan', 'edit', 'verify'], success_rate: 0.9 },
    ])
  })

  it('different namespaces are isolated', async () => {
    const storeA = await DexieExperienceStore.create({ namespace: 'ns-experience-a' })
    storeA.setStrategyWeight('DIRECT_EDIT:timeout', 0.1)
    await new Promise(resolve => setTimeout(resolve, 20))

    const storeB = await DexieExperienceStore.create({ namespace: 'ns-experience-b' })
    expect(storeB.getStrategyWeights()['DIRECT_EDIT:timeout']).toBeUndefined()
  })

  it('toJSON reflects all recorded entry types', async () => {
    const store = await DexieExperienceStore.create({ namespace: 'tojson-test' })
    store.setClassPrior('timeout', 0.3)
    store.addToolWorkflow({ tool_id: 'search', workflow_steps: ['query', 'filter'], success_rate: 0.8 })
    store.addVerificationPlan({ task_type: 'refactor', layers: ['syntax', 'semantic'], success_rate: 0.95 })
    store.addRecoverySequence({ failure_class: 'timeout', strategy_sequence: ['retry', 'escalate'], success_rate: 0.6 })
    store.updateExperienceStore('run-1', { outcome: 'COMPLETE' })

    const json = store.toJSON()
    expect(json.class_priors.timeout).toBe(0.3)
    expect(json.tool_workflows).toHaveLength(1)
    expect(json.verification_plans).toHaveLength(1)
    expect(json.recovery_sequences).toHaveLength(1)
  })

  it('persisted snapshots carry the current schemaVersion', async () => {
    const store = await DexieExperienceStore.create({ namespace: 'schema-version-test' })
    store.setStrategyWeight('a:b', 0.5)
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(store.toJSON().schemaVersion).toBe(EXPERIENCE_STORE_SCHEMA_VERSION)
  })

  it('loading a pre-versioning snapshot (no schemaVersion field) degrades gracefully, not a throw', async () => {
    // Simulates a real user's on-disk snapshot written before schemaVersion existed —
    // write the row directly against the underlying Dexie table, bypassing toJSON(),
    // then confirm DexieExperienceStore.create() still comes up cleanly.
    const Dexie = (await import('dexie')).default
    const namespace = 'legacy-snapshot-test'
    const db = new Dexie(`buildaharness-experience-${namespace}`)
    db.version(1).stores({ snapshots: 'id' })
    await db.open()
    await db.table('snapshots').put({
      id: 'snapshot',
      data: { strategy_weights: { 'legacy:key': 0.7 }, class_priors: {}, decompositions: [], tool_workflows: [], verification_plans: [], recovery_sequences: [] },
    })
    db.close()

    const store = await DexieExperienceStore.create({ namespace })
    expect(store.getStrategyWeights()).toEqual({ 'legacy:key': 0.7 })
  })
})
