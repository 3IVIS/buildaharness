import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

// d3 and @dagrejs/dagre restrict deep imports through their `exports` maps, so the plan-graph
// viewer's `?raw` imports of their prebuilt browser bundles go through this resolver instead.
// The bundles are injected into the viewer's sandboxed srcdoc (no CDN, no network).
const require = createRequire(import.meta.url)
// d3 does not export its package.json, so its dist dir is found relative to the resolved entry (d3/src/index.js).
const pkgDir = (name: string): string => dirname(require.resolve(`${name}/package.json`))

const bundles: Record<string, string> = {
  'plan-viz-vendor/d3': join(dirname(require.resolve('d3')), '..', 'dist', 'd3.min.js'),
  'plan-viz-vendor/dagre': join(pkgDir('@dagrejs/dagre'), 'dist', 'dagre.min.js'),
}

/** Vite/Vitest plugin: maps `plan-viz-vendor/<name>?raw` to the bundle file, keeping the `?raw` query. */
export function planVizVendorPlugin() {
  return {
    name: 'plan-viz-vendor',
    enforce: 'pre' as const,
    resolveId(id: string): string | undefined {
      const [name, query] = id.split('?')
      const file = bundles[name]
      return file ? (query ? `${file}?${query}` : file) : undefined
    },
  }
}
