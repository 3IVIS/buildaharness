#!/usr/bin/env -S npx tsx
/**
 * AL9b — report what `adaptive` would have decided under `shadow` mode: per-layer disagreement rate,
 * LLM calls adaptive would have saved, and whether skipped-in-shadow layers coincided with a correction
 * (next-turn `pushbackOnPriorTurn`) or a verification failure.
 *
 *   npx tsx scripts/shadow-report.ts <log.jsonl>
 */
import { readFileSync } from 'node:fs'
import { parseTelemetryLog, summarizeShadow } from '@buildaharness/harness'

export function renderShadowReport(text: string): string {
  const r = summarizeShadow(parseTelemetryLog(text))
  const lines = [
    `shadow turns: ${r.turns}; LLM calls executed ${r.executedCalls} vs adaptive ${r.shadowCalls} (adaptive would have saved ${r.callsSaved})`,
    '',
    '| layer | disagreement rate | would skip | skip coincided with correction/failure |',
    '|---|---|---|---|',
  ]
  for (const l of r.layers) {
    lines.push(`| ${l.layer} | ${(l.disagreementRate * 100).toFixed(0)}% (${l.disagreements}/${l.turns}) | ${l.wouldSkip} | ${l.skipCoincidedWithCorrection}/${l.skipKnown} |`)
  }
  return lines.join('\n')
}

const path = process.argv[2]
if (process.argv[1]?.endsWith('shadow-report.ts')) {
  if (!path) { console.error('usage: shadow-report.ts <log.jsonl>'); process.exit(2) }
  console.log(renderShadowReport(readFileSync(path, 'utf8')))
}
