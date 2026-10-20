import { describe, it, expect } from 'vitest'
import { createMemoryArticleStore, resolveConfig, type FolderReader } from '@buildaharness/aielia'
import type { ILLMClient } from '@buildaharness/runtime'
import { createWriteServicesFor, type WritePlatform } from './write-services'

const config = resolveConfig({ llmBackend: 'anthropic', apiKey: 'k' }).config
const llm = { callChatStructured: async () => ({ content: '' }), callChatSync: async () => '', callChat: async function* () { /* none */ } } as unknown as ILLMClient

describe('Write on a host other than the browser tab', () => {
  it('builds from only what the host supplies, and reports what that host can do', async () => {
    const folder: FolderReader = { name: 'repo', files: async () => [], read: async () => undefined }
    const platform: WritePlatform = { store: createMemoryArticleStore(), llm, fetchWeb: async () => 'page', pickFolder: async () => folder, githubToken: 'ghp_x' }
    const services = await createWriteServicesFor(config, platform)
    expect(services.canReadPages).toBe(true)
    expect(services.canSearch).toBe(false)
    expect(await services.pickFolder?.()).toBe(folder)
    expect(services.githubToken).toBe('ghp_x')
    expect(services.models.chat()).toBeTruthy()
  })
  it('a host with no page reading, search or folder access gets none of them', async () => {
    const services = await createWriteServicesFor(config, { store: createMemoryArticleStore(), llm })
    expect([services.canReadPages, services.canSearch, services.pickFolder, services.githubToken]).toEqual([false, false, undefined, undefined])
  })
  it('keeps articles in the store the host gave', async () => {
    const store = createMemoryArticleStore()
    const services = await createWriteServicesFor(config, { store, llm })
    const id = await services.service.create('Post', '# Post\n\nHello.\n')
    expect((await store.list()).map((a) => a.id)).toContain(id)
  })
})
