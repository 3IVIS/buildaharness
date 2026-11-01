import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { hasAcceptedTerms, maybeShowTermsNotice } from './terms-notice.js'
import { PRIVACY_URL, TERMS_URL, TERMS_VERSION } from './terms-text.js'

const fresh = (): string => mkdtempSync(join(tmpdir(), 'terms-'))

describe('maybeShowTermsNotice', () => {
  it('prints the notice with both links, waits for Enter, and remembers the version', async () => {
    const dataDir = fresh()
    const lines: string[] = []
    const asked: string[] = []
    const shown = await maybeShowTermsNotice({
      isInteractive: true,
      dataDir,
      log: (l) => lines.push(l),
      ask: async (q) => { asked.push(q); return '' },
      now: () => new Date('2026-11-01T00:00:00Z'),
    })
    expect(shown).toBe(true)
    const text = lines.join('\n')
    expect(text).toContain(TERMS_URL)
    expect(text).toContain(PRIVACY_URL)
    expect(text).toContain('/config set updateCheck disabled')
    expect(asked[0]).toContain('Enter to accept the Terms')
    expect(hasAcceptedTerms(dataDir)).toBe(true)
    expect(JSON.parse(readFileSync(join(dataDir, 'terms-accepted.json'), 'utf8'))).toEqual({ version: TERMS_VERSION, acceptedAt: '2026-11-01T00:00:00.000Z' })
  })

  it('does not show it again once this version is accepted', async () => {
    const dataDir = fresh()
    const deps = { isInteractive: true, dataDir, log: () => {}, ask: async () => '' }
    await maybeShowTermsNotice(deps)
    expect(await maybeShowTermsNotice(deps)).toBe(false)
  })

  it('asks again when the accepted version is older', async () => {
    const dataDir = fresh()
    writeFileSync(join(dataDir, 'terms-accepted.json'), JSON.stringify({ version: '2020-01-01' }))
    expect(hasAcceptedTerms(dataDir)).toBe(false)
    expect(await maybeShowTermsNotice({ isInteractive: true, dataDir, log: () => {}, ask: async () => '' })).toBe(true)
  })

  it('skips scripted runs without writing anything', async () => {
    const dataDir = fresh()
    const shown = await maybeShowTermsNotice({ isInteractive: false, dataDir, log: () => { throw new Error('should not print') }, ask: async () => '' })
    expect(shown).toBe(false)
    expect(hasAcceptedTerms(dataDir)).toBe(false)
  })

  it('still continues when the data directory cannot be written', async () => {
    // A path *under a regular file* can never be created (ENOTDIR), on any platform.
    const blocker = join(fresh(), 'a-file')
    writeFileSync(blocker, 'x')
    const shown = await maybeShowTermsNotice({ isInteractive: true, dataDir: join(blocker, 'sub'), log: () => {}, ask: async () => '' })
    expect(shown).toBe(true)
  })
})
