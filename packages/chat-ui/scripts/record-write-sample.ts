/**
 * Records the sample that a first-time visitor to Aielia Write sees (src/write/sample-recording.json).
 *
 * Runs a handful of real cases on the sample article with a real model (the local Claude CLI), through the same services the page
 * uses, and saves the resulting article (claims, sources, suggestions, ideas, comments, style, versions) and the chat that led to it.
 * The page then shows it as it was recorded, with no model call. Run it again to refresh the sample:
 *
 *   cd packages/chat-ui && npx vite-node scripts/record-write-sample.ts
 *
 * It spends real model calls (about two dozen) and reads two public pages. Nothing here ships in the bundle.
 */
import { writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { effectiveSourceStatus, createMemoryArticleStore, type ArticleBundle } from '@buildaharness/aielia'
// Node-only, so not in the package's browser exports.
import { ClaudeCliLLMClient } from '../../aielia/src/claude-cli-llm-client'
import { createWriteServicesFor } from '../src/write/write-services'
import { toAssistantConfig } from '../src/write/write-config'
import { SAMPLE_ARTICLE_MARKDOWN, SAMPLE_ARTICLE_NAME } from '../src/write/sample-text'

const CHAT_MODEL = process.env.SAMPLE_CHAT_MODEL ?? 'sonnet'
const AUTO_MODEL = process.env.SAMPLE_AUTO_MODEL ?? 'haiku'
const OUT = fileURLToPath(new URL('../src/write/sample-recording.json', import.meta.url))

/** Only the start of a page is kept as the passage: enough to check a claim against, and not a copy of someone else's page. */
const MAX_PASSAGE = 2500

/** A page as plain text: scripts, styles and tags removed. */
async function fetchWeb(url: string): Promise<string> {
  const res = await fetch(url, { headers: { 'user-agent': 'Mozilla/5.0 (compatible; AieliaWrite sample recorder)' }, redirect: 'follow' })
  if (!res.ok) throw new Error(`${url} answered ${res.status}`)
  const html = await res.text()
  return html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_PASSAGE)
}

interface Line { id: number; from: 'you' | 'aielia'; text: string; model?: string }
const chat: Line[] = []
let lineId = 0
const say = (from: Line['from'], text: string, model?: string): void => { chat.push({ id: ++lineId, from, text, ...(model ? { model } : {}) }) }
const step = (s: string): void => console.log(`\n== ${s}`)

const config = { ...toAssistantConfig(undefined, {}), llmBackend: 'claude-cli' as const }
const store = createMemoryArticleStore()
const services = await createWriteServicesFor(config, { store, llm: new ClaudeCliLLMClient({}), fetchWeb })
await services.models.setChat(CHAT_MODEL)
await services.models.setAuto(AUTO_MODEL)
const { service } = services

step('create and analyze the article')
const id = await service.create(SAMPLE_ARTICLE_NAME, SAMPLE_ARTICLE_MARKDOWN)
const analyzed = await service.analyze(id, AUTO_MODEL)
console.log('extraction:', analyzed.extraction?.status, 'claims:', (await service.get(id)).meta.claims.length)
await service.saveVersion(id, 'First draft')

const claimWith = async (word: string): Promise<string | undefined> => (await service.get(id)).meta.claims.find((c) => c.kind === 'factual' && c.quote.includes(word))?.id

step('sources: read two real pages and check what they back')
for (const [word, address] of [['OpenRouter', 'https://openrouter.ai'], ['Jenni', 'https://jenni.ai']] as const) {
  const claimId = await claimWith(word)
  if (!claimId) { console.log(`no claim mentions ${word}`); continue }
  const sourceId = await service.addSource(id, { kind: 'web', address })
  const read = await service.readSource(id, sourceId, AUTO_MODEL)
  console.log(word, 'read:', read.status, read.reason ?? '')
  if (read.status !== 'read') continue
  await service.attachSource(id, claimId, sourceId)
  const check = await service.checkClaim(id, claimId, AUTO_MODEL)
  console.log(word, 'check:', check.status)
}

const ask = async (message: string): Promise<{ intent: string }> => {
  say('you', message)
  const read = await services.intent(message, { articleHasText: true, lastReply: chat.filter((l) => l.from === 'aielia').at(-1)?.text })
  console.log(`intent for "${message}":`, read.intent)
  return read
}

step('case 1: a question (answered in the chat)')
{
  const read = await ask('Which claim in this article is the one a reader is most likely to challenge?')
  if (read.intent !== 'answer') console.log('!! expected an answer intent')
  const r = await services.chat('Which claim in this article is the one a reader is most likely to challenge?', id)
  say('aielia', r.reply, r.model)
}

step('case 2: suggestions for two sections')
for (const message of ['Suggest a tighter wording for the first section.', 'Suggest a clearer opening sentence for the Getting started section.']) {
  const read = await ask(message)
  if (read.intent !== 'suggest') console.log('!! expected a suggest intent')
  await services.record(message, id)
  const r = await service.suggest(id, message, CHAT_MODEL, {})
  const added = r.added.length
  say('aielia', added > 0 ? `Added ${added} suggestion${added === 1 ? '' : 's'}. Review ${added === 1 ? 'it' : 'them'} in Issues.` : 'I had no suggestions for that.', CHAT_MODEL)
}

step('accept one suggestion, so History shows a before and an after')
{
  const b = await service.get(id)
  const first = b.meta.suggestions.find((s) => s.state === 'pending')
  if (first) {
    const r = await service.acceptSuggestionAndUpdate(id, first.id, undefined, { analyze: false })
    console.log('accepted', first.id, r.ok)
  }
}

step('case 3: check the claims')
{
  await ask('Check the claims in my article.')
  const full = await service.analyze(id, AUTO_MODEL)
  const b = await service.get(id)
  const factual = b.meta.claims.filter((c) => c.kind === 'factual')
  const statuses = factual.map((c) => effectiveSourceStatus(c, b.meta.sources))
  const supported = statuses.filter((x) => x === 'supported').length
  const unsourced = statuses.filter((x) => x === 'none' || x === 'attached').length
  const flagged = full.resolution?.flagged.length ?? 0
  say('aielia', `I found ${factual.length} factual claim${factual.length === 1 ? '' : 's'}: ${supported} supported, ${unsourced} without a checked source, ${statuses.length - supported - unsourced} to look at.${flagged > 0 ? ` ${flagged} other section${flagged === 1 ? '' : 's'} may need a look because of what changed.` : ''} Details are in Issues.`, AUTO_MODEL)
}

step('case 4: a reviewer note, kept as a comment')
{
  const message = 'A reviewer says the Jenni AI point in the second section needs a source.'
  const read = await ask(message)
  console.log('(intent', read.intent, ')')
  const r = await services.chat(message, id)
  say('aielia', r.reply, r.model)
}

step('case 5: ideas')
{
  await ask('Give me ideas for what else to add to this article.')
  const r = await service.suggestIdeas(id, 'What else could this article add?', CHAT_MODEL)
  const n = r.status === 'suggested' ? r.added.length : 0
  say('aielia', n > 0 ? `Added ${n} idea${n === 1 ? '' : 's'} to Ideas. Write one in when you are ready.` : 'I had no ideas to add.', CHAT_MODEL)
}

step('style and how the sections depend on each other')
console.log('style:', JSON.stringify(await service.deriveStyleFromText(id, AUTO_MODEL)))
{
  const r = await service.findDependencies(id, AUTO_MODEL)
  console.log('dependencies:', r.status, r.status === 'proposed' ? r.added.length : '')
}

step('save')
const bundle: ArticleBundle = await service.get(id)
const out = { recordedAt: new Date().toISOString(), models: { chat: CHAT_MODEL, auto: AUTO_MODEL }, bundle, chat }
// The article was created under a random id; the page knows the sample as "sample".
writeFileSync(OUT, `${JSON.stringify(out, null, 1).split(id).join('sample')}\n`)
const m = bundle.meta
console.log(`wrote ${OUT}: claims ${m.claims.length}, sources ${m.sources.length}, suggestions ${m.suggestions.length}, ideas ${m.ideas.length}, comments ${m.comments.length}, links ${m.links.length}, versions ${bundle.snapshots.length}, chat lines ${chat.length}`)
process.exit(0)
