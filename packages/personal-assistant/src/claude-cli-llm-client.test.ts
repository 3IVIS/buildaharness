import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventEmitter } from 'node:events'
import { mkdtemp, writeFile, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const spawnMock = vi.fn()
vi.mock('node:child_process', () => {
  const spawn = (...args: unknown[]) => spawnMock(...args)
  // Both named and default exports: the root (jsdom) vitest config's module
  // interop expects a "default" export on a mocked node builtin, which a
  // package-scoped run doesn't require — without it: "[vitest] No 'default'
  // export is defined on the 'node:child_process' mock."
  return { spawn, default: { spawn } }
})

const { ClaudeCliLLMClient } = await import('./claude-cli-llm-client.js')

/** A fake child_process handle: emits stdout then 'close' on the next microtask, standing in for a real `claude -p` subprocess. */
function fakeClaudeProcess(stdout: string, exitCode = 0): EventEmitter & { stdout: EventEmitter; stderr: EventEmitter } {
  const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
  proc.stdout = new EventEmitter()
  proc.stderr = new EventEmitter()
  queueMicrotask(() => {
    proc.stdout.emit('data', Buffer.from(stdout))
    proc.emit('close', exitCode)
  })
  return proc
}

describe('ClaudeCliLLMClient', () => {
  beforeEach(() => {
    spawnMock.mockReset()
  })

  it('callChatSync still passes --tools "" exactly as before, regardless of fileTools', async () => {
    spawnMock.mockImplementation(() => fakeClaudeProcess(JSON.stringify({ result: 'hi there' })))
    const client = new ClaudeCliLLMClient({ fileTools: { workspaceRoot: '/workspace' } })

    const result = await client.callChatSync([{ role: 'user', content: 'hello' }])

    expect(result).toBe('hi there')
    const args = spawnMock.mock.calls[0][1] as string[]
    expect(args).toContain('--tools')
    expect(args[args.indexOf('--tools') + 1]).toBe('')
    expect(args).not.toContain('--mcp-config')
  })

  it('callChatStructured with no tools delegates to a plain chat call', async () => {
    spawnMock.mockImplementation(() => fakeClaudeProcess(JSON.stringify({ result: 'plain reply' })))
    const client = new ClaudeCliLLMClient()

    const result = await client.callChatStructured([{ role: 'user', content: 'hi' }])

    expect(result).toEqual({ content: 'plain reply' })
    expect(spawnMock).toHaveBeenCalledTimes(1)
  })

  it('callChatStructured throws when tools are supplied without fileTools configured', async () => {
    const client = new ClaudeCliLLMClient()

    await expect(
      client.callChatStructured([{ role: 'user', content: 'hi' }], [{ name: 'read_file', input_schema: {} }]),
    ).rejects.toThrow(/fileTools/)
    expect(spawnMock).not.toHaveBeenCalled()
  })

  it('callChatStructured with fileTools configured passes --mcp-config, --strict-mcp-config, --dangerously-skip-permissions, and still --tools ""', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'cli-llm-test-'))
    try {
      spawnMock.mockImplementation(() => fakeClaudeProcess(JSON.stringify({ result: 'read the file for you' })))
      const client = new ClaudeCliLLMClient({ fileTools: { workspaceRoot } })

      const result = await client.callChatStructured(
        [{ role: 'user', content: 'read notes.txt' }],
        [{ name: 'read_file', input_schema: {} }],
      )

      expect(result).toEqual({ content: 'read the file for you' })
      const args = spawnMock.mock.calls[0][1] as string[]
      expect(args).toContain('--mcp-config')
      expect(args).toContain('--strict-mcp-config')
      expect(args).toContain('--dangerously-skip-permissions')
      expect(args).toContain('--tools')
      expect(args[args.indexOf('--tools') + 1]).toBe('')

      const mcpConfig = JSON.parse(args[args.indexOf('--mcp-config') + 1]) as {
        mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>
      }
      expect(mcpConfig.mcpServers['file-tools'].env.WORKSPACE_ROOT).toBe(workspaceRoot)
      expect(mcpConfig.mcpServers['file-tools'].args[0]).toMatch(/file-tools-mcp-server\.mjs$/)
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('detects a write staged by the MCP server during the call and surfaces it as a __staged_write tool call, not write_file', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'cli-llm-test-'))
    try {
      spawnMock.mockImplementation(() => {
        const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
        proc.stdout = new EventEmitter()
        proc.stderr = new EventEmitter()
        void (async () => {
          // Simulate the MCP server (running inside the claude subprocess) staging a write mid-call.
          const dir = join(workspaceRoot, '.pending-writes')
          await mkdir(dir, { recursive: true })
          await writeFile(
            join(dir, 'abc-123.json'),
            JSON.stringify({ id: 'abc-123', path: 'summary.md', content: 'draft summary', stagedAt: new Date().toISOString() }),
          )
          proc.stdout.emit('data', Buffer.from(JSON.stringify({ result: '' })))
          proc.emit('close', 0)
        })()
        return proc
      })

      const client = new ClaudeCliLLMClient({ fileTools: { workspaceRoot } })
      const result = await client.callChatStructured(
        [{ role: 'user', content: 'write a summary' }],
        [{ name: 'write_file', input_schema: {} }],
      )

      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls?.[0].name).toBe('__staged_write')
      expect(result.toolCalls?.[0].input).toMatchObject({ id: 'abc-123', path: 'summary.md', content: 'draft summary' })
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('returns plain text content when no write was staged during the call', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'cli-llm-test-'))
    try {
      spawnMock.mockImplementation(() => fakeClaudeProcess(JSON.stringify({ result: 'here is a summary of the file' })))
      const client = new ClaudeCliLLMClient({ fileTools: { workspaceRoot } })

      const result = await client.callChatStructured(
        [{ role: 'user', content: 'summarize notes.txt' }],
        [{ name: 'read_file', input_schema: {} }],
      )

      expect(result).toEqual({ content: 'here is a summary of the file' })
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})
