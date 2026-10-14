import { describe, it, expect } from 'vitest'
import { parseProjectCommand } from './project-command.js'

describe('parseProjectCommand', () => {
  it('shows the current project, or (none)', () => {
    expect(parseProjectCommand([], '/ws')).toEqual({ kind: 'show', message: '/ws' })
    expect(parseProjectCommand([], undefined)).toEqual({ kind: 'show', message: '(none)' })
    expect(parseProjectCommand([], '')).toEqual({ kind: 'show', message: '(none)' })
  })
  it('clears on "clear"', () => {
    expect(parseProjectCommand(['clear'], 'x').kind).toBe('clear')
  })
  it('sets a name, joining words', () => {
    expect(parseProjectCommand(['my', 'app'], undefined)).toEqual({ kind: 'set', project: 'my app', message: 'Active project: my app' })
  })
})
