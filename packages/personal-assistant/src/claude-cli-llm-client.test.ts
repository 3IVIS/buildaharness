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

  it('callChatStructured throws when tools are supplied without fileTools/shellTools configured', async () => {
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
      // No remindersFile was configured on this client — REMINDERS_FILE must stay absent
      // rather than present-but-undefined, so the MCP server's own env-var check (a plain
      // `if (remindersFile)`) sees it as truly unset.
      expect(mcpConfig.mcpServers['file-tools'].env.REMINDERS_FILE).toBeUndefined()
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('passes REMINDERS_FILE through --mcp-config when remindersFile is configured', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'cli-llm-test-'))
    try {
      spawnMock.mockImplementation(() => fakeClaudeProcess(JSON.stringify({ result: 'reminder set' })))
      const client = new ClaudeCliLLMClient({ fileTools: { workspaceRoot }, remindersFile: '/data/reminders/reminders.json' })

      await client.callChatStructured(
        [{ role: 'user', content: 'remind me to call mom' }],
        [{ name: 'create_reminder', input_schema: {} }],
      )

      const args = spawnMock.mock.calls[0][1] as string[]
      const mcpConfig = JSON.parse(args[args.indexOf('--mcp-config') + 1]) as {
        mcpServers: Record<string, { env: Record<string, string> }>
      }
      expect(mcpConfig.mcpServers['file-tools'].env.REMINDERS_FILE).toBe('/data/reminders/reminders.json')
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('detects a write staged by the MCP server during the call and surfaces it as a __staged_action tool call, not write_file', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'cli-llm-test-'))
    try {
      spawnMock.mockImplementation(() => {
        const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
        proc.stdout = new EventEmitter()
        proc.stderr = new EventEmitter()
        void (async () => {
          // Simulate the MCP server (running inside the claude subprocess) staging a write mid-call.
          const dir = join(workspaceRoot, '.pending-actions')
          await mkdir(dir, { recursive: true })
          await writeFile(
            join(dir, 'abc-123.json'),
            JSON.stringify({ id: 'abc-123', kind: 'write', path: 'summary.md', content: 'draft summary', stagedAt: new Date().toISOString() }),
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
      expect(result.toolCalls?.[0].name).toBe('__staged_action')
      expect(result.toolCalls?.[0].input).toMatchObject({ id: 'abc-123', kind: 'write', path: 'summary.md', content: 'draft summary' })
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('returns plain text content when no action was staged during the call', async () => {
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

  it('shellTools configured adds ENABLE_SHELL_TOOLS to the MCP config, not to --tools', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'cli-llm-test-'))
    try {
      spawnMock.mockImplementation(() => fakeClaudeProcess(JSON.stringify({ result: 'listed files' })))
      const client = new ClaudeCliLLMClient({ shellTools: { workspaceRoot } })

      await client.callChatStructured(
        [{ role: 'user', content: 'list files here' }],
        [{ name: 'run_shell_command', input_schema: {} }],
      )

      const args = spawnMock.mock.calls[0][1] as string[]
      expect(args[args.indexOf('--tools') + 1]).toBe('')
      const mcpConfig = JSON.parse(args[args.indexOf('--mcp-config') + 1]) as {
        mcpServers: Record<string, { env: Record<string, string>; args: string[] }>
      }
      expect(mcpConfig.mcpServers['file-tools'].env.WORKSPACE_ROOT).toBe(workspaceRoot)
      expect(mcpConfig.mcpServers['file-tools'].env.ENABLE_SHELL_TOOLS).toBe('1')
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('a shell command staged by the MCP server mid-call is detected and surfaced as __staged_action with kind: shell', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'cli-llm-test-'))
    try {
      spawnMock.mockImplementation(() => {
        const proc = new EventEmitter() as EventEmitter & { stdout: EventEmitter; stderr: EventEmitter }
        proc.stdout = new EventEmitter()
        proc.stderr = new EventEmitter()
        void (async () => {
          const dir = join(workspaceRoot, '.pending-actions')
          await mkdir(dir, { recursive: true })
          await writeFile(
            join(dir, 'shell-1.json'),
            JSON.stringify({ id: 'shell-1', kind: 'shell', command: 'ls -la', cwd: workspaceRoot, stagedAt: new Date().toISOString() }),
          )
          proc.stdout.emit('data', Buffer.from(JSON.stringify({ result: '' })))
          proc.emit('close', 0)
        })()
        return proc
      })

      const client = new ClaudeCliLLMClient({ shellTools: { workspaceRoot } })
      const result = await client.callChatStructured(
        [{ role: 'user', content: 'list files here' }],
        [{ name: 'run_shell_command', input_schema: {} }],
      )

      expect(result.toolCalls).toHaveLength(1)
      expect(result.toolCalls?.[0].name).toBe('__staged_action')
      expect(result.toolCalls?.[0].input).toMatchObject({ id: 'shell-1', kind: 'shell', command: 'ls -la', cwd: workspaceRoot })
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })

  it('invariant: Bash never appears in --tools under any combination of fileTools/shellTools/remindersFile', async () => {
    const workspaceRoot = await mkdtemp(join(tmpdir(), 'cli-llm-test-'))
    try {
      spawnMock.mockImplementation(() => fakeClaudeProcess(JSON.stringify({ result: 'ok' })))

      const configs = [
        { fileTools: { workspaceRoot } },
        { shellTools: { workspaceRoot } },
        { fileTools: { workspaceRoot }, remindersFile: join(workspaceRoot, 'reminders', 'reminders.json') },
        { fileTools: { workspaceRoot }, shellTools: { workspaceRoot } },
      ]

      for (const config of configs) {
        spawnMock.mockClear()
        const client = new ClaudeCliLLMClient(config)
        await client.callChatStructured([{ role: 'user', content: 'hi' }], [{ name: 'read_file', input_schema: {} }])
        const args = spawnMock.mock.calls[0][1] as string[]
        const toolsValue = args[args.indexOf('--tools') + 1]
        expect(toolsValue).not.toMatch(/\bBash\b/)
      }
    } finally {
      await rm(workspaceRoot, { recursive: true, force: true })
    }
  })
})
