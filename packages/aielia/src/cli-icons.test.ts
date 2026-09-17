import { describe, it, expect } from 'vitest'
import { ICONS, toolStepIcon } from './cli-icons.js'

describe('toolStepIcon', () => {
  it('picks the proposal glyph for write_file and run_shell_command', () => {
    expect(toolStepIcon('write_file')).toBe(ICONS.proposalStep)
    expect(toolStepIcon('run_shell_command')).toBe(ICONS.proposalStep)
  })

  it('picks the routine tool-step glyph for every other tool, including reminders and reads', () => {
    for (const tool of ['read_file', 'list_directory', 'web_search', 'fetch_url', 'create_reminder', 'list_reminders', 'some_unknown_tool']) {
      expect(toolStepIcon(tool)).toBe(ICONS.toolStep)
    }
  })

  it('the two glyphs are distinct', () => {
    expect(ICONS.proposalStep).not.toBe(ICONS.toolStep)
  })
})
