import { describe, it, expect } from 'vitest'
import type { ChatMessage } from '@buildaharness/runtime'
import { DEFAULT_CONFIG } from './config.js'
import { formatHelp, formatStatus, formatMemorySummary, formatMemoryExport, defaultMemoryExportFilename, formatSearchResults, formatTranscriptMarkdown, defaultExportFilename, formatCostSummary, formatDoctorReport, CLI_COMMANDS_HELP } from './cli-session.js'
import type { MemorySummary, MemoryExport, TranscriptSearchHit } from './assistant.js'
import type { UndoLogEntry } from './action-snapshot.js'

describe('formatHelp', () => {
  it('lists every command', () => {
    const output = formatHelp()
    for (const { command } of CLI_COMMANDS_HELP) {
      expect(output).toContain(command)
    }
  })

  it('includes all 18 commands documented for this plan', () => {
    expect(CLI_COMMANDS_HELP.map((c) => c.command)).toEqual([
      '/help', '/clear (/new)', '/status', '/export [file]', '/undo', '/undo-action [id]', '/memory',
      '/memory export [file]', '/search <query>', '/model [name]', '/cost', '/doctor', '/why', '/layers',
      '/sources', '/plan', '/config ...', '/checkpoint [clear]',
    ])
  })
})

describe('formatStatus', () => {
  it('redacts authToken/braveApiKey the same way formatConfigListing already does', () => {
    const output = formatStatus({
      config: { ...DEFAULT_CONFIG, authToken: 'super-secret-token' },
      overriddenKeys: new Set(),
      transcriptLength: 0,
      planActive: false,
    })
    expect(output).not.toContain('super-secret-token')
    expect(output).toContain('********')
  })

  it('reports transcript length and plan status', () => {
    const output = formatStatus({
      config: DEFAULT_CONFIG,
      overriddenKeys: new Set(),
      transcriptLength: 4,
      planActive: true,
    })
    expect(output).toContain('4 messages this session')
    expect(output).toContain('yes (see /plan)')
  })

  it('singularizes "message" for exactly one transcript entry', () => {
    const output = formatStatus({
      config: DEFAULT_CONFIG,
      overriddenKeys: new Set(),
      transcriptLength: 1,
      planActive: false,
    })
    expect(output).toContain('1 message this session')
    expect(output).toContain('none')
  })

  it('marks env-pinned fields', () => {
    const output = formatStatus({
      config: DEFAULT_CONFIG,
      overriddenKeys: new Set(['enableShell']),
      transcriptLength: 0,
      planActive: false,
    })
    expect(output).toContain('env-pinned: ASSISTANT_ENABLE_SHELL')
  })

  it('omits the undo-log line entirely when undoLogEntries is not supplied (T6)', () => {
    const output = formatStatus({
      config: DEFAULT_CONFIG,
      overriddenKeys: new Set(),
      transcriptLength: 0,
      planActive: false,
    })
    expect(output).not.toContain('undo-log')
  })

  it('reports undo-log entry and revertible counts when supplied (T6)', () => {
    const entries: UndoLogEntry[] = [
      { id: '1', appliedActionId: 'a1', kind: 'write', path: '/f.txt', previousContent: 'old', appliedAt: '2026-01-01T00:00:00.000Z', undoable: true },
      { id: '2', appliedActionId: 'a2', kind: 'write', path: '/g.bin', appliedAt: '2026-01-01T00:00:00.000Z', undoable: false, reason: 'existing file is binary, cannot capture its prior content' },
    ]
    const output = formatStatus({
      config: DEFAULT_CONFIG,
      overriddenKeys: new Set(),
      transcriptLength: 0,
      planActive: false,
      undoLogEntries: entries,
    })
    expect(output).toContain('2 entries (1 revertible) — see /undo-action')
  })

  it('singularizes "entry" for exactly one undo-log entry (T6)', () => {
    const entries: UndoLogEntry[] = [
      { id: '1', appliedActionId: 'a1', kind: 'write', path: '/f.txt', previousContent: null, appliedAt: '2026-01-01T00:00:00.000Z', undoable: true },
    ]
    const output = formatStatus({
      config: DEFAULT_CONFIG,
      overriddenKeys: new Set(),
      transcriptLength: 0,
      planActive: false,
      undoLogEntries: entries,
    })
    expect(output).toContain('1 entry (1 revertible) — see /undo-action')
  })
})

describe('formatMemorySummary', () => {
  it('renders "None yet" for empty facts, reminders, and experience content', () => {
    const summary: MemorySummary = {
      facts: [],
      reminders: [],
      experience: { strategyWeights: {}, decompositions: [], recoverySequences: [] },
    }
    const output = formatMemorySummary(summary)
    expect(output).toContain('None yet')
  })

  it('renders real strategy-weight keys/values, not just a count', () => {
    const summary: MemorySummary = {
      facts: [],
      reminders: [],
      experience: { strategyWeights: { 'decompose:timeout': 0.825, 'retry:network_error': 0.4 }, decompositions: [], recoverySequences: [] },
    }
    const output = formatMemorySummary(summary)
    expect(output).toContain('decompose:timeout: 0.825')
    expect(output).toContain('retry:network_error: 0.400')
  })

  it('renders populated facts, reminders, decomposition, and recovery-sequence content', () => {
    const summary: MemorySummary = {
      facts: [{ text: 'My name is Ali.', extractedAt: '2026-01-01T00:00:00.000Z', sourceTurn: 'turn:test', durable: true }],
      reminders: [
        { id: '1', rawText: 'Call mom', createdAt: '2026-01-01T00:00:00.000Z', dueAt: null, done: false },
        { id: '2', rawText: 'Buy milk', createdAt: '2026-01-01T00:00:00.000Z', dueAt: null, done: true },
      ],
      experience: {
        strategyWeights: { 'decompose:timeout': 0.5 },
        decompositions: [{ task_type: 'research', decomposition: ['search', 'summarize'], success_rate: 0.9 }],
        recoverySequences: [{ failure_class: 'timeout', strategy_sequence: ['retry', 'escalate'], success_rate: 0.75 }],
      },
    }
    const output = formatMemorySummary(summary)
    expect(output).toContain('My name is Ali.')
    expect(output).toContain('Call mom')
    expect(output).toContain('Buy milk (done)')
    expect(output).toContain('research: search → summarize (90% success)')
    expect(output).toContain('timeout: retry → escalate (75% success)')
  })
})

describe('formatMemoryExport', () => {
  it('produces valid JSON containing every learned-experience category plus facts/reminders', () => {
    const data: MemoryExport = {
      exportedAt: '2026-01-01T00:00:00.000Z',
      facts: [{ text: 'My name is Ali.', extractedAt: '2026-01-01T00:00:00.000Z', sourceTurn: 'turn:test', durable: true }],
      reminders: [{ id: '1', rawText: 'Call mom', createdAt: '2026-01-01T00:00:00.000Z', dueAt: null, done: false }],
      experience: {
        strategy_weights: { 'decompose:timeout': 0.5 },
        class_priors: { timeout: 0.2 },
        decompositions: [{ task_type: 'research', decomposition: ['search'], success_rate: 0.9 }],
        tool_workflows: [{ tool_id: 'web_search', workflow_steps: ['query', 'fetch'], success_rate: 0.8 }],
        verification_plans: [{ task_type: 'research', layers: ['consistency'], success_rate: 0.7 }],
        recovery_sequences: [{ failure_class: 'timeout', strategy_sequence: ['retry'], success_rate: 0.6 }],
      },
    }
    const output = formatMemoryExport(data)
    const parsed = JSON.parse(output)
    expect(parsed.facts).toHaveLength(1)
    expect(parsed.reminders).toHaveLength(1)
    expect(parsed.experience.strategy_weights).toEqual({ 'decompose:timeout': 0.5 })
    expect(parsed.experience.decompositions).toHaveLength(1)
    expect(parsed.experience.tool_workflows).toHaveLength(1)
    expect(parsed.experience.verification_plans).toHaveLength(1)
    expect(parsed.experience.recovery_sequences).toHaveLength(1)
  })
})

describe('defaultMemoryExportFilename', () => {
  it('produces a filesystem-safe .json filename from the given date', () => {
    const name = defaultMemoryExportFilename(new Date('2026-01-01T12:34:56.000Z'))
    expect(name).toBe('assistant-memory-2026-01-01T12-34-56-000Z.json')
  })
})

// T3: /search <query> result formatting — see
// plans/personal_assistant_memory_transparency_search_plan.html.
describe('formatSearchResults', () => {
  it('returns an explicit "no results" message for an empty hit list, never a blank output', () => {
    const output = formatSearchResults([], 'dentist appointment')
    expect(output).toContain('No results')
    expect(output).toContain('dentist appointment')
  })

  it('renders each hit with session id, timestamp, role, and a content snippet', () => {
    const hits: TranscriptSearchHit[] = [
      { sessionId: 'session-abc123', role: 'user', content: 'I have a dentist appointment next week', at: '2026-01-01T00:00:00.000Z', score: 1.0 },
    ]
    const output = formatSearchResults(hits, 'dentist')
    expect(output).toContain('session-')
    expect(output).toContain('2026-01-01T00:00:00.000Z')
    expect(output).toContain('user')
    expect(output).toContain('dentist appointment')
  })

  it('preserves the given hit order (caller is responsible for ranking)', () => {
    const hits: TranscriptSearchHit[] = [
      { sessionId: 's1', role: 'user', content: 'first hit', at: '2026-01-01T00:00:00.000Z', score: 1.0 },
      { sessionId: 's1', role: 'assistant', content: 'second hit', at: '2026-01-01T00:00:01.000Z', score: 0.5 },
    ]
    const output = formatSearchResults(hits, 'hit')
    expect(output.indexOf('first hit')).toBeLessThan(output.indexOf('second hit'))
  })

  it('truncates a long message to a snippet around the matching term rather than dumping the whole content', () => {
    const longContent = `${'padding '.repeat(40)}dentist appointment${' more padding'.repeat(40)}`
    const hits: TranscriptSearchHit[] = [{ sessionId: 's1', role: 'user', content: longContent, at: '2026-01-01T00:00:00.000Z', score: 1.0 }]
    const output = formatSearchResults(hits, 'dentist appointment')
    expect(output.length).toBeLessThan(longContent.length)
    expect(output).toContain('dentist appointment')
  })
})

describe('formatTranscriptMarkdown', () => {
  it('renders an empty transcript as an empty string', () => {
    expect(formatTranscriptMarkdown([])).toBe('')
  })

  it('renders user/assistant turns as markdown, oldest first', () => {
    const transcript: ChatMessage[] = [
      { role: 'user', content: 'Hello there' },
      { role: 'assistant', content: 'Hi! How can I help?' },
    ]
    expect(formatTranscriptMarkdown(transcript)).toBe('**You:** Hello there\n\n**Assistant:** Hi! How can I help?')
  })

  it('filters out non-user/assistant roles defensively', () => {
    const transcript: ChatMessage[] = [
      { role: 'system', content: 'system prompt' },
      { role: 'user', content: 'hi' },
    ]
    expect(formatTranscriptMarkdown(transcript)).toBe('**You:** hi')
  })
})

describe('defaultExportFilename', () => {
  it('produces a filesystem-safe .md filename with no colons or dots besides the extension', () => {
    const filename = defaultExportFilename(new Date('2026-07-06T22:17:16.123Z'))
    expect(filename).toBe('assistant-transcript-2026-07-06T22-17-16-123Z.md')
    expect(filename.slice(0, -3)).not.toContain(':')
  })
})

describe('formatCostSummary', () => {
  it('reports "no usage yet" when nothing has happened this session', () => {
    const output = formatCostSummary({ session: { inputTokens: 0, outputTokens: 0 }, backend: 'proxy' })
    expect(output).toBe('No usage yet this session.')
  })

  it('renders last-turn and session totals with token counts', () => {
    const output = formatCostSummary({
      lastTurn: { inputTokens: 312, outputTokens: 148 },
      session: { inputTokens: 1204, outputTokens: 601 },
      backend: 'proxy',
    })
    expect(output).toContain('Last turn:    312 in / 148 out tokens')
    expect(output).toContain('This session: 1,204 in / 601 out tokens')
  })

  it('shows the real-cost caveat on the claude-cli backend', () => {
    const output = formatCostSummary({
      lastTurn: { inputTokens: 100, outputTokens: 50, costUsd: 0.002 },
      session: { inputTokens: 100, outputTokens: 50, costUsd: 0.002 },
      backend: 'claude-cli',
    })
    expect(output).toContain('(~$0.0020)')
    expect(output).toContain('real usage from your Claude Code session')
  })

  it('shows the approximate-estimate caveat on the proxy backend only when a cost is present', () => {
    const withCost = formatCostSummary({
      session: { inputTokens: 100, outputTokens: 50, costUsd: 0.001 },
      backend: 'proxy',
    })
    expect(withCost).toContain('approximate estimate from a static pricing table')

    const withoutCost = formatCostSummary({
      session: { inputTokens: 100, outputTokens: 50 },
      backend: 'proxy',
    })
    expect(withoutCost).not.toContain('approximate estimate')
  })

  it('omits the "Last turn" line when lastTurn is absent', () => {
    const output = formatCostSummary({ session: { inputTokens: 10, outputTokens: 5 }, backend: 'proxy' })
    expect(output).not.toContain('Last turn')
    expect(output).toContain('This session:')
  })
})

describe('formatDoctorReport', () => {
  it('renders a passing check with a checkmark and no detail', () => {
    const output = formatDoctorReport([{ label: 'proxy reachable', ok: true }])
    expect(output).toBe('  ✓ proxy reachable')
  })

  it('renders a failing check with an X and its detail', () => {
    const output = formatDoctorReport([{ label: 'proxy reachable', ok: false, detail: 'timed out' }])
    expect(output).toBe('  ✗ proxy reachable — timed out')
  })

  it('renders a mix of passing and failing checks, one per line', () => {
    const output = formatDoctorReport([
      { label: 'proxy reachable', ok: true },
      { label: 'workspace root exists', ok: false, detail: 'not found' },
    ])
    expect(output).toBe('  ✓ proxy reachable\n  ✗ workspace root exists — not found')
  })

  it('omits detail on a passing check even if one is supplied', () => {
    const output = formatDoctorReport([{ label: 'ok check', ok: true, detail: 'should not appear' }])
    expect(output).not.toContain('should not appear')
  })
})
