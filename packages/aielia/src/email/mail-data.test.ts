import { describe, it, expect } from 'vitest'
import { InMemoryEmailCache } from './cache.js'
import { InMemorySecretStore } from './secret-store.js'
import { DEFAULT_MAIL_PERMISSIONS, deleteAllMailData, disconnectAccount, loadMailPermissions, mailPrivacyKey, revokeInstructions, saveMailPermissions, type RemovableSettings } from './mail-data.js'
import { loadMailPrivacy, saveMailPrivacy } from './privacy.js'
import { MAIL_ACTIVITY_KEY } from './mail-spend.js'
import { generateSyntheticMailbox } from './synthetic-mailbox.js'
import { InMemoryTriageStore, triageThreads } from './triage.js'
import { applyMailPrivacy, DEFAULT_MAIL_PRIVACY } from './privacy.js'

class MapSettings implements RemovableSettings {
  readonly map = new Map<string, unknown>()
  async getSetting(k: string): Promise<unknown> { return this.map.get(k) }
  async setSetting(k: string, v: unknown): Promise<void> { this.map.set(k, v) }
  async removeSetting(k: string): Promise<void> { this.map.delete(k) }
}

async function seeded() {
  const box = generateSyntheticMailbox({ seed: 3 })
  const cache = new InMemoryEmailCache()
  await cache.upsertFolders(box.folders)
  await cache.upsertThreads(box.threads)
  await cache.upsertMessages(box.messages)
  await cache.setSyncToken(box.account.id, 'tok')
  const secrets = new InMemorySecretStore()
  await secrets.set(box.account.id, 'refresh-token-secret')
  const settings = new MapSettings()
  await saveMailPrivacy(settings, box.account.id, { aieliaMayRead: true, excludedFolders: ['x'], excludedSenders: [] })
  await saveMailPermissions(settings, { organiseWithoutAsking: true, spendCapUsd: 2 })
  await settings.setSetting(MAIL_ACTIVITY_KEY, [{ at: 'x' }])
  return { box, cache, secrets, settings }
}

describe('mail data controls', () => {
  it('permissions default to nothing done alone and no cap', async () => {
    expect(await loadMailPermissions(new MapSettings())).toEqual(DEFAULT_MAIL_PERMISSIONS)
  })

  it('delete all data leaves nothing in storage', async () => {
    const { box, cache, secrets, settings } = await seeded()
    let reset = 0
    let globals = 0
    await deleteAllMailData({ cache, secrets, settings, spend: { reset: () => { reset++ } }, clearGlobalExtras: () => { globals++ } }, [box.account])
    expect(await secrets.get(box.account.id)).toBeUndefined()
    expect(await cache.getFolders(box.account.id)).toEqual([])
    expect((await cache.queryMessages({}, { offset: 0, limit: 1000 })).total).toBe(0)
    expect((await cache.listThreads(undefined, { offset: 0, limit: 1000 })).total).toBe(0)
    expect(await cache.getSyncToken(box.account.id)).toBeUndefined()
    expect([...settings.map.keys()]).toEqual([])
    expect(await loadMailPrivacy(settings, box.account.id)).toEqual(DEFAULT_MAIL_PRIVACY)
    expect(reset).toBe(1)
    expect(globals).toBe(1)
  })

  it('a store with no remove still holds no value afterwards', async () => {
    const { box, cache, secrets } = await seeded()
    const m = new Map<string, unknown>([[mailPrivacyKey(box.account.id), { aieliaMayRead: true, excludedFolders: [], excludedSenders: [] }]])
    const settings = { getSetting: async (k: string) => m.get(k), setSetting: async (k: string, v: unknown) => { m.set(k, v) } }
    await disconnectAccount({ cache, secrets, settings }, box.account)
    expect((await loadMailPrivacy(settings, box.account.id)).aieliaMayRead).toBe(false)
  })

  it('disconnect removes only that account and says how to revoke the grant', async () => {
    const { box, cache, secrets, settings } = await seeded()
    await secrets.set('other', 'keep-me')
    const extras: string[] = []
    const r = await disconnectAccount({ cache, secrets, settings, clearAccountExtras: (id) => { extras.push(id) } }, { id: box.account.id, provider: 'gmail' })
    expect(await secrets.get(box.account.id)).toBeUndefined()
    expect(await secrets.get('other')).toBe('keep-me')
    expect(await cache.getFolders(box.account.id)).toEqual([])
    expect(settings.map.has(mailPrivacyKey(box.account.id))).toBe(false)
    expect(extras).toEqual([box.account.id])
    expect(r.revoke.url).toContain('google.com')
    expect(r.revoke.steps).toMatch(/Remove access/)
    // Permissions are not per account and stay.
    expect((await loadMailPermissions(settings)).spendCapUsd).toBe(2)
  })

  it('revoke instructions exist for every provider and an unknown one', () => {
    for (const p of ['gmail', 'graph', 'imap', 'fake', 'whatever']) expect(revokeInstructions(p).steps.length).toBeGreaterThan(20)
  })

  it('a switched-off account sends no text to the model', async () => {
    const { box, cache } = await seeded()
    const msgs = (await cache.queryMessages({}, { offset: 0, limit: 50 })).items
    const items = box.threads.slice(0, 5).map((thread) => ({ thread, messages: msgs.filter((m) => m.threadId === thread.id) }))
    let calls = 0
    const model = async () => { calls++; return '{"triage":[]}' }
    const off = applyMailPrivacy(box.account, { ...DEFAULT_MAIL_PRIVACY, aieliaMayRead: false })
    await triageThreads(items, { account: off, model, store: new InMemoryTriageStore() })
    expect(calls).toBe(0)
    // Negative control: the same threads with the switch on do reach the model.
    await triageThreads(items, { account: { ...off, aieliaMayRead: true }, model, store: new InMemoryTriageStore() })
    expect(calls).toBeGreaterThan(0)
  })
})
