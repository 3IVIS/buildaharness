import type { ArticleMeta, Brief, StyleProfile } from './article-model.js'
import { StyleProfileSchema } from './article-model.js'
import type { SettingsStore } from './write-permissions.js'

/**
 * The brief and the writing profile: what the assistant is told about audience, purpose, tone and terminology whenever it
 * proposes text or talks about the article. Both are the writer's own words; the assistant never changes them. A profile is
 * saved once in the writer's settings and copied into each article that uses it.
 */

const MAX_FIELD = 600
const MAX_TERMS = 40
const BRIEF_FIELDS = ['audience', 'purpose', 'tone', 'length', 'notes'] as const

const clean = (v: unknown): string | undefined => {
  if (typeof v !== 'string') return undefined
  const t = v.trim().slice(0, MAX_FIELD)
  return t || undefined
}

/** Replaces the article's brief. Empty fields are dropped; an empty brief removes it. */
export function setBrief(meta: ArticleMeta, input: Partial<Record<(typeof BRIEF_FIELDS)[number], string | undefined>>): ArticleMeta {
  const brief: Brief = {}
  for (const f of BRIEF_FIELDS) {
    const v = clean(input[f])
    if (v) brief[f] = v
  }
  const { brief: _old, ...rest } = meta
  void _old
  return Object.keys(brief).length > 0 ? { ...rest, brief } : (rest as ArticleMeta)
}

/** Normalises a profile: trims text, drops empty terms and repeats, caps the list. */
export function cleanProfile(p: { id: string; name: string; voice?: string; terms?: { use: string; instead?: string }[] }): StyleProfile | undefined {
  const name = clean(p.name)
  if (!name) return undefined
  const seen = new Set<string>()
  const terms: StyleProfile['terms'] = []
  for (const t of p.terms ?? []) {
    const use = clean(t.use)
    if (!use || seen.has(use.toLowerCase())) continue
    seen.add(use.toLowerCase())
    const instead = clean(t.instead)
    terms.push(instead ? { use, instead } : { use })
    if (terms.length >= MAX_TERMS) break
  }
  return StyleProfileSchema.parse({ id: p.id, name, voice: clean(p.voice) ?? '', terms })
}

/** Gives the article a copy of a profile, or removes it with null. */
export function applyProfile(meta: ArticleMeta, profile: StyleProfile | null): ArticleMeta {
  if (!profile) {
    const { style: _s, ...rest } = meta
    void _s
    return rest as ArticleMeta
  }
  return { ...meta, style: profile }
}

/** The plain text the assistant is given, or '' when the writer set neither a brief nor a profile. */
export function renderStyleGuide(meta: Pick<ArticleMeta, 'brief' | 'style'>): string {
  const lines: string[] = []
  const b = meta.brief
  if (b?.audience) lines.push(`Audience: ${b.audience}`)
  if (b?.purpose) lines.push(`Purpose: ${b.purpose}`)
  if (b?.tone) lines.push(`Tone: ${b.tone}`)
  if (b?.length) lines.push(`Length: ${b.length}`)
  if (b?.notes) lines.push(`Notes: ${b.notes}`)
  const s = meta.style
  if (s) {
    if (s.voice) lines.push(`Voice (${s.name}): ${s.voice}`)
    for (const t of s.terms) lines.push(t.instead ? `Say "${t.use}", not "${t.instead}".` : `Always write "${t.use}" exactly so.`)
  }
  return lines.join('\n')
}

// ----------------------------------------------------------------------------- the writer's saved profiles

const KEY = 'writer:style-profiles'

export async function loadProfiles(store: SettingsStore): Promise<StyleProfile[]> {
  const raw = await store.getSetting(KEY)
  if (!Array.isArray(raw)) return []
  return raw.flatMap((r) => {
    const p = StyleProfileSchema.safeParse(r)
    return p.success ? [p.data] : []
  })
}

export async function saveProfile(store: SettingsStore, profile: { id?: string; name: string; voice?: string; terms?: { use: string; instead?: string }[] }, newId: () => string = () => `p-${crypto.randomUUID().slice(0, 8)}`): Promise<StyleProfile | undefined> {
  const all = await loadProfiles(store)
  const next = cleanProfile({ ...profile, id: profile.id ?? newId() })
  if (!next) return undefined
  await store.setSetting(KEY, [...all.filter((p) => p.id !== next.id), next])
  return next
}

export async function deleteProfile(store: SettingsStore, id: string): Promise<void> {
  await store.setSetting(KEY, (await loadProfiles(store)).filter((p) => p.id !== id))
}
