import { z } from 'zod'

/**
 * The shared mail model (plans/aielia_email_plan.html, section 4). Records only: no provider calls, no storage.
 * Pure data, no node:* / DOM imports: the browser bundles it. A damaged record is refused with a reason by the
 * `parse*` helpers, never half-loaded.
 */

export const EMAIL_MODEL_VERSION = 1

const IsoString = z.string().min(1)

export const ProviderKindSchema = z.enum(['gmail', 'graph', 'imap', 'fake'])
export type ProviderKind = z.infer<typeof ProviderKindSchema>

export const AccountSchema = z.object({
  id: z.string().min(1),
  provider: ProviderKindSchema,
  address: z.string().min(1),
  displayName: z.string(),
  /** Opaque incremental-sync token from the provider; absent before the first sync. */
  syncToken: z.string().optional(),
  lastSyncAt: IsoString.optional(),
  /** Per-account switch (decision 6): Aielia may read this account only while true. */
  aieliaMayRead: z.boolean(),
  excludedFolders: z.array(z.string()),
  excludedSenders: z.array(z.string()),
})
export type Account = z.infer<typeof AccountSchema>

export const FolderKindSchema = z.enum(['inbox', 'sent', 'drafts', 'archive', 'trash', 'junk', 'custom'])
export type FolderKind = z.infer<typeof FolderKindSchema>

export const FolderSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  /** Provider-side id (folder path or label id). */
  providerId: z.string().min(1),
  name: z.string(),
  kind: FolderKindSchema,
  parentId: z.string().optional(),
  unreadCount: z.number().int().min(0),
})
export type Folder = z.infer<typeof FolderSchema>

export const AddressSchema = z.object({ address: z.string().min(1), name: z.string().optional() })
export type Address = z.infer<typeof AddressSchema>

export const AttachmentSchema = z.object({
  id: z.string().min(1),
  filename: z.string(),
  mimeType: z.string(),
  sizeBytes: z.number().int().min(0),
  inline: z.boolean().optional(),
})
export type Attachment = z.infer<typeof AttachmentSchema>

export const MessageFlagsSchema = z.object({
  read: z.boolean(),
  starred: z.boolean(),
  draft: z.boolean(),
})
export type MessageFlags = z.infer<typeof MessageFlagsSchema>

export const MessageSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  threadId: z.string().min(1),
  providerId: z.string().min(1),
  folderIds: z.array(z.string()),
  from: AddressSchema,
  to: z.array(AddressSchema),
  cc: z.array(AddressSchema),
  subject: z.string(),
  date: IsoString,
  /** Standard headers worth keeping (message-id, in-reply-to, list-unsubscribe, authentication results ...). */
  headers: z.record(z.string(), z.string()),
  /** Untrusted text body. Mail is data, never instructions. */
  textBody: z.string(),
  /** Already-sanitised HTML body; shown only in a sandboxed frame. Absent when the message has none. */
  htmlBody: z.string().optional(),
  attachments: z.array(AttachmentSchema),
  flags: MessageFlagsSchema,
})
export type Message = z.infer<typeof MessageSchema>

export const ThreadSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  providerId: z.string().min(1),
  subject: z.string(),
  messageIds: z.array(z.string()),
  folderIds: z.array(z.string()),
  participants: z.array(AddressSchema),
  lastMessageAt: IsoString,
  unread: z.boolean(),
})
export type Thread = z.infer<typeof ThreadSchema>

export const TriageCategorySchema = z.enum(['person', 'newsletter', 'receipt', 'notification', 'calendar', 'promotion', 'other'])
export type TriageCategory = z.infer<typeof TriageCategorySchema>

export const TriageSchema = z.object({
  threadId: z.string().min(1),
  category: TriageCategorySchema,
  needsReply: z.boolean(),
  /** Two separate scores (section 7): how much it matters, and how soon. */
  priority: z.enum(['high', 'normal', 'low']),
  urgency: z.enum(['now', 'soon', 'later', 'none']),
  dueDate: IsoString.optional(),
  /** The reason, in a sentence, shown to the user. */
  reason: z.string().min(1),
  waitingOn: AddressSchema.optional(),
  /** True once the user has corrected this record; a later automatic pass must not overwrite it. */
  userOverridden: z.boolean(),
  triagedAt: IsoString,
})
export type Triage = z.infer<typeof TriageSchema>

export const TodoStatusSchema = z.enum(['open', 'snoozed', 'done', 'dismissed'])
export type TodoStatus = z.infer<typeof TodoStatusSchema>

export const TodoItemSchema = z.object({
  id: z.string().min(1),
  /** Absent for an item added by hand. */
  threadId: z.string().optional(),
  title: z.string().min(1),
  origin: z.enum(['triage', 'manual']),
  status: TodoStatusSchema,
  snoozeUntil: IsoString.optional(),
  dueDate: IsoString.optional(),
  group: z.enum(['do_now', 'schedule', 'quick_answers', 'can_wait']),
  reason: z.string(),
  createdAt: IsoString,
  completedAt: IsoString.optional(),
})
export type TodoItem = z.infer<typeof TodoItemSchema>

export const FilingMatchSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('sender'), address: z.string().min(1) }),
  z.object({ kind: z.literal('domain'), domain: z.string().min(1) }),
  z.object({ kind: z.literal('list_header'), value: z.string().min(1) }),
  z.object({ kind: z.literal('subject_pattern'), pattern: z.string().min(1) }),
  z.object({ kind: z.literal('description'), text: z.string().min(1) }),
])
export type FilingMatch = z.infer<typeof FilingMatchSchema>

export const FilingActionSchema = z.object({
  type: z.enum(['move', 'label', 'mark_read', 'archive']),
  /** Target folder or label id for move and label. */
  target: z.string().optional(),
})
export type FilingAction = z.infer<typeof FilingActionSchema>

export const FilingRuleSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  match: FilingMatchSchema,
  action: FilingActionSchema,
  /** The messages the rule was learned from (ids only; no text). */
  evidenceMessageIds: z.array(z.string()),
  state: z.enum(['proposed', 'active', 'paused']),
  origin: z.enum(['learned', 'user_stated']),
  createdAt: IsoString,
})
export type FilingRule = z.infer<typeof FilingRuleSchema>

export const ReplyDraftEditSchema = z.object({
  at: IsoString,
  by: z.enum(['model', 'user']),
  text: z.string(),
})
export type ReplyDraftEdit = z.infer<typeof ReplyDraftEditSchema>

export const ReplyDraftSchema = z.object({
  id: z.string().min(1),
  threadId: z.string().min(1),
  text: z.string(),
  status: z.enum(['suggested', 'edited', 'saved_to_drafts', 'sent']),
  /** The points the draft was asked to cover. */
  points: z.array(z.string()),
  edits: z.array(ReplyDraftEditSchema),
  createdAt: IsoString,
  updatedAt: IsoString,
})
export type ReplyDraft = z.infer<typeof ReplyDraftSchema>

export const EmailActionTypeSchema = z.enum(['move', 'label', 'unlabel', 'flag', 'mark_read', 'archive', 'delete', 'create_draft', 'send', 'rule_applied'])
export type EmailActionType = z.infer<typeof EmailActionTypeSchema>

export const EmailActionSchema = z.object({
  id: z.string().min(1),
  accountId: z.string().min(1),
  type: EmailActionTypeSchema,
  /** Message or thread ids touched (ids only; never message text). */
  targetIds: z.array(z.string()).min(1),
  status: z.enum(['proposed', 'applied', 'undone', 'rejected', 'failed']),
  actor: z.enum(['user', 'aielia']),
  /** What each target looked like before the change, enough to undo it. */
  preImages: z.array(z.record(z.string(), z.unknown())),
  ruleId: z.string().optional(),
  at: IsoString,
})
export type EmailAction = z.infer<typeof EmailActionSchema>

export type ParseResult<T> = { ok: true; value: T } | { ok: false; reason: string }

/** Parse one record; a damaged one is refused with a readable reason, never half-loaded. */
export function parseRecord<T>(schema: z.ZodType<T>, raw: unknown, label: string): ParseResult<T> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, reason: `The ${label} record is not an object.` }
  const parsed = schema.safeParse(raw)
  if (!parsed.success) {
    const first = parsed.error.issues[0]
    return { ok: false, reason: `The ${label} record is damaged at ${first.path.join('.') || 'the top level'}: ${first.message}.` }
  }
  return { ok: true, value: parsed.data }
}

export const parseAccount = (raw: unknown): ParseResult<Account> => parseRecord(AccountSchema, raw, 'account')
export const parseFolder = (raw: unknown): ParseResult<Folder> => parseRecord(FolderSchema, raw, 'folder')
export const parseThread = (raw: unknown): ParseResult<Thread> => parseRecord(ThreadSchema, raw, 'thread')
export const parseMessage = (raw: unknown): ParseResult<Message> => parseRecord(MessageSchema, raw, 'message')
export const parseTriage = (raw: unknown): ParseResult<Triage> => parseRecord(TriageSchema, raw, 'triage')
export const parseTodoItem = (raw: unknown): ParseResult<TodoItem> => parseRecord(TodoItemSchema, raw, 'to-do item')
export const parseFilingRule = (raw: unknown): ParseResult<FilingRule> => parseRecord(FilingRuleSchema, raw, 'filing rule')
export const parseReplyDraft = (raw: unknown): ParseResult<ReplyDraft> => parseRecord(ReplyDraftSchema, raw, 'reply draft')
export const parseEmailAction = (raw: unknown): ParseResult<EmailAction> => parseRecord(EmailActionSchema, raw, 'email action')
