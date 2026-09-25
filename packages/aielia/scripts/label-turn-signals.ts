#!/usr/bin/env -S npx tsx
/**
 * AL5b — label the classifier eval turns with a DIFFERENT, stronger model family than the classifier
 * (never the classifier itself — circular). Two passes; per-field disagreements are dropped.
 *
 *   LABELLER_BASE_URL=https://api.openai.com/v1 LABELLER_API_KEY=... LABELLER_MODEL=<model> \
 *     npx tsx scripts/label-turn-signals.ts
 *
 * Writes eval/turn-signals-labels.json and docs/turn_signal_labels_review.md (30 random labels for the
 * owner's non-blocking spot check). Refuses to run without an explicit labeller: the claude-cli
 * backend is the classifier's own family and is deliberately not a fallback.
 */
import { writeFileSync } from 'node:fs'
import { OpenAICompatibleLLMClient } from '@buildaharness/runtime'
import { TURN_SIGNAL_TURNS } from '../eval/turn-signals-corpus.js'
import { reconcileLabels, renderReviewSample, sampleForReview, type LabelledTurn, type SignalLabel } from '../eval/turn-signals.js'

const SYSTEM = `You label one user message sent to an AI assistant, judging MEANING not wording, in any language. Answer as JSON with exactly:
needsGrounding (bool: the answer depends on current/verifiable facts or a file/tool that should be checked rather than recalled),
ambiguity ("none" | "some" | "high": how under-specified the request is, given no other context),
userPosture ("informational" | "directive" | "exploratory" | "corrective"),
pushbackOnPriorTurn (bool: the user disputes or corrects the assistant's previous reply),
statesConstraint (bool: sets a rule/limit meant to govern LATER turns, not a one-off instruction).`

const SCHEMA = {
  type: 'object',
  properties: {
    needsGrounding: { type: 'boolean' },
    ambiguity: { type: 'string', enum: ['none', 'some', 'high'] },
    userPosture: { type: 'string', enum: ['informational', 'directive', 'exploratory', 'corrective'] },
    pushbackOnPriorTurn: { type: 'boolean' },
    statesConstraint: { type: 'boolean' },
  },
  required: ['needsGrounding', 'ambiguity', 'userPosture', 'pushbackOnPriorTurn', 'statesConstraint'],
  additionalProperties: false,
}

async function main(): Promise<void> {
  const { LABELLER_BASE_URL: baseUrl, LABELLER_API_KEY: apiKey, LABELLER_MODEL: model } = process.env
  if (!baseUrl || !apiKey || !model) throw new Error('set LABELLER_BASE_URL, LABELLER_API_KEY and LABELLER_MODEL (a different, stronger model family than the classifier)')
  const client = new OpenAICompatibleLLMClient({ apiKey, baseUrl, defaultModel: model })
  const pass = async (message: string): Promise<SignalLabel | null> => {
    try {
      const res = await client.callChatStructured(
        [{ role: 'system', content: SYSTEM }, { role: 'user', content: message }],
        undefined,
        { model, temperature: 0, structuredOutput: { schema: SCHEMA } },
      )
      return JSON.parse(res.content) as SignalLabel
    } catch {
      return null
    }
  }
  const labelled: LabelledTurn[] = []
  for (const t of TURN_SIGNAL_TURNS) {
    const labels = reconcileLabels(await pass(t.message), await pass(t.message))
    labelled.push({ ...t, labels, labeller: model })
  }
  writeFileSync(new URL('../eval/turn-signals-labels.json', import.meta.url), JSON.stringify(labelled, null, 2) + '\n')
  const withLabels = labelled.filter((t) => Object.keys(t.labels).length > 0)
  writeFileSync(new URL('../../../docs/turn_signal_labels_review.md', import.meta.url), renderReviewSample(sampleForReview(withLabels, 30)))
  console.log(`labelled ${withLabels.length}/${labelled.length} turns with at least one agreed field`)
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
