import { describe, it, expect } from 'vitest'
import { OfflineEmailSession } from './offline-session.js'
import { buildHostileSet } from './hostile-set.js'

const FIXED = () => '2026-11-01T09:00:00.000Z'

describe('OfflineEmailSession', () => {
  it('reviews, builds a to-do list, and stages a reply without sending', async () => {
    const s = new OfflineEmailSession({ now: FIXED })
    const review = await s.review()
    expect(review.written).toBeGreaterThan(0)
    const todo = await s.todo()
    expect(todo.items.length).toBeGreaterThan(0)
    const reply = await s.reply()
    expect(reply.staged).toBeDefined()
    expect(s.pending()).toHaveLength(1)
    expect((await s.provider.listFolders()).length).toBeGreaterThan(0)
    // staging never sends: Sent is unchanged until approval
    const sentBefore = (await s.provider.listMessages('fld-sent')).items.length
    await s.approve(reply.staged!.id, reply.staged!.fingerprint)
    expect((await s.provider.listMessages('fld-sent')).items.length).toBe(sentBefore + 1)
    expect(s.pending()).toHaveLength(0)
  })

  it('stages nothing and sends nothing for hostile mail', async () => {
    const s = new OfflineEmailSession({ now: FIXED })
    for (const h of buildHostileSet()) s.provider.deliver({ from: h.message.from, subject: h.message.subject, textBody: h.message.textBody })
    const before = (await s.provider.listMessages('fld-sent')).items.length
    await s.run(['review'])
    await s.run(['todo'])
    expect(s.pending()).toEqual([])
    expect((await s.provider.listMessages('fld-sent')).items.length).toBe(before)
    expect((await s.provider.listMessages('fld-drafts')).items).toEqual([])
  })

  it('says so for subcommands the sample does not run', async () => {
    const s = new OfflineEmailSession({ now: FIXED })
    expect((await s.run(['rules'])).join('\n')).toContain('not available')
    expect((await s.run(['bogus'])).join('\n')).toContain('Unknown')
  })
})

describe('/email catchup', () => {
  it('reviews a window, says what needs a response, and rejects an unknown window', async () => {
    const s = new OfflineEmailSession({ now: () => '2026-11-02T00:00:00.000Z' })
    const out = (await s.run(['catchup', '90'])).join('\n')
    expect(out).toMatch(/Last 90 days: \d+ thread\(s\)/)
    expect(out).toMatch(/need a response/)
    expect((await s.run(['catchup', '14'])).join('\n')).toMatch(/Unknown window "14"/)
    // The to-do list is fed by the same records.
    expect((await s.run(['todo'])).join('\n')).not.toMatch(/run \/email review first/)
  })
})
