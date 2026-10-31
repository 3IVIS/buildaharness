import { MemoryAdapter } from '../memory/adapter';
export interface ReminderRecord {
    id: string;
    rawText: string;
    createdAt: string;
    /** ISO timestamp the reminder is due, or null when no time could be/was parsed — see listDue(). */
    dueAt: string | null;
    done: boolean;
}
export interface ReminderStore {
    create(rawText: string, dueAt: string | null): Promise<ReminderRecord>;
    /** Reminders with a dueAt at or before `now` that aren't done yet. A `dueAt: null` record never appears here — this is storage/query plumbing only, no time-parsing of `rawText` happens in this store. */
    listDue(now: string): Promise<ReminderRecord[]>;
    list(): Promise<ReminderRecord[]>;
}
/** Wraps any MemoryAdapter (in-memory, IndexedDB, filesystem) as a ReminderStore — one array under one key, no bespoke persistence needed. */
export declare class InMemoryReminderStore implements ReminderStore {
    private readonly adapter;
    constructor(adapter: MemoryAdapter);
    create(rawText: string, dueAt: string | null): Promise<ReminderRecord>;
    list(): Promise<ReminderRecord[]>;
    listDue(now: string): Promise<ReminderRecord[]>;
}
