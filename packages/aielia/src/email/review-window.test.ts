import { describe, it, expect } from 'vitest'
import { InMemoryEmailCache } from './cache.js'
import { FakeEmailProvider } from './fake-provider.js'
import { generateSyntheticMailbox } from './synthetic-mailbox.js'
import { DEFAULT_REVIEW_WINDOW, loadReviewWindow, reviewWindowLabel, saveReviewWindow, syncForWindow, windowSince } from './review-window.js'
import { syncAccount } from './sync.js'
import type { SettingsStore } from '../writer/write-permissions.js'
import type { Page, PageOptions } from './provider.js'
import type { Message } from './model.js'

const NOW = new Date('2026-11-02T12:00:00.000Z')
const ALL = { offset: 0, limit: 100_000 }
const store = (): SettingsStore => { const m = new Map<string, unknown>(); return { getSetting: async (k) => m.get(k), setSetting: async (k, v) => { m.set(k, v) } } }
const mailbox = () => generateSyntheticMailbox({ seed: 3, perCategory: 6 })
const ids = async (c: InMemoryEmailCache): Promise<string[]> => (await c.queryMessages({}, ALL)).items.map((m) => m.id).sort()
const expected = (p: FakeEmailProvider, since: string | undefined): string[] =>
  [...(p as unknown as { messages: Map<string, Message> }).messages.values()].filter((m) => !since || m.date >= since).map((m) => m.id).sort()

/** A provider that ignores the `since` hint, as one without a native filter would. */
class IgnoresHint extends FakeEmailProvider {
  override listMessages(f: string, o: PageOptions = {}): Promise<Page<Message>> { return super.listMessages(f, { ...o, since: undefined }) }
}

describe('review window setting', () => {
  it('defaults to 30 days, round-trips, and refuses an unknown value', async () => {
    const s = store()
    expect(await loadReviewWindow(s, 'a')).toBe(DEFAULT_REVIEW_WINDOW)
    await saveReviewWindow(s, 'a', 'all')
    expect(await loadReviewWindow(s, 'a')).toBe('all')
    await s.setSetting('email:review-window:a', 14)
    expect(await loadReviewWindow(s, 'a')).toBe(30)
    await expect(saveReviewWindow(s, 'a', 14 as never)).rejects.toThrow()
  })
  it('turns a window into an instant, and all into none', () => {
    expect(windowSince(7, NOW)).toBe('2026-10-26T12:00:00.000Z')
    expect(windowSince(365, NOW)).toBe('2025-11-02T12:00:00.000Z')
    expect(windowSince('all', NOW)).toBeUndefined()
    expect(reviewWindowLabel(90)).toBe('Last 90 days')
    expect(reviewWindowLabel('all')).toBe('All messages')
  })
})

describe('syncForWindow', () => {
  it('first sync stores only mail inside the window', async () => {
    const p = new FakeEmailProvider(mailbox()), c = new InMemoryEmailCache()
    const r = await syncForWindow(p, c, store(), 7, { now: NOW, pageSize: 5 })
    expect(r.sync.status).toBe('complete')
    const got = await ids(c)
    expect(got).toEqual(expected(p, windowSince(7, NOW)))
    expect(got.length).toBeGreaterThan(0)
    expect(got.length).toBeLessThan(expected(p, undefined).length)
    for (const t of (await c.listThreads(undefined, ALL)).items) expect(t.lastMessageAt >= windowSince(7, NOW)!).toBe(true)
  })
  it('is correct even when the provider ignores the since hint', async () => {
    const p = new IgnoresHint(mailbox()), c = new InMemoryEmailCache()
    await syncForWindow(p, c, store(), 7, { now: NOW })
    expect(await ids(c)).toEqual(expected(p, windowSince(7, NOW)))
  })
  it('all equals the whole mailbox', async () => {
    const p = new FakeEmailProvider(mailbox()), c = new InMemoryEmailCache()
    await syncForWindow(p, c, store(), 'all', { now: NOW })
    expect(await ids(c)).toEqual(expected(p, undefined))
  })
  it('widening backfills exactly the missing range and keeps the change token', async () => {
    const p = new FakeEmailProvider(mailbox()), c = new InMemoryEmailCache(), s = store()
    await syncForWindow(p, c, s, 7, { now: NOW })
    const before = await ids(c), token = await c.getSyncToken(p.account.id)
    const r = await syncForWindow(p, c, s, 30, { now: NOW })
    expect(r.backfill?.status).toBe('complete')
    expect(await ids(c)).toEqual(expected(p, windowSince(30, NOW)))
    expect((await ids(c)).length).toBeGreaterThan(before.length)
    expect(await c.getSyncToken(p.account.id)).toBe(token)
    // A second call with the same window does no backfill.
    expect((await syncForWindow(p, c, s, 30, { now: NOW })).backfill).toBeUndefined()
  })
  it('widening to all backfills everything', async () => {
    const p = new FakeEmailProvider(mailbox()), c = new InMemoryEmailCache(), s = store()
    await syncForWindow(p, c, s, 7, { now: NOW })
    await syncForWindow(p, c, s, 'all', { now: NOW })
    expect(await ids(c)).toEqual(expected(p, undefined))
  })
  it('narrowing deletes nothing', async () => {
    const p = new FakeEmailProvider(mailbox()), c = new InMemoryEmailCache(), s = store()
    await syncForWindow(p, c, s, 90, { now: NOW })
    const before = await ids(c)
    const r = await syncForWindow(p, c, s, 7, { now: NOW })
    expect(r.backfill).toBeUndefined()
    expect(await ids(c)).toEqual(before)
  })
  it('an interrupted first run resumes, and a different window restarts it', async () => {
    const p = new FakeEmailProvider(mailbox()), c = new InMemoryEmailCache(), s = store()
    let calls = 0
    const r1 = await syncForWindow(p, c, s, 30, { now: NOW, pageSize: 3, shouldStop: () => ++calls > 4 })
    expect(r1.sync.status).toBe('interrupted')
    const r2 = await syncForWindow(p, c, s, 30, { now: NOW, pageSize: 3 })
    expect(r2.sync.status).toBe('complete')
    expect(await ids(c)).toEqual(expected(p, windowSince(30, NOW)))
    // Interrupt again under 7 days, then ask for 'all': the partial listing is discarded, not mixed.
    const p2 = new FakeEmailProvider(mailbox()), c2 = new InMemoryEmailCache(), s2 = store()
    calls = 0
    await syncForWindow(p2, c2, s2, 7, { now: NOW, pageSize: 3, shouldStop: () => ++calls > 4 })
    await syncForWindow(p2, c2, s2, 'all', { now: NOW, pageSize: 3 })
    expect(await ids(c2)).toEqual(expected(p2, undefined))
  })
  it('a new arrival inside the window is picked up, and a change to old uncached mail is not pulled in', async () => {
    const p = new FakeEmailProvider(mailbox()), c = new InMemoryEmailCache(), s = store()
    await syncForWindow(p, c, s, 7, { now: NOW })
    const n = p.deliver({ from: { address: 'x@example.com' }, subject: 'fresh', textBody: 'hi' })
    const old = expected(p, undefined).find((id) => !expected(p, windowSince(7, NOW)).includes(id))!
    await p.markRead([old], true)
    const r = await syncForWindow(p, c, s, 7, { now: NOW })
    expect(r.sync.mode).toBe('incremental')
    expect(await c.getMessage(n.id)).toBeDefined()
    expect(await c.getMessage(old)).toBeUndefined()
  })
  it('plain syncAccount with no window still mirrors everything', async () => {
    const p = new FakeEmailProvider(mailbox()), c = new InMemoryEmailCache()
    await syncAccount(p, c)
    expect(await ids(c)).toEqual(expected(p, undefined))
  })
})
