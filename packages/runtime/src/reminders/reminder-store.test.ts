import { describe, it, expect } from 'vitest'
import { InMemoryAdapter } from '../memory/in-memory'
import { InMemoryReminderStore } from './reminder-store'

describe('InMemoryReminderStore', () => {
  it('creates a reminder with a generated id and returns it', async () => {
    const store = new InMemoryReminderStore(new InMemoryAdapter())

    const record = await store.create('call mom', null)

    expect(record.rawText).toBe('call mom')
    expect(record.dueAt).toBeNull()
    expect(record.done).toBe(false)
    expect(record.id).toBeTruthy()
  })

  it('lists all created reminders in creation order', async () => {
    const store = new InMemoryReminderStore(new InMemoryAdapter())

    await store.create('call mom', null)
    await store.create('buy milk', null)

    const all = await store.list()
    expect(all.map(r => r.rawText)).toEqual(['call mom', 'buy milk'])
  })

  it('listDue returns nothing for reminders with no dueAt', async () => {
    const store = new InMemoryReminderStore(new InMemoryAdapter())
    await store.create('call mom', null)

    expect(await store.listDue(new Date().toISOString())).toEqual([])
  })

  it('listDue returns reminders due at or before now, excluding future and done ones', async () => {
    const store = new InMemoryReminderStore(new InMemoryAdapter())
    const past = await store.create('overdue task', '2020-01-01T00:00:00.000Z')
    await store.create('future task', '2999-01-01T00:00:00.000Z')

    const due = await store.listDue(new Date().toISOString())

    expect(due).toEqual([past])
  })
})
