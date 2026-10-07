/**
 * Pure helpers around the plan-graph viewer page (`plan-viz.html`, derived from cuddlytoddly's
 * web UI — see the header comment inside that file). No React, no DOM: the panel and the tests
 * both go through these.
 */
import type { PlanSnapshot } from '@buildaharness/aielia'

export const D3_MARKER = '<!--PLAN_VIZ_D3-->'
export const DAGRE_MARKER = '<!--PLAN_VIZ_DAGRE-->'

/** A `</script` inside inlined library text would end the surrounding script element early. */
function inlineScript(source: string): string {
  return `<script>${source.replace(/<\/script/gi, '<\\/script')}</script>`
}

/** Replaces the two marker comments with the d3 and dagre bundles; `() =>` keeps `$&` etc. in the bundles literal. */
export function assembleViewerHtml(template: string, d3Source: string, dagreSource: string): string {
  return template.replace(D3_MARKER, () => inlineScript(d3Source)).replace(DAGRE_MARKER, () => inlineScript(dagreSource))
}

let cachedViewer: Promise<string> | undefined

/** Loads the viewer page and both bundles the first time it is called (they stay out of the startup chunk). */
export function loadViewerHtml(): Promise<string> {
  cachedViewer ??= Promise.all([
    import('./plan-viz.html?raw'),
    import('plan-viz-vendor/d3?raw'),
    import('plan-viz-vendor/dagre?raw'),
  ]).then(([page, d3, dagre]) => assembleViewerHtml(page.default, d3.default, dagre.default))
  return cachedViewer
}

export interface StaticExportMeta {
  goal: string
  timestamp: string
  tokens: { prompt: number; completion: number; total: number; calls: number }
}

/** Every `<` is \u003c-escaped (valid JSON, same value) so no data string can close the page's own script element or open an HTML comment inside it. */
function embedJson(value: unknown): string {
  return JSON.stringify(value).replace(/</g, '\\u003c')
}

/** Port of cuddlytoddly's `_build_static_html`: three placeholder replacements. The events list is empty (aielia keeps no event history), so the page hides its Replay button. */
export function buildStaticHtml(template: string, snapshot: PlanSnapshot, meta: StaticExportMeta): string {
  return template
    .replace('"SNAPSHOT_DATA_PLACEHOLDER"', () => embedJson(snapshot.nodes))
    .replace('"EXPORT_META_PLACEHOLDER"', () => embedJson(meta))
    .replace('"REPLAY_EVENTS_PLACEHOLDER"', () => '[]')
}

export async function loadStaticTemplate(): Promise<string> {
  const [page, d3, dagre] = await Promise.all([
    import('./plan-viz-static.html?raw'),
    import('plan-viz-vendor/d3?raw'),
    import('plan-viz-vendor/dagre?raw'),
  ])
  return assembleViewerHtml(page.default, d3.default, dagre.default)
}

/** Same style as `defaultExportFilename()`: no `:` so it is a legal Windows filename. */
export function planExportFilename(now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[:.]/g, '-').slice(0, 19)
  return `aielia-plan-${stamp}.html`
}
