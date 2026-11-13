import type { Account, Folder, Message, Thread } from './model.js'

/**
 * A deterministic, invented mailbox for tests and demos. Every name, company, address and sentence is made up here
 * (addresses use the reserved example domains). Nothing is copied from a real mailbox or a real campaign.
 */

export type SyntheticCategory = 'newsletter' | 'receipt' | 'direct_question' | 'waiting_on_other' | 'deadline' | 'spoofed_sender'
export const SYNTHETIC_CATEGORIES: SyntheticCategory[] = ['newsletter', 'receipt', 'direct_question', 'waiting_on_other', 'deadline', 'spoofed_sender']

export interface SyntheticMailbox {
  account: Account
  folders: Folder[]
  threads: Thread[]
  messages: Message[]
  /** Which category each thread was generated as (test oracle). */
  categoryByThread: Record<string, SyntheticCategory>
}

export interface SyntheticOptions {
  seed?: number
  /** Threads generated per category (default 2). */
  perCategory?: number
  /** "Now" for the generated dates (default a fixed instant, so output depends only on the seed). */
  now?: string
}

/** mulberry32: a small seeded PRNG. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const FIRST = ['Ada', 'Bruno', 'Cleo', 'Dmitri', 'Esme', 'Farid', 'Gwen', 'Hugo', 'Ines', 'Joss']
const LAST = ['Marlowe', 'Okafor', 'Lindqvist', 'Brandt', 'Quill', 'Sato', 'Pereira', 'Vance', 'Holm', 'Reyes']
const COMPANIES = ['Brightwell Goods', 'Kestrel Analytics', 'Northfield Bakery', 'Lumen Travel', 'Tidewater Software', 'Orchard Row Books']

export const SYNTHETIC_OWNER = { address: 'owner@example.org', name: 'Sam Owner' }
const ACCOUNT_ID = 'acct-synthetic'
const DEFAULT_NOW = '2026-11-01T09:00:00.000Z'

export function generateSyntheticMailbox(opts: SyntheticOptions = {}): SyntheticMailbox {
  const rand = seededRandom(opts.seed ?? 1)
  const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)]
  const nowMs = Date.parse(opts.now ?? DEFAULT_NOW)
  const perCategory = opts.perCategory ?? 2

  const folders: Folder[] = (['inbox', 'sent', 'drafts', 'archive', 'trash'] as const).map((kind) => ({
    id: `fld-${kind}`, accountId: ACCOUNT_ID, providerId: kind.toUpperCase(), name: kind[0].toUpperCase() + kind.slice(1), kind, unreadCount: 0,
  }))
  folders.push({ id: 'fld-projects', accountId: ACCOUNT_ID, providerId: 'Projects', name: 'Projects', kind: 'custom', unreadCount: 0 })

  const threads: Thread[] = []
  const messages: Message[] = []
  const categoryByThread: Record<string, SyntheticCategory> = {}
  let n = 0

  const person = () => {
    const first = pick(FIRST)
    const last = pick(LAST)
    return { address: `${first}.${last}`.toLowerCase() + '@example.com', name: `${first} ${last}` }
  }

  const addThread = (category: SyntheticCategory, build: (i: number) => Array<{ from: { address: string; name?: string }; to: { address: string; name?: string }; subject: string; body: string; headers?: Record<string, string>; sent?: boolean }>) => {
    n += 1
    const tid = `thr-${String(n).padStart(3, '0')}`
    const parts = build(n)
    const ageHours = Math.floor(rand() * 24 * 20) + n
    const ids: string[] = []
    parts.forEach((p, i) => {
      const mid = `${tid}-m${i + 1}`
      const date = new Date(nowMs - (ageHours - i * 3) * 3600_000).toISOString()
      const folderId = p.sent ? 'fld-sent' : 'fld-inbox'
      messages.push({
        id: mid, accountId: ACCOUNT_ID, threadId: tid, providerId: `p-${mid}`, folderIds: [folderId],
        from: p.from, to: [p.to], cc: [], subject: p.subject, date,
        headers: { 'message-id': `<${mid}@example.com>`, ...(p.headers ?? {}) },
        textBody: p.body, attachments: [], flags: { read: p.sent === true, starred: false, draft: false },
      })
      ids.push(mid)
    })
    const last = messages[messages.length - 1]
    threads.push({
      id: tid, accountId: ACCOUNT_ID, providerId: `p-${tid}`, subject: parts[0].subject, messageIds: ids,
      folderIds: [...new Set(ids.map((id) => messages.find((m) => m.id === id)!.folderIds[0]))],
      participants: [parts[0].from, parts[0].to], lastMessageAt: last.date, unread: !last.flags.read,
    })
    categoryByThread[tid] = category
  }

  for (let k = 0; k < perCategory; k++) {
    const co = pick(COMPANIES)
    const slug = co.toLowerCase().replace(/[^a-z]+/g, '')
    const sender = person()

    addThread('newsletter', () => [{
      from: { address: `news@${slug}.example.net`, name: co }, to: SYNTHETIC_OWNER,
      subject: `${co} weekly: ten small ideas`, body: `This week from ${co}: ten small ideas. Unsubscribe any time.`,
      headers: { 'list-unsubscribe': `<https://${slug}.example.net/unsubscribe>`, 'list-id': `<weekly.${slug}.example.net>` },
    }])
    addThread('receipt', () => [{
      from: { address: `orders@${slug}.example.net`, name: co }, to: SYNTHETIC_OWNER,
      subject: `Your receipt from ${co}`, body: `Thank you for your order. Total: ${(10 + Math.floor(rand() * 90))}.00 EUR. Order reference ${1000 + Math.floor(rand() * 8999)}.`,
    }])
    addThread('direct_question', () => [{
      from: sender, to: SYNTHETIC_OWNER,
      subject: `Quick question about the ${pick(['schedule', 'budget', 'venue', 'draft'])}`,
      body: `Hi Sam, could you tell me whether Thursday still works for you? ${sender.name?.split(' ')[0]}`,
    }])
    addThread('waiting_on_other', () => [
      { from: SYNTHETIC_OWNER, to: sender, subject: `Invoice details for ${co}`, body: 'Could you send me the invoice details when you have them? Thanks, Sam', sent: true },
    ])
    addThread('deadline', () => [{
      from: person(), to: SYNTHETIC_OWNER,
      subject: 'Report due Friday', body: 'Reminder: the quarterly report is due by Friday 17:00. Please send it to the shared folder before then.',
    }])
    addThread('spoofed_sender', () => [{
      from: { address: `security@${slug}-account-verify.example.net`, name: 'Example Bank Support' }, to: SYNTHETIC_OWNER,
      subject: 'Verify your account today',
      body: 'Your account will be closed unless you confirm your details at the link below.',
      headers: { 'authentication-results': 'mx.example.org; spf=fail; dkim=none; dmarc=fail', 'reply-to': 'help@different-domain.example.net' },
    }])
  }

  // Unread counts on the folders, from the generated messages.
  for (const f of folders) f.unreadCount = messages.filter((m) => m.folderIds.includes(f.id) && !m.flags.read).length

  const account: Account = {
    id: ACCOUNT_ID, provider: 'fake', address: SYNTHETIC_OWNER.address, displayName: SYNTHETIC_OWNER.name,
    aieliaMayRead: true, excludedFolders: [], excludedSenders: [],
  }
  return { account, folders, threads, messages, categoryByThread }
}
