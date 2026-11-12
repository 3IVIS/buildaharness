import type { ArticleBundle } from '@buildaharness/aielia'
import recording from './sample-recording.json'

/**
 * What a first-time visitor to Write sees before adding a key: a short version of "Introducing Aielia Write" with everything Aielia Write keeps
 * for an article already in it (claims and what backs them, two sources read from the web, suggestions, ideas, a reviewer comment, a style sheet,
 * how the sections depend on each other, versions) and the chat that produced it.
 *
 * None of it is made up here and none of it runs a model in the page: it was recorded from real cases run with a real model on this article
 * (scripts/record-write-sample.ts writes sample-recording.json). Run that script again to refresh it.
 */

export const SAMPLE_ARTICLE_ID = 'sample'

/** The article, with its records and versions, as recorded. A fresh copy each time, so editing the sample never changes the recording. */
export function buildSampleBundle(): ArticleBundle {
  return structuredClone(recording.bundle) as unknown as ArticleBundle
}

export interface SampleChatLine { id: number; from: 'you' | 'aielia'; text: string; model?: string }

/** The chat of the recording, behind one line that says what it is. */
export function buildSampleChat(): SampleChatLine[] {
  const intro: SampleChatLine['text'] = 'These are real cases I ran on this article earlier, so you can see how Aielia Write works. They were recorded, so nothing here calls a model. Add your AI key to try your own.'
  return [{ id: 1, from: 'aielia', text: intro }, ...(recording.chat as SampleChatLine[]).map((l, i) => ({ ...l, id: i + 2 }))]
}
