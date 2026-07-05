import { describe, it, expect } from 'vitest'
import { FileSystemExperienceStore } from './filesystem-experience-store'
import type { FsBackend } from '../memory/fs-backend'

/** A fake FsBackend over an in-memory Map, standing in for a real disk across tests. */
function makeFakeBackend(): FsBackend {
  const files = new Map<string, string>()
  return {
    async readTextFile(path) {
      return files.get(path)
    },
    async writeTextFile(path, contents) {
      files.set(path, contents)
    },
    async removeFile(path) {
      files.delete(path)
    },
    async mkdir() {
      // Fake backend has no real directories to create.
    },
    async readDir(dir) {
      const prefix = `${dir}/`
      return [...files.keys()]
        .filter(key => key.startsWith(prefix) && !key.slice(prefix.length).includes('/'))
        .map(key => key.slice(prefix.length))
    },
  }
}

describe('FileSystemExperienceStore', () => {
  it('available is always true', async () => {
    const store = await FileSystemExperienceStore.create({ backend: makeFakeBackend(), baseDir: '/data', namespace: 'ns' })
    expect(store.available).toBe(true)
  })

  it('mutations are readable synchronously right away (no await needed on the mutating call)', async () => {
    const store = await FileSystemExperienceStore.create({ backend: makeFakeBackend(), baseDir: '/data', namespace: 'ns' })
    store.setStrategyWeight('DIRECT_EDIT:timeout', 0.75)
    expect(store.getStrategyWeights()['DIRECT_EDIT:timeout']).toBe(0.75)
  })

  it('a second store instance sharing the same backend+baseDir loads the persisted snapshot (simulates a restart)', async () => {
    const backend = makeFakeBackend()
    const store1 = await FileSystemExperienceStore.create({ backend, baseDir: '/data', namespace: 'shared' })
    store1.setStrategyWeight('DIRECT_EDIT:timeout', 0.42)
    store1.addDecomposition({ task_type: 'refactor', decomposition: ['plan', 'edit', 'verify'], success_rate: 0.9 })

    // Give the background persist a tick to land before the next instance reads it.
    await new Promise(resolve => setTimeout(resolve, 20))

    const store2 = await FileSystemExperienceStore.create({ backend, baseDir: '/data', namespace: 'shared' })
    expect(store2.getStrategyWeights()['DIRECT_EDIT:timeout']).toBe(0.42)
    expect(store2.getDecompositions()).toEqual([
      { task_type: 'refactor', decomposition: ['plan', 'edit', 'verify'], success_rate: 0.9 },
    ])
  })

  it('different namespaces under the same baseDir are isolated', async () => {
    const backend = makeFakeBackend()
    const storeA = await FileSystemExperienceStore.create({ backend, baseDir: '/data', namespace: 'ns-a' })
    storeA.setStrategyWeight('DIRECT_EDIT:timeout', 0.1)
    await new Promise(resolve => setTimeout(resolve, 20))

    const storeB = await FileSystemExperienceStore.create({ backend, baseDir: '/data', namespace: 'ns-b' })
    expect(storeB.getStrategyWeights()['DIRECT_EDIT:timeout']).toBeUndefined()
  })

  it('toJSON reflects all recorded entry types', async () => {
    const store = await FileSystemExperienceStore.create({ backend: makeFakeBackend(), baseDir: '/data', namespace: 'ns' })
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
})
