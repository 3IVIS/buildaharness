import { describe, it, expect } from 'vitest'
import { actionRecordSuffix, containsActionRecord, stripActionRecord } from './action-record.js'
import { isDanglingAnnouncement, fallbackFinalReply } from './agent-loop.js'
import { commandLooksLikeNetworkRequest } from './shell-tools.js'

describe('action record (N1)', () => {
  it('builds the genuine suffix and strips it again', () => {
    const suffix = actionRecordSuffix(['wrote a.py', 'ran `ls` (exit code 0)'])
    expect(suffix).toContain('actions carried out this turn: wrote a.py; ran `ls` (exit code 0).]')
    expect(containsActionRecord('Done.' + suffix)).toBe(true)
    expect(stripActionRecord('Done.' + suffix)).toBe('Done.')
  })
  it('adds nothing for an empty action list and leaves ordinary text alone', () => {
    expect(actionRecordSuffix([])).toBe('')
    expect(stripActionRecord('Plain [bracketed] text.')).toBe('Plain [bracketed] text.')
  })
})

describe('dangling announcements (C5b)', () => {
  it('detects a reply that only announces the next step', () => {
    expect(isDanglingAnnouncement('Alright, let me verify the final state of the diff:')).toBe(true)
    expect(isDanglingAnnouncement('Checking the result...')).toBe(true)
  })
  it('keeps real summaries', () => {
    expect(isDanglingAnnouncement('Done. I fixed the three issues in storage.py, models.py and handlers.py.')).toBe(false)
    expect(isDanglingAnnouncement('Fixed three bugs. Here is what changed:\n' + 'x'.repeat(300))).toBe(false)
    expect(isDanglingAnnouncement('')).toBe(false)
  })
  it('falls back to the recorded actions', () => {
    expect(fallbackFinalReply(['wrote a.py'])).toContain('wrote a.py')
  })
})

describe('network-looking commands (O1)', () => {
  it('flags package-registry lookups, not local npm or git use', () => {
    expect(commandLooksLikeNetworkRequest('npm view lodash version')).toBe(true)
    expect(commandLooksLikeNetworkRequest('npm show lodash@latest version 2>&1')).toBe(true)
    expect(commandLooksLikeNetworkRequest('/tmp/venv/bin/pip install -r requirements.txt')).toBe(true)
    expect(commandLooksLikeNetworkRequest('curl -s https://registry.npmjs.org/lodash/latest')).toBe(true)
    expect(commandLooksLikeNetworkRequest('npm test')).toBe(false)
    expect(commandLooksLikeNetworkRequest('git push --force origin main')).toBe(false)
    expect(commandLooksLikeNetworkRequest('python3 -m unittest discover')).toBe(false)
  })
})

describe('out of steps (R1)', () => {
  it('has a nudge that asks for a plain-text summary without tools', async () => {
    const { OUT_OF_STEPS_NUDGE } = await import('./agent-loop.js')
    expect(OUT_OF_STEPS_NUDGE).toContain('Do not call any tool')
  })
})

describe('audit retry nudge', () => {
  const clean = { claimsUnrecordedWork: false, promisesWorkNotDone: false, unverifiedOutsideFacts: false, contradictsCommandOutput: false }
  it('names what was recorded and picks the nudge by finding', async () => {
    const { auditRetryNudge } = await import('./reply-audit.js')
    expect(auditRetryNudge(clean, [])).toBeUndefined()
    expect(auditRetryNudge({ ...clean, claimsUnrecordedWork: true }, ['ran `ls` (exit code 0)'])).toContain('only this was carried out this turn: ran `ls`')
    expect(auditRetryNudge({ ...clean, claimsUnrecordedWork: true }, [])).toContain('no write or command was carried out')
    expect(auditRetryNudge({ ...clean, promisesWorkNotDone: true }, ['wrote a.py'])).toContain('announcement of work to come')
    expect(auditRetryNudge({ ...clean, contradictsCommandOutput: true }, [])).toContain('do not match what the command actually printed')
    expect(auditRetryNudge({ ...clean, unverifiedOutsideFacts: true }, [])).toContain('outside sources')
  })
})
