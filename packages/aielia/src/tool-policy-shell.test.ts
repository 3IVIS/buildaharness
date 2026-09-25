import { describe, it, expect } from 'vitest'
import { evaluateToolPolicy } from './tool-policy.js'

/**
 * AL3b regression: run_shell_command stays REQUIRE_APPROVAL for every command, including ones that
 * look read-only. Deciding "this command is a pure read" would require parsing/pattern-matching the
 * command string (a lexical gate, AL-2), and there is no non-linguistic allowlist in the TS runtime
 * (the Python execution_boundary allowlist has no aielia twin). So the decision is "left staged, by
 * design" — see the AL3b note in plans/adaptive_layer_selection_plan.html.
 */
describe('evaluateToolPolicy — run_shell_command (AL3b: left staged by design)', () => {
  it('requires approval regardless of risk hint or a fully permissive control state', () => {
    for (const riskHint of ['LOW', 'MEDIUM', 'HIGH', 'UNKNOWN'] as const) {
      const result = evaluateToolPolicy({
        toolName: 'run_shell_command',
        riskHint,
        controlState: { permission: 'ALLOW', execution_mode: 'NORMAL', escalation: 'NONE' },
      })
      expect(result.decision).toBe('REQUIRE_APPROVAL')
    }
  })

  it('policy takes only the tool name, so a read-only-looking and a mutating command cannot be told apart', () => {
    // evaluateToolPolicy has no command argument by construction: both `find . | wc -l` and
    // `rm -rf build` reach it as the same input and get the same (staged) decision.
    const input = { toolName: 'run_shell_command', riskHint: 'LOW' as const }
    expect(evaluateToolPolicy(input)).toEqual(evaluateToolPolicy(input))
    expect(evaluateToolPolicy(input).decision).toBe('REQUIRE_APPROVAL')
  })
})
