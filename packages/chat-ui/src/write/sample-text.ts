/** The text of the sample article a first-time visitor sees in Write: a short version of "Introducing Aielia Write". Kept apart from the recording made on it (sample-recording.json, by scripts/record-write-sample.ts). */
export const SAMPLE_ARTICLE_NAME = 'Sample: Introducing Aielia Write'

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
