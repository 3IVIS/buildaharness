import { describe, it, expect } from 'vitest'
import { PARAMETER_GROUPS, WRITE_PARAMETERS, adjustmentInstruction, findParameter } from './write-parameters.js'

describe('write parameters', () => {
  it('has every parameter once, with options, and a small basics group shown first', () => {
    const ids = WRITE_PARAMETERS.map((x) => x.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(WRITE_PARAMETERS.every((x) => x.options.length >= 2 && x.options.every((o) => o.length > 0))).toBe(true)
    const basics = WRITE_PARAMETERS.filter((x) => x.group === 'basics')
    expect(basics.length).toBeGreaterThanOrEqual(8)
    expect(basics.length).toBeLessThanOrEqual(12)
    expect(PARAMETER_GROUPS.map((g) => g.id)).toEqual(['basics', 'revise', 'voice', 'structure', 'seo', 'research', 'brand', 'promotion', 'output'])
    // every parameter is in a listed group, and no group is long
    for (const g of PARAMETER_GROUPS) { const n = WRITE_PARAMETERS.filter((x) => x.group === g.id).length; expect(n).toBeGreaterThan(0); expect(n).toBeLessThanOrEqual(13) }
    expect(WRITE_PARAMETERS.length).toBeGreaterThan(70)
  })
  it('keeps options that contain commas and punctuation intact', () => {
    expect(findParameter('article-length')?.options).toContain('Standard (800–1,200 words)')
    expect(findParameter('article-type')?.options).toContain('Problem–solution article')
    expect(findParameter('call-to-action-cta')?.label).toBe('Call to action (CTA)')
  })
  it('marks the one-off actions as revisions and everything else as settings', () => {
    const revisions = WRITE_PARAMETERS.filter((x) => x.kind === 'revision').map((x) => x.label)
    expect(revisions).toEqual(['Introduction revision', 'Article revision', 'Tone revision', 'SEO revision', 'Content enrichment', 'Conclusion revision'])
    expect(WRITE_PARAMETERS.filter((x) => x.group === 'revise').every((x) => x.kind === 'revision')).toBe(true)
  })
  it('turns an adjustment into an instruction, for listed and unlisted aspects alike', () => {
    expect(adjustmentInstruction('Tone of voice', 'Conversational', 'setting')).toContain('tone of voice is: Conversational')
    expect(adjustmentInstruction('Introduction revision', 'Shorten', 'revision')).toBe('Introduction revision: Shorten. Suggest the edits that do this, and change nothing else.')
    expect(adjustmentInstruction('  pace  ', ' slower ', 'setting')).toContain('pace is: slower')
  })
})
