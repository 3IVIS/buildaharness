import { MAIL_UNTRUSTED_PROMPT } from './untrusted.js'

/**
 * The mail chat port, beside the writer's (`WriterChatPort`): per-thread and per-contact notes the user gives in chat ("Priya
 * handles invoices", "this thread is waiting on legal"), kept across sessions, with a switch that turns recording off (what is
 * already recorded stays visible and removable). Notes are only ever made from the user's own messages, never from mail text, so
 * a note cannot carry an instruction from a mail. No `node:*` and no DOM imports.
 */
export type MailNoteTarget = { kind: 'thread'; threadId: string } | { kind: 'contact'; address: string }

export interface MailNote {
  id: string
  target: MailNoteTarget
  text: string
  capturedAt: string
}

export interface MailChatState {
  notes: MailNote[]
}

export const EMPTY_MAIL_CHAT_STATE: MailChatState = { notes: [] }

const MAX_NOTE_CHARS = 500
const MAX_NOTES = 500

export interface MailChatPort {
  load(): Promise<MailChatState>
  save(state: MailChatState): Promise<void>
  /** False when the user has turned note capture off: nothing new is recorded. */
  captureEnabled(): Promise<boolean>
  setCaptureEnabled(on: boolean): Promise<void>
}

const STATE_KEY = 'mail:chat-state'
const CAPTURE_KEY = 'mail:chat-capture'

/** The part of the assistant's memory adapter the port needs (structurally the runtime's `MemoryAdapter`; not imported, see the F8 source scan). */
export interface MailKeyValueStore {
  get(key: string): Promise<unknown>
  set(key: string, value: unknown): Promise<void>
}

export function createMemoryMailChatPort(memory: MailKeyValueStore): MailChatPort {
  return {
    async load() {
      const raw = await memory.get(STATE_KEY)
      if (!raw || typeof raw !== 'object' || !Array.isArray((raw as MailChatState).notes)) return { notes: [] }
      return { notes: (raw as MailChatState).notes.filter((n) => n && typeof n.id === 'string' && typeof n.text === 'string' && n.target) }
    },
    async save(state) {
      await memory.set(STATE_KEY, state)
    },
    async captureEnabled() {
      return (await memory.get(CAPTURE_KEY)) !== false
    },
    async setCaptureEnabled(on) {
      await memory.set(CAPTURE_KEY, on)
    },
  }
}

const normAddress = (a: string): string => a.trim().toLowerCase()
const sameTarget = (a: MailNoteTarget, b: MailNoteTarget): boolean =>
  a.kind === 'thread' && b.kind === 'thread' ? a.threadId === b.threadId : a.kind === 'contact' && b.kind === 'contact' ? normAddress(a.address) === normAddress(b.address) : false

export type RecordNoteResult = { status: 'recorded'; note: MailNote } | { status: 'off' } | { status: 'empty' }

/** Record one note. With capture off nothing is stored. The note's text is the user's own; it is clipped, and the oldest notes drop past the cap. */
export async function recordMailNote(port: MailChatPort, target: MailNoteTarget, text: string, now: string = new Date().toISOString()): Promise<RecordNoteResult> {
  if (!(await port.captureEnabled())) return { status: 'off' }
  const clipped = text.trim().slice(0, MAX_NOTE_CHARS)
  if (!clipped) return { status: 'empty' }
  const state = await port.load()
  const note: MailNote = { id: `note:${now}:${state.notes.length}`, target, text: clipped, capturedAt: now }
  await port.save({ notes: [...state.notes, note].slice(-MAX_NOTES) })
  return { status: 'recorded', note }
}

export async function removeMailNote(port: MailChatPort, id: string): Promise<boolean> {
  const state = await port.load()
  const notes = state.notes.filter((n) => n.id !== id)
  if (notes.length === state.notes.length) return false
  await port.save({ notes })
  return true
}

/** The notes that apply to a thread and the people on it, oldest first. */
export function notesFor(state: MailChatState, threadId: string | undefined, addresses: string[] = []): MailNote[] {
  const targets: MailNoteTarget[] = [...(threadId ? [{ kind: 'thread' as const, threadId }] : []), ...addresses.map((address) => ({ kind: 'contact' as const, address }))]
  return state.notes.filter((n) => targets.some((t) => sameTarget(t, n.target)))
}

const BASE_PROMPT =
  'You help the user with their email. You can read mail through the mail tools; you change nothing without the user\'s own request, and sending always needs their approval. ' +
  'Answer from what the tools return and say which message you used. If something is not in the mail you can see, say so rather than guessing.'

/** The mail system prompt: the assistant's job, the rule that mail is data, and the user's own notes for what is in view. */
export function buildMailSystemPrompt(notes: MailNote[] = []): string {
  const lines = notes.map((n) => `- ${n.target.kind === 'thread' ? `thread ${n.target.threadId}` : n.target.address}: ${n.text}`)
  const block = lines.length > 0 ? `\n\nNotes the user gave you earlier (their own words):\n${lines.join('\n')}` : ''
  return `${BASE_PROMPT}\n\n${MAIL_UNTRUSTED_PROMPT}${block}`
}
