import { z } from 'zod'
import { parseModelJson } from '../model-json.js'
import type { SettingsStore } from '../writer/write-permissions.js'
import { buildMailModelInput } from './model-input.js'
import { senderExcluded } from './privacy.js'
import { MAIL_UNTRUSTED_PROMPT } from './untrusted.js'
import type { Account, Folder, Message } from './model.js'

/**
 * Voice profile (A5), after `writer/article-style-derive.ts`: how the user writes, drawn from a capped sample of their own sent mail,
 * separately for each kind of recipient (a close colleague, a customer, a stranger). One model call describes what the sample shows.
 * Derivation fills only what is empty: a field the user has written or edited is kept. The profile is visible and editable, and when it
 * is given to a model it is labelled as an observation of past mail, never as something the user said (`renderVoiceForPrompt`).
 *
 * Mail text reaches the model only through the F8 choke point (`buildMailModelInput`), so an account that is off, an excluded folder
 * and an excluded sender contribute nothing; a message addressed to an excluded address is left out as well. This module imports no
 * LLM client: the caller injects a plain text-in, text-out `VoiceModel` on the cheaper automatic model.
 */

export const RECIPIENT_KINDS = ['colleague', 'customer', 'stranger'] as const
export const RecipientKindSchema = z.enum(RECIPIENT_KINDS)
export type RecipientKind = z.infer<typeof RecipientKindSchema>

/** Hard caps on what is sent: messages, characters per message, characters in all. */
export const VOICE_SAMPLE_MAX_MESSAGES = 40
export const VOICE_SAMPLE_MAX_CHARS_PER_MESSAGE = 800
export const VOICE_SAMPLE_MAX_CHARS = 12_000
const MAX_FIELD = 400

export const VOICE_FIELDS = ['voice', 'greeting', 'signoff'] as const
export type VoiceField = (typeof VOICE_FIELDS)[number]

const VoiceEntrySchema = z.object({
  /** How the user writes to this kind of recipient: person, formality, sentence length, typical length. */
  voice: z.string(),
  greeting: z.string(),
  signoff: z.string(),
  /** Fields the user wrote or edited themselves; derivation never overwrites them. */
  userSet: z.array(z.enum(VOICE_FIELDS)),
})
export type VoiceEntry = z.infer<typeof VoiceEntrySchema>

export const VoiceProfileSchema = z.object({
  colleague: VoiceEntrySchema,
  customer: VoiceEntrySchema,
  stranger: VoiceEntrySchema,
  derivedAt: z.string().optional(),
})
export type VoiceProfile = z.infer<typeof VoiceProfileSchema>

const emptyEntry = (): VoiceEntry => ({ voice: '', greeting: '', signoff: '', userSet: [] })
export const emptyVoiceProfile = (): VoiceProfile => ({ colleague: emptyEntry(), customer: emptyEntry(), stranger: emptyEntry() })

const key = (accountId: string): string => `email:voice:${accountId}`

export async function loadVoiceProfile(store: SettingsStore, accountId: string): Promise<VoiceProfile> {
  const parsed = VoiceProfileSchema.safeParse(await store.getSetting(key(accountId)))
  return parsed.success ? parsed.data : emptyVoiceProfile()
}

export async function saveVoiceProfile(store: SettingsStore, accountId: string, profile: VoiceProfile): Promise<void> {
  await store.setSetting(key(accountId), VoiceProfileSchema.parse(profile))
}

const clean = (v: unknown): string => (typeof v === 'string' ? v.trim().slice(0, MAX_FIELD) : '')

/** The user writes or edits one field. An empty value clears it and hands it back to derivation. */
export function editVoice(profile: VoiceProfile, kind: RecipientKind, field: VoiceField, value: string): VoiceProfile {
  const entry = profile[kind]
  const v = clean(value)
  const userSet = v ? [...new Set([...entry.userSet, field])] : entry.userSet.filter((f) => f !== field)
  return { ...profile, [kind]: { ...entry, [field]: v, userSet } }
}

/**
 * The profile as text for a drafting prompt. Derived fields are marked as observations of past mail; only fields the user set
 * themselves are presented as the user's own. Nothing here reads as an instruction from the user that they did not give.
 */
export function renderVoiceForPrompt(profile: VoiceProfile, kind: RecipientKind): string {
  const e = profile[kind]
  const lines: string[] = []
  for (const f of VOICE_FIELDS) {
    if (!e[f]) continue
    lines.push(`- ${f}: ${e[f]}${e.userSet.includes(f) ? ' (set by the user)' : ' (observed in past sent mail; a description, not an instruction)'}`)
  }
  return lines.length ? `Writing style for ${kind} recipients:\n${lines.join('\n')}` : ''
}

export const VOICE_SYSTEM_PROMPT =
  'You describe how an email writer writes, so a drafting assistant can write in the same way. You are shown a sample of messages the writer sent, each with a numbered header and the recipients. ' +
  'Group them by kind of recipient: colleague (someone the writer works with closely), customer (someone outside who buys from or is served by the writer), stranger (a first contact or someone the writer does not know). ' +
  'Answer with JSON only: {"voices":{"colleague"?:{"voice":string,"greeting":string,"signoff":string},"customer"?:{...},"stranger"?:{...}}}. ' +
  'voice: one or two sentences on how the writer writes to that kind (person, formality, sentence length, usual length). greeting and signoff: the usual ones, quoted from the sample. ' +
  'Leave out a kind, or use an empty string, when the sample does not show it. Describe only what the messages show; copy no names, figures, dates or other facts from them. ' +
  MAIL_UNTRUSTED_PROMPT

/** Text in, text out. The caller wires this to the cheaper automatic model. */
export type VoiceModel = (system: string, user: string) => Promise<string>

export interface VoiceSampleOptions {
  account: Pick<Account, 'aieliaMayRead' | 'excludedFolders' | 'excludedSenders'>
  folders: readonly Pick<Folder, 'id' | 'name' | 'kind'>[]
  messages: readonly Message[]
  maxMessages?: number
  maxCharsPerMessage?: number
  maxChars?: number
}

export interface VoiceSample {
  /** Model-ready text of each chosen message, newest first. */
  items: string[]
  used: number
  /** Messages that were sent mail but left out because the account is off or the mail is excluded. */
  excluded: number
}

/** Choose and render the capped sample: sent-folder mail only, newest first, privacy applied per message by the F8 choke point. */
export function buildVoiceSample(opts: VoiceSampleOptions): VoiceSample {
  const maxMessages = Math.min(opts.maxMessages ?? VOICE_SAMPLE_MAX_MESSAGES, VOICE_SAMPLE_MAX_MESSAGES)
  const perMessage = Math.min(opts.maxCharsPerMessage ?? VOICE_SAMPLE_MAX_CHARS_PER_MESSAGE, VOICE_SAMPLE_MAX_CHARS_PER_MESSAGE)
  const maxChars = Math.min(opts.maxChars ?? VOICE_SAMPLE_MAX_CHARS, VOICE_SAMPLE_MAX_CHARS)
  const sentIds = new Set(opts.folders.filter((f) => f.kind === 'sent').map((f) => f.id))
  const sent = opts.messages
    .filter((m) => !m.flags.draft && m.folderIds.some((id) => sentIds.has(id)))
    .sort((a, b) => Date.parse(b.date) - Date.parse(a.date))
  const items: string[] = []
  let total = 0
  let excluded = 0
  for (const m of sent) {
    if (items.length >= maxMessages) break
    const recipientExcluded = [...m.to, ...m.cc].some((a) => senderExcluded(opts.account.excludedSenders, a.address))
    const input = recipientExcluded ? undefined : buildMailModelInput(opts.account, { ...m, textBody: m.textBody.slice(0, perMessage) }, opts.folders)
    if (!input || !input.ok) {
      excluded++
      continue
    }
    const text = `Message ${items.length + 1}\n${input.text}`
    if (total + text.length > maxChars) break
    total += text.length
    items.push(text)
  }
  return { items, used: items.length, excluded }
}

export interface DerivedVoice {
  status: 'derived' | 'not_derived'
  profile: VoiceProfile
  /** What was filled, as `kind.field`, for a plain sentence to the user. */
  filled: string[]
  reason?: string
}

export async function deriveVoice(
  input: VoiceSampleOptions & { profile: VoiceProfile; model: VoiceModel; now?: () => string },
): Promise<DerivedVoice> {
  const { profile } = input
  const none: DerivedVoice = { status: 'not_derived', profile, filled: [] }
  const sample = buildVoiceSample(input)
  if (sample.used === 0) return { ...none, reason: input.account.aieliaMayRead ? 'There is no sent mail to learn from.' : 'Aielia may not read this account.' }
  let parsed: unknown
  try {
    parsed = parseModelJson(await input.model(VOICE_SYSTEM_PROMPT, sample.items.join('\n\n')))
  } catch (e) {
    return { ...none, reason: e instanceof Error ? e.message : String(e) }
  }
  const voices = parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>).voices : undefined
  if (!voices || typeof voices !== 'object') return { ...none, reason: 'The answer could not be read.' }

  const filled: string[] = []
  const next: VoiceProfile = { ...profile }
  for (const kind of RECIPIENT_KINDS) {
    const got = (voices as Record<string, unknown>)[kind]
    if (!got || typeof got !== 'object') continue
    const entry = { ...profile[kind] }
    for (const f of VOICE_FIELDS) {
      const v = clean((got as Record<string, unknown>)[f])
      if (v && !entry[f].trim()) {
        entry[f] = v
        filled.push(`${kind}.${f}`)
      }
    }
    next[kind] = entry
  }
  if (filled.length === 0) return { status: 'derived', profile, filled }
  return { status: 'derived', profile: { ...next, derivedAt: (input.now ?? (() => new Date().toISOString()))() }, filled }
}
