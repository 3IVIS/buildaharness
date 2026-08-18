import { describe, it, expect } from 'vitest'
import { evaluateToolPolicy } from './tool-policy.js'

describe('evaluateToolPolicy', () => {
  it('always requires approval for write_file, regardless of risk hint or control state', () => {
    const result = evaluateToolPolicy({
      toolName: 'write_file',
      riskHint: 'LOW',
      controlState: { permission: 'ALLOW', execution_mode: 'NORMAL', escalation: 'NONE' },
    })
    expect(result.decision).toBe('REQUIRE_APPROVAL')
  })

  it('always requires approval for run_shell_command, regardless of risk hint or control state', () => {
    const result = evaluateToolPolicy({ toolName: 'run_shell_command', riskHint: 'LOW' })
    expect(result.decision).toBe('REQUIRE_APPROVAL')
  })

  it('denies a read-only tool when the harness control state denies it, even with a LOW risk hint', () => {
    const result = evaluateToolPolicy({
      toolName: 'web_search',
      riskHint: 'LOW',
      controlState: { permission: 'DENY', execution_mode: 'RECOVERY', escalation: 'NONE' },
    })
    expect(result.decision).toBe('DENY')
  })

  it('requires approval when the control state has escalated to HUMAN_REQUIRED', () => {
    const result = evaluateToolPolicy({
      toolName: 'fetch_url',
      riskHint: 'LOW',
      controlState: { permission: 'ALLOW', execution_mode: 'CAUTIOUS', escalation: 'HUMAN_REQUIRED' },
    })
    expect(result.decision).toBe('REQUIRE_APPROVAL')
  })

  it('requires approval when the control state has escalated to SYSTEM_BREAKING', () => {
    const result = evaluateToolPolicy({
      toolName: 'read_file',
      riskHint: 'LOW',
      controlState: { permission: 'ALLOW', execution_mode: 'CAUTIOUS', escalation: 'SYSTEM_BREAKING' },
    })
    expect(result.decision).toBe('REQUIRE_APPROVAL')
  })

  it('requires approval on a fail-safe UNKNOWN risk hint even with no control state yet', () => {
    const result = evaluateToolPolicy({ toolName: 'web_search', riskHint: 'UNKNOWN' })
    expect(result.decision).toBe('REQUIRE_APPROVAL')
  })

  it('allows a read-only tool at the pre-evidence baseline (no control state yet)', () => {
    const result = evaluateToolPolicy({ toolName: 'list_files', riskHint: 'MEDIUM' })
    expect(result.decision).toBe('ALLOW')
  })

  it('allows a read-only tool when the control state permits it', () => {
    const result = evaluateToolPolicy({
      toolName: 'web_search',
      riskHint: 'HIGH',
      controlState: { permission: 'ALLOW', execution_mode: 'NORMAL', escalation: 'NONE' },
    })
    expect(result.decision).toBe('ALLOW')
  })

  it('a real DENY control state overrides a LOW risk hint (risk hint is advisory, not the gate)', () => {
    const result = evaluateToolPolicy({
      toolName: 'web_search',
      riskHint: 'LOW',
      controlState: { permission: 'DENY', execution_mode: 'RECOVERY', escalation: 'NONE' },
    })
    expect(result.decision).toBe('DENY')
  })
})
