import { describe, expect, it } from 'vitest'
import { changedRange, checklistAt, elapsedText, stageSentence, workPlan } from './work-progress.js'

describe('work progress', () => {
  it('marks earlier steps done, the current one current and the rest waiting', () => {
    const items = checklistAt(workPlan('edit'), 1)
    expect(items.map((i) => i.state)).toEqual(['done', 'current', 'waiting'])
  })
  it('marks everything done past the last step', () => {
    expect(checklistAt(workPlan('answer'), 9).every((i) => i.state === 'done')).toBe(true)
  })
  it('says the current stage in a sentence, clamped to the plan', () => {
    expect(stageSentence(workPlan('answer'), 1)).toBe('Writing the answer…')
    expect(stageSentence(workPlan('answer'), 7)).toBe('Writing the answer…')
    expect(stageSentence(workPlan('other'), 0)).toBeUndefined()
  })
  it('names the middle step of a change after the action', () => {
    expect(workPlan('change', 'Saving the version').steps).toEqual(['Saving your text', 'Saving the version', 'Updating the article'])
  })
  it('shows elapsed time only after a few seconds', () => {
    expect(elapsedText(3999)).toBeUndefined()
    expect(elapsedText(12_300)).toBe('12s')
    expect(elapsedText(125_000)).toBe('2m 05s')
  })
  it('finds the passage that changed between two texts', () => {
    expect(changedRange('One. Two. Three.', 'One. Twenty. Three.')).toEqual({ start: 7, end: 11 })
    expect(changedRange('abc', 'abc')).toBeNull()
    expect(changedRange('One. Two.', 'One.')).toBeNull()
    expect(changedRange('', 'New text')).toEqual({ start: 0, end: 8 })
  })
})
