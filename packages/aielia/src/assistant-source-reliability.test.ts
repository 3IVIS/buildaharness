import { describe, it, expect, afterEach } from 'vitest'
import type { FsBackend } from '@buildaharness/runtime'
import { PersonalAssistant } from './assistant.js'
import { createScriptedLLMClient } from './scripted-llm-client.js'
import { lowerConfidenceSourceLines } from './source-reliability.js'

// AUDIT_SEMANTIC_SOURCE_RELIABILITY through the real turn loop: the assessment must reach the
// turn's answerClaim (what chat-ui's "Why?" panel reads), and a `weighed:false` verdict must make the
// proposer answer again with the note in front of it.

const MARKER = 'You weigh the reliability of the sources an assistant read'
const FLAG = 'AUDIT_SEMANTIC_SOURCE_RELIABILITY'
const assessment = (weighed: boolean) =>
  JSON.stringify({
    assessments: [
      { path: 'notes.md', reliability: 'LOW', reason: 'secondhand standup notes' },
      { path: 'values.yaml', reliability: 'HIGH', reason: 'pipeline-generated' },
    ],
    weighed,
    ...(weighed ? {} : { note: 'Prefer values.yaml.' }),
  })

function backend(): FsBackend {
  const files = new Map<string, string>([
    ['/ws/notes.md', 'port: 8080\n'],
    ['/ws/values.yaml', 'listen_port: 9443\n'],
  ])
  return {
    async readTextFile(path) { return files.get(path) },
    async writeTextFile(path, contents) { files.set(path, contents) },
    async removeFile(path) { files.delete(path) },
    async mkdir() {},
    async readDir() { return [] },
  }
}

function assistant(weighed: boolean, answers: string[]) {
  return new PersonalAssistant({
    llmClient: createScriptedLLMClient({
      responses: [
        { content: '', toolCalls: [{ id: 't1', name: 'read_file', input: { path: 'notes.md' } }] },
        { content: '', toolCalls: [{ id: 't2', name: 'read_file', input: { path: 'values.yaml' } }] },
        ...answers,
      ],
      sideResponses: [[MARKER, assessment(weighed)]],
    }),
    fileTools: { backend: backend(), workspaceRoot: '/ws' },
  })
}

const QUESTION = 'Which port does prod listen on? See notes.md and values.yaml.'

describe('source reliability through the assistant', () => {
  afterEach(() => { delete process.env[FLAG] })

  it('flag on: the LOW source reaches answerClaim.evidence and the "Why?" line', async () => {
    process.env[FLAG] = '1'
    const result = await assistant(true, ['Prod listens on 9443; the notes say 8080 but are secondhand.']).turn(QUESTION)
    const ids = result.answerClaim?.evidence.map((e) => `${e.id}=${e.reliability}`) ?? []
    expect(ids).toContain('source-reliability:notes.md=LOW')
    expect(ids).toContain('source-reliability:values.yaml=HIGH')
    expect(lowerConfidenceSourceLines(result.answerClaim!)).toEqual(['Less reliable source: notes.md — secondhand standup notes'])
  })

  it('flag off (negative control): no source-reliability evidence, no line', async () => {
    const result = await assistant(true, ['Prod listens on 9443.']).turn(QUESTION)
    const ids = result.answerClaim?.evidence.map((e) => e.id) ?? []
    expect(ids.filter((id) => id.startsWith('source-reliability:'))).toEqual([])
    expect(lowerConfidenceSourceLines(result.answerClaim!)).toEqual([])
  })

  it('weighed:false: the turn returns the SECOND answer, and the evidence is still recorded', async () => {
    process.env[FLAG] = '1'
    const result = await assistant(false, ['Prod listens on 8080.', 'Prod listens on 9443 (values.yaml); the notes say 8080.']).turn(QUESTION)
    expect(result.reply).toContain('9443')
    expect(result.reply).not.toBe('Prod listens on 8080.')
    expect(lowerConfidenceSourceLines(result.answerClaim!)).toHaveLength(1)
  })
})
