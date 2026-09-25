import { describe, it, expect } from 'vitest'
import { deriveConsequentialTools } from '@buildaharness/harness'
import { TOOL_EFFECT_CLASS } from './tool-effect-class.js'

describe('TOOL_EFFECT_CLASS', () => {
  it('derives consequentialTools from effect class, including tools that never reach sources', () => {
    const out = deriveConsequentialTools(Object.keys(TOOL_EFFECT_CLASS), TOOL_EFFECT_CLASS)
    expect([...out].sort()).toEqual(['create_reminder', 'run_shell_command', 'send_email', 'write_file'])
  })
  it('does not treat read-only or outbound-read tools as consequential', () => {
    const out = deriveConsequentialTools(['read_file', 'list_directory', 'web_search', 'fetch_url'], TOOL_EFFECT_CLASS)
    expect(out.size).toBe(0)
  })
})
