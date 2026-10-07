import { describe, it, expect, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { activityLogEnabled, createActivityLogger } from './activity-log.js'

let dirs: string[] = []
afterEach(() => { dirs.forEach((d) => rmSync(d, { recursive: true, force: true })); dirs = [] })
const tmp = () => { const d = mkdtempSync(join(tmpdir(), 'activity-')); dirs.push(d); return d }

describe('activityLogEnabled', () => {
  it('is off unless ASSISTANT_ACTIVITY_LOG is set to a truthy word', () => {
    expect(activityLogEnabled({})).toBe(false)
    expect(activityLogEnabled({ ASSISTANT_ACTIVITY_LOG: '0' })).toBe(false)
    expect(activityLogEnabled({ ASSISTANT_ACTIVITY_LOG: 'no' })).toBe(false)
    for (const v of ['1', 'true', 'ON', 'yes', 'enabled']) expect(activityLogEnabled({ ASSISTANT_ACTIVITY_LOG: v })).toBe(true)
  })
})

describe('createActivityLogger', () => {
  it('appends one JSON line per entry, in order, creating the directory, with a timestamp', () => {
    const file = join(tmp(), 'nested', 'activity-log.jsonl')
    const log = createActivityLogger(file, () => new Date('2026-10-05T12:00:00Z'))
    log({ kind: 'user_message', sessionId: 's', content: 'hi\nthere' })
    log({ kind: 'tool_call', sessionId: 's', content: 'read_file({"path":"a"}) →\nbody' })
    const lines = readFileSync(file, 'utf8').trimEnd().split('\n').map((l) => JSON.parse(l))
    expect(lines).toEqual([
      { at: '2026-10-05T12:00:00.000Z', sessionId: 's', kind: 'user_message', content: 'hi\nthere' },
      { at: '2026-10-05T12:00:00.000Z', sessionId: 's', kind: 'tool_call', content: 'read_file({"path":"a"}) →\nbody' },
    ])
  })

  it('tightens a pre-existing world-readable log to owner-only', () => {
    const file = join(tmp(), 'log.jsonl')
    writeFileSync(file, '', { mode: 0o644 })
    createActivityLogger(file)({ kind: 'note', sessionId: 's', content: 'x' })
    expect(statSync(file).mode & 0o077).toBe(0)
  })

  it('creates the log owner-only (it holds full tool output)', () => {
    const dir = tmp()
    const file = join(dir, 'sub', 'log.jsonl')
    createActivityLogger(file)({ kind: 'note', sessionId: 's', content: 'x' })
    expect(statSync(file).mode & 0o077).toBe(0)
  })

  it('never throws when the file cannot be written', () => {
    const d = tmp()
    writeFileSync(join(d, 'a-file'), 'x')
    const log = createActivityLogger(join(d, 'a-file', 'sub', 'log.jsonl')) // parent is a regular file: ENOTDIR
    const err = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(() => log({ kind: 'user_message', sessionId: 's', content: 'x' })).not.toThrow()
    expect(err).toHaveBeenCalled()
    err.mockRestore()
  })
})
