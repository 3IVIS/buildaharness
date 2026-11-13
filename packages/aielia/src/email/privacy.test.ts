import { describe, it, expect } from 'vitest'
import { readdirSync, readFileSync } from 'node:fs'
import { DEFAULT_MAIL_PRIVACY, applyMailPrivacy, loadMailPrivacy, saveMailPrivacy, mayReadText, mayReadMessage } from './privacy.js'
import { buildMailModelInput } from './model-input.js'
import type { Account, Message } from './model.js'

const base: Account = {
  id: 'a1', provider: 'fake', address: 'me@example.com', displayName: 'Me',
  aieliaMayRead: true, excludedFolders: [], excludedSenders: [],
}
const msg = (from: string, folderIds: string[] = ['inbox']): Message => ({
  id: 'm1', accountId: 'a1', threadId: 't1', providerId: 'p1', folderIds,
  from: { address: from }, to: [{ address: 'me@example.com' }], cc: [], subject: 'Hi', date: '2026-01-01T00:00:00Z',
  headers: {}, textBody: 'hello body', attachments: [],
  flags: { read: false, starred: false, draft: false } as Message['flags'],
})

describe('mayReadText', () => {
  it('account off blocks everything', () => {
    const a = { ...base, aieliaMayRead: false }
    expect(mayReadText(a, 'inbox', 'x@y.com')).toBe(false)
    expect(buildMailModelInput(a, msg('x@y.com'))).toEqual({ ok: false, reason: 'account_off' })
  })
  it('default settings are off', () => {
    expect(DEFAULT_MAIL_PRIVACY.aieliaMayRead).toBe(false)
  })
  it('folder exclusion blocks only that folder, by id or name', () => {
    const a = { ...base, excludedFolders: ['Finance'] }
    expect(mayReadText(a, { id: 'f9', name: 'finance' }, 'x@y.com')).toBe(false)
    expect(mayReadText(a, 'Finance', 'x@y.com')).toBe(false)
    expect(mayReadText(a, { id: 'inbox', name: 'Inbox' }, 'x@y.com')).toBe(true)
  })
  it('sender and domain exclusions block only their mail', () => {
    const a = { ...base, excludedSenders: ['Boss@Corp.com', '@bank.com'] }
    expect(mayReadText(a, 'inbox', 'boss@corp.com')).toBe(false)
    expect(mayReadText(a, 'inbox', 'alerts@bank.com')).toBe(false)
    expect(mayReadText(a, 'inbox', 'other@corp.com')).toBe(true)
    expect(mayReadText(a, 'inbox', 'x@notbank.com')).toBe(true)
  })
  it('a message in several folders is blocked if any is excluded', () => {
    const a = { ...base, excludedFolders: ['secret'] }
    expect(mayReadMessage(a, msg('x@y.com', ['inbox', 'secret']))).toBe(false)
    expect(mayReadMessage(a, msg('x@y.com', ['inbox']))).toBe(true)
  })
  it('excluded mail stays usable by non-model features', () => {
    const a = { ...base, aieliaMayRead: false }
    const m = msg('x@y.com')
    expect(m.textBody).toBe('hello body') // cache/search read the message directly
    expect(buildMailModelInput(a, m).ok).toBe(false)
  })
})

describe('settings storage', () => {
  it('round-trips per account and falls back to defaults on damage', async () => {
    const data = new Map<string, unknown>()
    const store = { getSetting: async (k: string) => data.get(k), setSetting: async (k: string, v: unknown) => void data.set(k, v) }
    expect(await loadMailPrivacy(store, 'a1')).toEqual(DEFAULT_MAIL_PRIVACY)
    const p = { aieliaMayRead: true, excludedFolders: ['x'], excludedSenders: ['@y.com'] }
    await saveMailPrivacy(store, 'a1', p)
    expect(await loadMailPrivacy(store, 'a1')).toEqual(p)
    expect(await loadMailPrivacy(store, 'a2')).toEqual(DEFAULT_MAIL_PRIVACY)
    data.set('email:privacy:a1', { aieliaMayRead: 'yes' })
    expect(await loadMailPrivacy(store, 'a1')).toEqual(DEFAULT_MAIL_PRIVACY)
    expect(applyMailPrivacy(base, p).excludedFolders).toEqual(['x'])
  })
})

describe('model input choke point', () => {
  it('wraps allowed mail as untrusted', () => {
    const r = buildMailModelInput(base, msg('x@y.com'))
    expect(r.ok && r.text).toContain('<untrusted_external_content>')
    expect(r.ok && r.text).toContain('hello body')
  })
})

/** Source scan: which email/ modules import an LLM client. */
export function modulesImportingLlm(files: Record<string, string>): string[] {
  return Object.entries(files)
    .filter(([, src]) => {
      const code = src.replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
      return /from\s+['"][^'"]*(llm-client|@buildaharness\/runtime)[^'"]*['"]/.test(code) || /\bILLMClient\b/.test(code)
    })
    .map(([f]) => f)
}

describe('no LLM client import in email/', () => {
  const dir = new URL('.', import.meta.url)
  const files = Object.fromEntries(
    readdirSync(dir)
      .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
      .map((f) => [f, readFileSync(new URL(f, dir), 'utf8')]),
  )
  it('no module imports one', () => {
    expect(modulesImportingLlm(files)).toEqual([])
  })
  it('negative control: a bypassing module is caught', () => {
    const bad = { ...files, 'bypass.ts': "import type { ILLMClient } from '@buildaharness/runtime'\n" }
    expect(modulesImportingLlm(bad)).toEqual(['bypass.ts'])
  })
})
