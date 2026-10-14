import { describe, it, expect } from 'vitest'
import { parseUndoActionCommand } from './undo-action-command.js'

describe('parseUndoActionCommand', () => {
  it('lists with no argument', () => {
    expect(parseUndoActionCommand([])).toEqual({ kind: 'list' })
  })
  it('stages the first argument as the id', () => {
    expect(parseUndoActionCommand(['abc123'])).toEqual({ kind: 'stage', id: 'abc123' })
    expect(parseUndoActionCommand(['abc123', 'extra'])).toEqual({ kind: 'stage', id: 'abc123' })
  })
})
