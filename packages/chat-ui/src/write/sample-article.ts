import { createArticleMeta, reconcileSections, type ArticleBundle, type Claim, type Link, type Source } from '@buildaharness/aielia'

/**
 * The article a first-time visitor sees in the sample (no key yet). A short version of "Introducing Aielia Write", written ahead of time:
 * its claims, sources, ideas and suggestion are recorded here, not produced by a model, so the side panels show what Aielia Write keeps
 * without any model call. Everything in it is ordinary article data in the real format.
 */

export const SAMPLE_ARTICLE_ID = 'sample'
const AT = '2026-11-12T09:00:00.000Z'

export const SAMPLE_ARTICLE_MARKDOWN = `# Introducing Aielia Write

## The problem that started it all

For a while we wrote by drafting in a chat tool, copying the text into a word processor, and shuttling changes back and forth between the two. Every revision meant re-pasting the current draft so the model could see what had changed. Paragraphs drifted out of sync, and it got hard to tell which parts were AI-written and which version was current.

## Why existing tools were not enough

Claude, ChatGPT, Gemini and Notion AI all draft well, but in our experience none of them kept a source behind a claim or flagged it when that source changed. Jenni AI looked like the closest fit, but it is aimed at academic papers, with citation styles and a literature database most writers do not need. The blogging tools we looked at optimize for search rankings, not for whether what you wrote is true.

## What Aielia Write does

Aielia Write is built on Aielia, our system for tracking facts. It pulls out each claim in your draft sentence by sentence, checks each one against your sources, and keeps a record of which passages back it. Every chat edit can be undone, because a version is saved before any change. You bring your own key, and your articles stay on your own computer, with a spend meter and a cap.

## Getting started

Aielia Write does not run models of its own, so it needs an API key from a model provider. We suggest OpenRouter, which gives you one key that reaches models from many providers. Set a spending limit before you start, and you cannot be surprised later.
`

const PASSAGE_OPENROUTER = 'OpenRouter provides a unified API that gives you access to hundreds of AI models through a single endpoint, with one key and one account.'

function claim(id: string, sectionId: string, quote: string, status: Claim['sourceStatus'], extra: Partial<Claim> = {}): Claim {
  return {
    id,
    sectionId,
    quote,
    position: SAMPLE_ARTICLE_MARKDOWN.indexOf(quote),
    kind: 'factual',
    author: 'model',
    authorAt: AT,
    confirmed: false,
    sourceStatus: status,
    ...extra,
  }
}

export function buildSampleBundle(): ArticleBundle {
  const markdown = SAMPLE_ARTICLE_MARKDOWN
  const sections = reconcileSections([], markdown, (taken) => {
    let n = taken.size + 1
    while (taken.has(`s${n}`)) n++
    return `s${n}`
  }).sections
  const section = (heading: string): string => sections.find((s) => s.heading === heading)?.id ?? sections[0].id

  const jenni = 'Jenni AI looked like the closest fit, but it is aimed at academic papers'
  const blogging = 'The blogging tools we looked at optimize for search rankings, not for whether what you wrote is true.'
  const openrouter = 'We suggest OpenRouter, which gives you one key that reaches models from many providers.'
  const undo = 'Every chat edit can be undone, because a version is saved before any change.'

  const sources: Source[] = [
    { id: 'src1', kind: 'web', address: 'https://openrouter.ai', passage: PASSAGE_OPENROUTER, readAt: AT, fingerprint: 'sample-openrouter', trust: 'normal', freshness: 'current' },
  ]
  const claims: Claim[] = [
    claim('c1', section('Why existing tools were not enough'), jenni, 'none'),
    claim('c2', section('Why existing tools were not enough'), blogging, 'none'),
    claim('c3', section('Getting started'), openrouter, 'supported', {
      confirmed: true,
      check: { ranAt: AT, model: 'sample', reason: 'The page says one key and one account reach hundreds of models through a single endpoint.', claimText: openrouter, sourceFingerprints: { src1: 'sample-openrouter' } },
    }),
    claim('c4', section('What Aielia Write does'), undo, 'none', { kind: 'framing', author: 'writer', confirmed: true }),
  ]
  const links: Link[] = [{ id: 'l1', from: { type: 'claim', id: 'c3' }, to: { type: 'source', id: 'src1' }, kind: 'supported_by', origin: 'confirmed', at: AT }]
  const meta = {
    ...createArticleMeta(SAMPLE_ARTICLE_ID, 'Introducing Aielia Write'),
    name: 'Sample: Introducing Aielia Write',
    sections,
    claims,
    sources,
    links,
    ideas: [
      { id: 'i1', text: 'Add a short example of a claim that lost its source after the source page changed.', origin: 'assistant' as const, model: 'sample', sectionId: section('What Aielia Write does'), state: 'open' as const, createdAt: AT },
    ],
    suggestions: [
      {
        id: 'sg1',
        span: { start: markdown.indexOf('Paragraphs drifted out of sync'), end: markdown.indexOf('Paragraphs drifted out of sync') + 'Paragraphs drifted out of sync'.length, quote: 'Paragraphs drifted out of sync' },
        replacement: 'Paragraphs drifted apart',
        reason: 'Shorter, and it says the same thing.',
        proposedBy: 'assistant' as const,
        model: 'sample',
        state: 'pending' as const,
        createdAt: AT,
      },
    ],
  }
  return { markdown, meta, snapshots: [] }
}
