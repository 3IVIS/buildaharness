/**
 * The port between Aielia and the mail already on this computer (plans/aielia_email_capabilities_plan.html, section 8, D2). The desktop app
 * implements it over Rust commands that read Apple Mail's local store read-only (`mail_local_apple.rs`); tests and the sample implement it
 * in memory (`local-fixture-source.ts`). The shapes mirror the Rust structs one to one (camelCase). No `node:*` and no DOM imports.
 */

export type LocalSourceErrorCode =
  | 'unsupported_platform' | 'not_found' | 'permission_denied' | 'unsupported_layout' | 'body_not_on_this_computer' | 'message_not_found' | 'other'

export class LocalSourceError extends Error {
  constructor(public readonly code: LocalSourceErrorCode, message?: string) {
    super(message ?? code)
    this.name = 'LocalSourceError'
  }
}

const CODES: LocalSourceErrorCode[] = ['unsupported_platform', 'not_found', 'permission_denied', 'unsupported_layout', 'body_not_on_this_computer', 'message_not_found']

/** Rust returns short code strings (`permission_denied`, `unsupported_layout: messages.size is missing`, ...). */
export function mapLocalSourceError(e: unknown): LocalSourceError {
  if (e instanceof LocalSourceError) return e
  const text = typeof e === 'string' ? e : e instanceof Error ? e.message : 'unknown error'
  const code = CODES.find((c) => text === c || text.startsWith(`${c}:`)) ?? 'other'
  return new LocalSourceError(code, text)
}

export interface LocalAccountInfo { id: string; scheme: string; mailboxes: number; messages: number }
export interface LocalDiscovery {
  available: boolean
  /** A short code when `available` is false. */
  reason?: LocalSourceErrorCode | string | null
  layout?: string | null
  accounts: LocalAccountInfo[]
  messageCount: number
}
export interface LocalMailboxRow { rowid: number; accountId: string; scheme: string; path: string[]; total: number; unread: number }

export interface LocalMessageFilter {
  mailboxIds?: number[]
  conversationId?: number
  /** Unix seconds, inclusive / exclusive. */
  since?: number
  before?: number
  afterRowid?: number
  unreadOnly?: boolean
  text?: string
  from?: string
  limit?: number
  offset?: number
}

export interface LocalMessageRow {
  rowid: number
  messageIdHeader?: string | null
  conversationId: number
  mailbox: number
  subjectPrefix?: string | null
  subject: string
  sender?: string | null
  senderName?: string | null
  dateReceived: number
  dateSent?: number | null
  read: boolean
  flagged: boolean
  deleted: boolean
  flags: number
  size: number
}
export interface LocalMessagePage { items: LocalMessageRow[]; total: number }
export interface LocalRecipientRow { message: number; address: string; name?: string | null; kind: number; position: number }
export interface LocalStateMark { count: number; maxRowid: number; fingerprint: number }
/** (rowid, read, flagged, deleted, mailbox) */
export type LocalRowState = [number, number, number, number, number]
export interface LocalBody { rawBase64: string; partial: boolean }

export interface LocalMailSource {
  discover(): Promise<LocalDiscovery>
  mailboxes(): Promise<LocalMailboxRow[]>
  messages(filter: LocalMessageFilter): Promise<LocalMessagePage>
  message(rowid: number): Promise<LocalMessageRow | null>
  recipients(rowids: number[]): Promise<LocalRecipientRow[]>
  state(): Promise<LocalStateMark>
  states(): Promise<LocalRowState[]>
  /** The raw RFC 822 message. Throws `body_not_on_this_computer` when Mail never downloaded it. */
  body(rowid: number): Promise<LocalBody>
}

/** Mail's own folder names to the kinds Aielia uses. The last path segment decides, case-insensitively. */
const KIND_BY_NAME: Record<string, 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive'> = {
  inbox: 'inbox',
  sent: 'sent', 'sent items': 'sent', 'sent mail': 'sent', 'sent messages': 'sent',
  drafts: 'drafts', draft: 'drafts',
  trash: 'trash', 'deleted items': 'trash', 'deleted messages': 'trash', bin: 'trash', deleted: 'trash',
  junk: 'junk', spam: 'junk', 'junk e-mail': 'junk', 'junk email': 'junk', 'bulk mail': 'junk',
  archive: 'archive', archives: 'archive', 'all mail': 'archive',
}
export function classifyLocalFolder(path: readonly string[]): 'inbox' | 'sent' | 'drafts' | 'trash' | 'junk' | 'archive' | 'custom' {
  const last = (path[path.length - 1] ?? '').trim().toLowerCase()
  return KIND_BY_NAME[last] ?? 'custom'
}
