import { describe, it, expect } from 'vitest'
import { stripMcpToolPrefix, summarizeToolStep } from './tool-step.js'

describe('stripMcpToolPrefix', () => {
  it('strips an mcp__<server>__ prefix down to the bare tool name', () => {
    expect(stripMcpToolPrefix('mcp__file-tools__read_file')).toBe('read_file')
    expect(stripMcpToolPrefix('mcp__file-tools__list_directory')).toBe('list_directory')
  })

  it('leaves an unprefixed (proxy-backend) tool name unchanged', () => {
    expect(stripMcpToolPrefix('read_file')).toBe('read_file')
  })
})

describe('summarizeToolStep', () => {
  it('summarizes each known tool with its relevant input', () => {
    expect(summarizeToolStep('read_file', { path: 'notes.txt' })).toBe('Reading notes.txt')
    expect(summarizeToolStep('list_directory', { path: '.' })).toBe('Listing .')
    expect(summarizeToolStep('write_file', { path: 'out.txt', content: 'x' })).toBe('Proposing a write to out.txt')
    expect(summarizeToolStep('run_shell_command', { command: 'ls -la' })).toBe('Proposing to run: ls -la')
    expect(summarizeToolStep('web_search', { query: 'weather' })).toBe('Searching the web for "weather"')
    expect(summarizeToolStep('fetch_url', { url: 'https://example.com' })).toBe('Fetching https://example.com')
    expect(summarizeToolStep('create_reminder', { text: 'call mom' })).toBe('Creating a reminder')
    expect(summarizeToolStep('list_reminders', {})).toBe('Listing reminders')
  })

  it('falls back to a generic summary for an unrecognized tool', () => {
    expect(summarizeToolStep('some_future_tool', {})).toBe('Calling some_future_tool')
  })
})
