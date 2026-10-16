import { describe, it, expect } from 'vitest'
import { sourceKindForFile } from './article-sources.js'

describe('sourceKindForFile', () => {
  it('calls program text code, documents upload, and refuses what is not text', () => {
    expect(sourceKindForFile({ name: 'limits.TS' })).toBe('code')
    expect(sourceKindForFile({ name: 'run.py', type: 'text/x-python' })).toBe('code')
    expect(sourceKindForFile({ name: 'notes.md' })).toBe('upload')
    expect(sourceKindForFile({ name: 'readme', type: 'text/plain' })).toBe('upload')
    expect(sourceKindForFile({ name: 'paper.pdf', type: 'application/pdf' })).toBeUndefined()
    expect(sourceKindForFile({ name: 'photo.png', type: 'image/png' })).toBeUndefined()
  })
})
