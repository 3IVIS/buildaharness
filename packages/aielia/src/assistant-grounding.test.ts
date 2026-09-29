import { describe, it, expect } from 'vitest'
import type { FsBackend } from '@buildaharness/runtime'
import { PersonalAssistant } from './assistant.js'
import { createScriptedLLMClient } from './scripted-llm-client.js'

// answerClaim.verification_status may only say `verified` for a reply that was compared against the
// raw tool results (grounding-check.ts). These run the real turn loop with a scripted read_file call.

const GROUNDING_MARKER = "You check whether an assistant's reply is faithful to the raw results"
const FILE = '- Hosting: 412\n- Tooling: 287\nTotal: 4058\n'

function backend(): FsBackend {
  const files = new Map<string, string>([['/ws/q3.md', FILE]])
  return {
    async readTextFile(path) { return files.get(path) },
    async writeTextFile(path, contents) { files.set(path, contents) },
    async removeFile(path) { files.delete(path) },
    async mkdir() {},
    async readDir() { return [] },
  }
}

function assistant(verdict: string, env?: string) {
  if (env === undefined) delete process.env.AUDIT_SEMANTIC_GROUNDING
  else process.env.AUDIT_SEMANTIC_GROUNDING = env
  return new PersonalAssistant({
    llmClient: createScriptedLLMClient({
      responses: [
        { content: '', toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'q3.md' } }] },
        'The Q3 total is 4058.',
      ],
      sideResponses: [[GROUNDING_MARKER, verdict]],
    }),
    fileTools: { backend: backend(), workspaceRoot: '/ws' },
  })
}

describe('answerClaim grounding', () => {
  it('is verified when the reply was grounded in the tool results, and the raw excerpt never reaches the result', async () => {
    const result = await assistant('{"verdict":"grounded"}').turn('What is the Q3 total in q3.md?')
    expect(result.answerClaim?.verification_status).toBe('verified')
    expect(result.sources).toEqual([{ tool: 'read_file', path: 'q3.md' }])
  })

  it('is NOT verified when the reply did not match the tool results, and says why', async () => {
    const result = await assistant('{"verdict":"ungrounded","discrepancy":"the items sum to 699, not 4058"}').turn('What is the Q3 total in q3.md?')
    expect(result.answerClaim?.verification_status).toBe('unverified_attempted')
    expect(result.answerClaim?.grounding_note).toBe('the items sum to 699, not 4058')
  })

  it('AUDIT_SEMANTIC_GROUNDING=off restores the mechanical-only derivation (no grounding call, verified as before)', async () => {
    try {
      const result = await assistant('{"verdict":"ungrounded","discrepancy":"ignored"}', 'off').turn('What is the Q3 total in q3.md?')
      expect(result.answerClaim?.verification_status).toBe('verified')
      expect(result.answerClaim?.grounding_note).toBeUndefined()
    } finally {
      delete process.env.AUDIT_SEMANTIC_GROUNDING
    }
  })
})
