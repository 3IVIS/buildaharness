import { describe, it, expect } from 'vitest'
import { PARAMETER_GROUPS, WRITE_PARAMETERS, adjustmentChoices, adjustmentFromText, adjustmentInstruction, findParameter } from './write-parameters.js'

describe('write parameters', () => {
  it('has every aspect once, with options, in a short list of categories', () => {
    const ids = WRITE_PARAMETERS.map((x) => x.id)
    expect(new Set(ids).size).toBe(ids.length)
    expect(WRITE_PARAMETERS.every((x) => x.options.length >= 2 && x.options.every((o) => o.length > 0))).toBe(true)
    expect(PARAMETER_GROUPS.map((g) => g.id)).toEqual(['tone', 'audience', 'length', 'structure', 'seo', 'sources', 'promotion', 'brand', 'revise'])
    for (const g of PARAMETER_GROUPS) expect(WRITE_PARAMETERS.some((x) => x.group === g.id)).toBe(true)
    expect(WRITE_PARAMETERS.every((x) => PARAMETER_GROUPS.some((g) => g.id === x.group))).toBe(true)
  })
  it('keeps options that contain commas and punctuation intact', () => {
    expect(findParameter('article-length')?.options).toContain('Standard (800–1,200 words)')
    expect(findParameter('article-type')?.options).toContain('Problem–solution article')
    expect(findParameter('call-to-action-cta')?.label).toBe('Call to action (CTA)')
  })
  it('marks the one-off actions as revisions and everything else as settings', () => {
    expect(WRITE_PARAMETERS.filter((x) => x.kind === 'revision').every((x) => x.group === 'revise')).toBe(true)
    expect(WRITE_PARAMETERS.filter((x) => x.group === 'revise').every((x) => x.kind === 'revision')).toBe(true)
  })
  it('offers each category as "Aspect: option" suggestions', () => {
    expect(adjustmentChoices('tone')).toContain('Tone of voice: Conversational')
    expect(adjustmentChoices('revise')).toContain('Introduction revision: Shorten')
  })
  it('turns an adjustment into an instruction, for listed and unlisted aspects alike', () => {
    expect(adjustmentInstruction('Tone of voice', 'Conversational', 'setting')).toContain('tone of voice is: Conversational')
    expect(adjustmentInstruction('Introduction revision', 'Shorten', 'revision')).toBe('Introduction revision: Shorten. Suggest the edits that do this, and change nothing else.')
    expect(adjustmentInstruction('  pace  ', ' slower ', 'setting')).toContain('pace is: slower')
  })
  it('reads what was typed: a suggestion keeps its aspect, a value of your own too, other words are the request', () => {
    expect(adjustmentFromText('tone', 'Tone of voice: Conversational')).toContain('tone of voice is: Conversational')
    expect(adjustmentFromText('tone', 'tone of voice: dry but kind')).toContain('tone of voice is: dry but kind')
    expect(adjustmentFromText('tone', 'less like a press release')).toBe('Adjust the article: less like a press release. Suggest the edits that bring the text in line, and change nothing that does not need to change.')
    expect(adjustmentFromText(undefined, 'pacing: slower in the middle')).toContain('Adjust the article: pacing: slower in the middle')
    expect(adjustmentFromText('revise', 'Introduction revision: Shorten')).toBe('Introduction revision: Shorten. Suggest the edits that do this, and change nothing else.')
    expect(adjustmentFromText('revise', 'cut the second section')).toBe('cut the second section. Suggest the edits that do this, and change nothing else.')
  })
})
