import { describe, expect, it } from 'vitest'
import { assembleViewerHtml, buildStaticHtml, D3_MARKER, DAGRE_MARKER, loadStaticTemplate, loadViewerHtml, planExportFilename } from './plan-viz-assets'
import { appendixCPlan } from './plan-viz-fixture'

describe('plan-viz assets', () => {
  it('the built srcdoc has both markers replaced and no external script or URL', async () => {
    const html = await loadViewerHtml()
    expect(html).not.toContain(D3_MARKER)
    expect(html).not.toContain(DAGRE_MARKER)
    expect(html).not.toMatch(/<script[^>]*\ssrc=/i)
    expect(html).not.toMatch(/<link[^>]*href=["']https?:/i)
    expect(html).not.toMatch(/(?:src|href)=["']https?:/i)
    expect(html).toContain("type: 'ready'")
  })

  it('does not interpret $-patterns in injected library text', () => {
    const out = assembleViewerHtml(`a${D3_MARKER}b${DAGRE_MARKER}c`, "x$&y$'z", 'q')
    expect(out).toBe("a<script>x$&y$'z</script>b<script>q</script>c")
  })

  it('escapes a closing script tag inside a bundle', () => {
    expect(assembleViewerHtml(D3_MARKER, 'a</script>b', '')).toContain('a<\\/script>b')
  })

  it('static export embeds the nodes and an empty replay list', async () => {
    const { snapshot } = appendixCPlan()
    const html = buildStaticHtml(await loadStaticTemplate(), snapshot, { goal: 'Ship the report', timestamp: 't', tokens: snapshot.tokens })
    expect(html).not.toContain('SNAPSHOT_DATA_PLACEHOLDER')
    expect(html).not.toContain('EXPORT_META_PLACEHOLDER')
    expect(html).not.toContain('REPLAY_EVENTS_PLACEHOLDER')
    expect(html).toContain('const REPLAY_EVENTS  = [];')
    expect(html).toContain('SMTP rejected')
  })

  it('export filenames contain no colon', () => {
    expect(planExportFilename(new Date('2026-10-05T12:34:56.789Z'))).toBe('aielia-plan-2026-10-05T12-34-56.html')
  })
})
