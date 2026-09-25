#!/usr/bin/env -S npx tsx
/**
 * AL9b — summarise per-layer yield from a layer-outcome log (JSONL or JSON array of rows, as written
 * to the experience store under `layer_outcome:<runId>`).
 *
 *   npx tsx scripts/layer-yield.ts <log.jsonl>
 */
import { readFileSync } from 'node:fs'
import { parseTelemetryLog, summarizeLayerYield } from '@buildaharness/harness'

export function renderLayerYield(text: string): string {
  const rows = summarizeLayerYield(parseTelemetryLog(text))
  const lines = ['| layer | turns | fired | calls | tokens | changed | acted on | corrected next | changes/call |', '|---|---|---|---|---|---|---|---|---|']
  for (const y of rows) {
    lines.push(`| ${y.layer} | ${y.turns} | ${y.fired} | ${y.calls} | ${y.tokens} | ${y.changed} | ${y.actedOn} | ${y.correctedNext}/${y.knownNext} | ${y.changesPerCall === null ? 'n/a' : y.changesPerCall.toFixed(2)} |`)
  }
  return lines.join('\n')
}

const path = process.argv[2]
if (process.argv[1]?.endsWith('layer-yield.ts')) {
  if (!path) { console.error('usage: layer-yield.ts <log.jsonl>'); process.exit(2) }
  console.log(renderLayerYield(readFileSync(path, 'utf8')))
}
