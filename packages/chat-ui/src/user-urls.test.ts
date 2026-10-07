import { beforeEach, describe, expect, it } from 'vitest'
import { isUserAuthoredUrl, rememberUserUrls, resetUserUrls } from './user-urls'

beforeEach(() => resetUserUrls())

describe('user-authored URLs', () => {
  it('recognises a URL typed in a message, ignoring trailing punctuation and a missing slash', () => {
    rememberUserUrls('please read https://example.com/page, thanks. and (https://other.example)')
    expect(isUserAuthoredUrl('https://example.com/page')).toBe(true)
    expect(isUserAuthoredUrl('https://other.example/')).toBe(true)
  })
  it('does not recognise a URL the user never typed', () => {
    rememberUserUrls('hello')
    expect(isUserAuthoredUrl('https://evil.example/exfil?d=1')).toBe(false)
    expect(isUserAuthoredUrl('not a url')).toBe(false)
  })
})
