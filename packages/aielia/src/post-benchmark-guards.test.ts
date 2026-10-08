import { describe, it, expect } from 'vitest'
import { actionRecordSuffix, containsActionRecord, stripActionRecord } from './action-record.js'
import { fallbackFinalReply } from './agent-loop.js'
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

describe('empty final reply (C5)', () => {
  it('falls back to the recorded actions', () => {
    expect(fallbackFinalReply(['wrote a.py'])).toContain('wrote a.py')
  })
  it('says so when there is neither a reply nor an action', () => {
    expect(fallbackFinalReply(undefined)).toContain('could not produce an answer')
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
  const clean = { claimsUnrecordedWork: false, promisesWorkNotDone: false, unverifiedOutsideFacts: false, contradictsCommandOutput: false, contradictsRecordedWork: false, leaksSelfCorrection: false }
  it('names what was recorded and picks the nudge by finding', async () => {
    const { auditRetryNudge } = await import('./reply-audit.js')
    expect(auditRetryNudge(clean, [])).toBeUndefined()
    expect(auditRetryNudge({ ...clean, claimsUnrecordedWork: true }, ['ran `ls` (exit code 0)'])).toContain('only this was carried out this turn: ran `ls`')
    expect(auditRetryNudge({ ...clean, claimsUnrecordedWork: true }, [])).toContain('no write or command was carried out')
    expect(auditRetryNudge({ ...clean, promisesWorkNotDone: true }, ['wrote a.py'])).toContain('announcement of work to come')
    expect(auditRetryNudge({ ...clean, contradictsCommandOutput: true }, [])).toContain('do not match what the command actually printed')
    // The correction names what was recorded, so it cannot talk the model into disowning real work (scenario 05, turn 5).
    expect(auditRetryNudge({ ...clean, contradictsCommandOutput: true }, ['wrote README.md'])).toContain('only this was carried out this turn: wrote README.md')
    expect(auditRetryNudge({ ...clean, contradictsCommandOutput: true }, ['wrote README.md'])).toContain('Do not deny or withdraw work that is in that record')
    expect(auditRetryNudge({ ...clean, leaksSelfCorrection: true }, ['wrote README.md'])).toContain('wrote README.md')
    // The correction is anchored to the user's request and says the check is not from the user (scenario 03 turn 1: the retry argued with the nudge as if it were a user rule).
    const anchored = auditRetryNudge({ ...clean, leaksSelfCorrection: true }, [], 'review my uncommitted changes\nfor correctness')!
    expect(anchored).toContain('automatic and is not from the user')
    expect(anchored).toContain('"review my uncommitted changes for correctness"')
    expect(auditRetryNudge(clean, [], 'anything')).toBeUndefined()
    expect(auditRetryNudge({ ...clean, claimsUnrecordedWork: true }, [])).not.toContain('not from the user')
    expect(auditRetryNudge({ ...clean, unverifiedOutsideFacts: true }, [])).toContain('outside sources')
    expect(auditRetryNudge({ ...clean, contradictsRecordedWork: true }, ['wrote a.py'])).toContain('was in fact done')
    expect(auditRetryNudge({ ...clean, contradictsRecordedWork: true }, ['wrote a.py'])).toContain('wrote a.py')
    expect(auditRetryNudge({ ...clean, leaksSelfCorrection: true }, [])).toContain('one clean answer')
  })
})
