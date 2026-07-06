import type { MemoryAdapter } from '../memory/adapter'

export interface ReminderRecord {
  id: string
  rawText: string
  createdAt: string
  /** ISO timestamp the reminder is due, or null when no time could be/was parsed — see listDue(). */
  dueAt: string | null
  done: boolean
}

export interface ReminderStore {
  create(rawText: string, dueAt: string | null): Promise<ReminderRecord>
  /** Reminders with a dueAt at or before `now` that aren't done yet. A `dueAt: null` record never appears here — this is storage/query plumbing only, no time-parsing of `rawText` happens in this store. */
  listDue(now: string): Promise<ReminderRecord[]>
  list(): Promise<ReminderRecord[]>
}

const REMINDERS_KEY = 'reminders'

/** Wraps any MemoryAdapter (in-memory, IndexedDB, filesystem) as a ReminderStore — one array under one key, no bespoke persistence needed. */
export class InMemoryReminderStore implements ReminderStore {
  constructor(private readonly adapter: MemoryAdapter) {}

  async create(rawText: string, dueAt: string | null): Promise<ReminderRecord> {
    const record: ReminderRecord = {
      id: crypto.randomUUID(),
      rawText,
      createdAt: new Date().toISOString(),
      dueAt,
      done: false,
    }
    await this.adapter.set(REMINDERS_KEY, record, 'append')
    return record
  }

  async list(): Promise<ReminderRecord[]> {
    return ((await this.adapter.get(REMINDERS_KEY)) as ReminderRecord[] | undefined) ?? []
  }

  async listDue(now: string): Promise<ReminderRecord[]> {
    const all = await this.list()
    return all.filter(r => !r.done && r.dueAt !== null && r.dueAt <= now)
  }
}
