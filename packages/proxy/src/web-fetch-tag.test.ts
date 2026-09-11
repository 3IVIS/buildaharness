import { describe, it, expect } from 'vitest'
import { signFetchTag, verifyFetchTag, FETCH_TAG_TTL_SECONDS } from './web-fetch-tag'

const SECRET = 'unit-test-secret'

describe('web-fetch-tag', () => {
  it('verifies a freshly signed tag for the same URL', async () => {
    const tag = await signFetchTag('https://example.com/', SECRET)
    expect(await verifyFetchTag('https://example.com/', tag, SECRET)).toBe(true)
  })

  it('rejects a tag presented for a different URL', async () => {
    const tag = await signFetchTag('https://example.com/a', SECRET)
    expect(await verifyFetchTag('https://example.com/b', tag, SECRET)).toBe(false)
  })

  it('rejects a tag signed with a different secret', async () => {
    const tag = await signFetchTag('https://example.com/', 'other-secret')
    expect(await verifyFetchTag('https://example.com/', tag, SECRET)).toBe(false)
  })

  it('rejects an expired tag', async () => {
    const tag = await signFetchTag('https://example.com/', SECRET, -1)
    expect(await verifyFetchTag('https://example.com/', tag, SECRET)).toBe(false)
  })

  it('rejects a malformed tag', async () => {
    expect(await verifyFetchTag('https://example.com/', 'not-a-valid-tag', SECRET)).toBe(false)
    expect(await verifyFetchTag('https://example.com/', undefined, SECRET)).toBe(false)
    expect(await verifyFetchTag('https://example.com/', '', SECRET)).toBe(false)
  })

  it('defaults to a 15-minute TTL', () => {
    expect(FETCH_TAG_TTL_SECONDS).toBe(15 * 60)
  })
})
