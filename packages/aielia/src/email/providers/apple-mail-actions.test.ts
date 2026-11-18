import { describe, it, expect } from 'vitest'
import { AppleMailActions, RS, US, bareMessageId, explainScriptError, pathArg, type ScriptKind, type ScriptRunner } from './apple-mail-actions.js'
import { EmailProviderError } from '../provider.js'
import type { LocalMessageRef } from './local-mail.js'

const ref = (i: number, over: Partial<LocalMessageRef> = {}): LocalMessageRef => ({ rowid: i, messageIdHeader: `<m${i}@example.net>`, accountId: 'ACCT', mailboxPath: ['INBOX'], ...over })
const fake = (answer: (kind: ScriptKind, args: string[]) => string = () => 'ok:1:0') => {
  const calls: Array<{ kind: ScriptKind; args: string[] }> = []
  const runner: ScriptRunner = { async run(kind, args) { calls.push({ kind, args }); return answer(kind, args) } }
  return { calls, actions: new AppleMailActions(runner) }
}

describe('AppleMailActions', () => {
  it('moves by account, mailbox path and bare Message-ID, one call per group and chunk', async () => {
    const { calls, actions } = fake((_k, a) => `ok:${a.length - 3}:0`)
    const refs = Array.from({ length: 30 }, (_, i) => ref(i))
    await actions.move([...refs, ref(99, { mailboxPath: ['[Gmail]', 'All Mail'] })], ['Archive'])
    expect(calls.map((c) => c.args.length - 3)).toEqual([25, 5, 1])
    expect(calls[0]!.args.slice(0, 3)).toEqual(['ACCT', 'INBOX', 'Archive'])
    expect(calls[0]!.args[3]).toBe('m0@example.net')
    expect(calls[2]!.args[1]).toBe(pathArg(['[Gmail]', 'All Mail']))
    expect(calls[2]!.args[1]).toContain(US)
    expect(calls.every((c) => c.kind === 'move')).toBe(true)
  })
  it('read and flag pass the wanted state as text', async () => {
    const { calls, actions } = fake()
    await actions.setRead([ref(1)], true)
    await actions.setFlagged([ref(1)], false)
    expect(calls.map((c) => [c.kind, c.args[2]])).toEqual([['set_read', 'true'], ['set_flagged', 'false']])
  })
  it('reports messages Mail could not find, and a message without a Message-ID', async () => {
    await expect(fake(() => 'ok:0:1').actions.move([ref(1)], ['Archive'])).rejects.toMatchObject({ code: 'not_found' })
    await expect(fake().actions.move([ref(1, { messageIdHeader: undefined })], ['Archive'])).rejects.toMatchObject({ code: 'invalid_argument' })
    await expect(fake(() => 'garbage').actions.setRead([ref(1)], true)).rejects.toThrow(/does not understand/)
  })
  it('hostile subjects, folder names and bodies travel only as argument values, untouched', async () => {
    const hostile = 'x" & (do shell script "touch /tmp/pwned") & "\n-e tell application "Finder" to quit\\'
    const { calls, actions } = fake()
    await actions.move([ref(1, { mailboxPath: [hostile, 'b'] })], [hostile])
    await actions.createDraft('ACCT', { to: [{ address: 'a@example.com', name: hostile }], cc: [{ address: 'c@example.com' }], subject: hostile, textBody: hostile }, 'me@example.org')
    const [mv, dr] = calls
    expect(mv!.args[1]).toBe(`${hostile}${US}b`)
    expect(mv!.args[2]).toBe(hostile)
    expect(dr!.kind).toBe('create_draft')
    expect(dr!.args).toEqual(['me@example.org', hostile, hostile, `a@example.com${RS}${hostile}`, `c@example.com${RS}`])
    // The adapter has no way to carry script text: its only outputs are an action name from a closed list and string values.
    expect(new Set(calls.map((c) => c.kind)).size).toBeLessThanOrEqual(2)
  })
  it('a draft is saved with no blind copies and is never sent', async () => {
    const { calls, actions } = fake()
    await actions.createDraft('ACCT', { to: [{ address: 'a@example.com' }], bcc: [{ address: 'secret@example.com' }], subject: 's', textBody: 'b' }, 'me@example.org')
    expect(JSON.stringify(calls)).not.toContain('secret@example.com')
    expect(calls.every((c) => c.kind === 'create_draft')).toBe(true)
  })
  it('lists the program\'s accounts', async () => {
    const { actions } = fake(() => 'AAA\tWork\nBBB\tHome mail\n')
    expect(await actions.listAccounts()).toEqual([{ id: 'AAA', name: 'Work' }, { id: 'BBB', name: 'Home mail' }])
  })
})

describe('errors', () => {
  it('turn the short codes into something a person can do', () => {
    expect(explainScriptError('automation_denied').code).toBe('unauthorized')
    expect(explainScriptError('automation_denied').message).toMatch(/Automation/)
    expect(explainScriptError('mail_not_running').message).toMatch(/Open Mail/)
    expect(explainScriptError('script_timeout').code).toBe('unavailable')
    expect(explainScriptError('mail_object_not_found').code).toBe('not_found')
    expect(explainScriptError('unsupported_platform').message).toMatch(/Mac/)
    expect(explainScriptError('script_failed: boom').message).toMatch(/boom/)
    expect(explainScriptError('bad_request: x').code).toBe('invalid_argument')
  })
  it('an automation error from the runner reaches the caller as one', async () => {
    const runner: ScriptRunner = { run: async () => { throw 'automation_denied' } }
    await expect(new AppleMailActions(runner).setRead([ref(1)], true)).rejects.toBeInstanceOf(EmailProviderError)
    expect(bareMessageId(' <a@b> ')).toBe('a@b')
  })
})
