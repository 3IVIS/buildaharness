import { describe, expect, it } from 'vitest'
import { commentChanges } from './TextNotes'

const open = [{ id: 'a', text: 'One' }, { id: 'b', text: 'Two' }]

describe('commentChanges', () => {
  it('is nothing when the text is as it was', () => {
    expect(commentChanges(open, 'One\n\nTwo')).toEqual({ edit: [], add: [], remove: [] })
  })
  it('rewords, adds after a blank line, and removes what is gone', () => {
    expect(commentChanges(open, 'One!\n\nTwo\n\nThree')).toEqual({ edit: [{ id: 'a', text: 'One!' }], add: ['Three'], remove: [] })
    expect(commentChanges(open, 'One')).toEqual({ edit: [], add: [], remove: ['b'] })
    expect(commentChanges(open, '  ')).toEqual({ edit: [], add: [], remove: ['a', 'b'] })
  })
})
