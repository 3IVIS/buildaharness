import { describe, it, expect } from 'vitest'
import { documentFormatForFile, renderSourcesForModel, sourceKindForFile } from './article-sources.js'

describe('sourceKindForFile', () => {
  it('calls program text code, documents upload, and refuses what is not text', () => {
    expect(sourceKindForFile({ name: 'limits.TS' })).toBe('code')
    expect(sourceKindForFile({ name: 'run.py', type: 'text/x-python' })).toBe('code')
    expect(sourceKindForFile({ name: 'notes.md' })).toBe('upload')
    expect(sourceKindForFile({ name: 'readme', type: 'text/plain' })).toBe('upload')
    expect(sourceKindForFile({ name: 'paper.pdf', type: 'application/pdf' })).toBe('upload')
    expect(sourceKindForFile({ name: 'brief.DOCX' })).toBe('upload')
    expect(sourceKindForFile({ name: 'old.doc' })).toBeUndefined()
    expect(sourceKindForFile({ name: 'photo.png', type: 'image/png' })).toBeUndefined()
  })
})

describe('documentFormatForFile', () => {
  it('knows PDF and Word files by name or type, and nothing else', () => {
    expect(documentFormatForFile({ name: 'a.PDF' })).toBe('pdf')
    expect(documentFormatForFile({ name: 'x', type: 'application/pdf' })).toBe('pdf')
    expect(documentFormatForFile({ name: 'a.docx' })).toBe('docx')
    expect(documentFormatForFile({ name: 'a.md' })).toBeUndefined()
  })
})

describe('renderSourcesForModel', () => {
  it('gives each source with text its address and passage, skips the ones without, and cuts a long one to its share', () => {
    expect(renderSourcesForModel({ sources: [{ kind: 'say_so' }] })).toBe('')
    const out = renderSourcesForModel({ sources: [{ kind: 'upload', address: 'a.pdf', passage: 'Alpha.' }, { kind: 'code', address: 'b.ts', passage: 'x'.repeat(5000) }, { kind: 'web' }] }, 3000)
    expect(out).toContain('Source 1 (upload: a.pdf):\nAlpha.')
    expect(out).toContain('Source 2 (code: b.ts)')
    expect(out).toContain('the rest of this source is not shown')
    expect(out.length).toBeLessThan(3500)
  })
})
