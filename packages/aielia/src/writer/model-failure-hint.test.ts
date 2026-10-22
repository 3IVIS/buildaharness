import { describe, expect, it } from 'vitest'
import { CLAUDE_SIGN_IN_HINT, DEFAULT_MODEL_HINT, modelFailureHint } from './model-failure-hint.js'
import { claudeFailureMessage } from '../claude-cli-prompt.js'

describe('model failure hint', () => {
  it('tells the Claude CLI backend to sign in (it has no key to check) and every other backend to check the key and model', () => {
    expect(modelFailureHint('claude-cli')).toBe(CLAUDE_SIGN_IN_HINT)
    expect(modelFailureHint('anthropic')).toBe(DEFAULT_MODEL_HINT)
    expect(modelFailureHint(undefined)).toBe(DEFAULT_MODEL_HINT)
  })
})

describe('claude failure message', () => {
  it('prefers stderr, then the result in the JSON on stdout, then the exit code', () => {
    expect(claudeFailureMessage('{"is_error":true,"result":"ignored"}', ' boom \n', 1)).toBe('boom')
    expect(claudeFailureMessage('{"is_error":true,"result":"Not logged in · Please run /login"}', '', 1)).toBe('Not logged in · Please run /login')
    expect(claudeFailureMessage('not json', '', 2)).toBe('claude exited with code 2')
    expect(claudeFailureMessage('', '', null)).toBe('claude exited with code null')
  })
})
