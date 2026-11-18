import type { Account, Folder, Message, Thread } from './model.js'

/**
 * The one interface every mail backend implements (plans/aielia_email_plan.html, section 3): Gmail, Graph, IMAP and the
 * in-memory fake all satisfy it, so the rest of the product never knows which one it talks to. Pure types, no node:* or
 * DOM imports. Provider calls return model records; a failure is a rejected promise with an `EmailProviderError`.
 */

export type EmailProviderErrorCode = 'not_found' | 'invalid_argument' | 'unauthorized' | 'rate_limited' | 'unavailable'

export class EmailProviderError extends Error {
  constructor(public readonly code: EmailProviderErrorCode, message: string) {
    super(message)
    this.name = 'EmailProviderError'
  }
}

export interface PageOptions {
  /** Opaque cursor from a previous page's `nextPageToken`. */
  pageToken?: string
  limit?: number
  /**
   * ISO instant. A hint to list only mail received at or after it (review window, plan C2). A provider may honour it natively or ignore it;
   * the sync engine filters again, so a provider that ignores it is still correct, only slower.
   */
  since?: string
}

export interface Page<T> {
  items: T[]
  /** Absent on the last page. */
  nextPageToken?: string
}

export interface SearchQuery {
  /** Free text matched against subject, sender and body. */
  text?: string
  from?: string
  folderId?: string
  unreadOnly?: boolean
  /** ISO timestamps, inclusive. */
  after?: string
  before?: string
}

export interface DraftInput {
  /** Set when the draft replies inside a thread. */
  threadId?: string
  to: Array<{ address: string; name?: string }>
  cc?: Array<{ address: string; name?: string }>
  /** Blind copies: sent to the provider, never stored on the message. */
  bcc?: Array<{ address: string; name?: string }>
  subject: string
  textBody: string
}

export type MessageChange = { type: 'upsert'; messageId: string } | { type: 'delete'; messageId: string }

export interface ChangeSet {
  changes: MessageChange[]
  /** Store this and pass it to the next `listChanges` call. */
  syncToken: string
  /** True when the provider no longer knows the passed token: drop the cache and list everything again. */
  fullResyncNeeded: boolean
}

export interface EmailProvider {
  readonly account: Account
  listFolders(): Promise<Folder[]>
  listMessages(folderId: string, opts?: PageOptions): Promise<Page<Message>>
  listThreads(folderId: string, opts?: PageOptions): Promise<Page<Thread>>
  getMessage(messageId: string): Promise<Message>
  getThread(threadId: string): Promise<{ thread: Thread; messages: Message[] }>
  search(query: SearchQuery, opts?: PageOptions): Promise<Page<Message>>
  /** Move messages so that their only folder is `folderId`. */
  move(messageIds: string[], folderId: string): Promise<void>
  /** Add (`add: true`) or remove a label, which for a folder-less backend is the same as folder membership. */
  label(messageIds: string[], folderId: string, add: boolean): Promise<void>
  flag(messageIds: string[], starred: boolean): Promise<void>
  markRead(messageIds: string[], read: boolean): Promise<void>
  createDraft(draft: DraftInput): Promise<Message>
  /** Send an existing draft; returns the sent message. */
  send(draftId: string): Promise<Message>
  /** Move to trash, or remove for good when the message is already in trash. */
  delete(messageIds: string[]): Promise<void>
  /** Changes since `syncToken`. With no token, returns an empty change set and the current token. */
  listChanges(syncToken?: string): Promise<ChangeSet>
}
