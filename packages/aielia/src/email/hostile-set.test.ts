import { describe, it, expect } from 'vitest'
import { buildHostileSet, loadHostileSet, parseHostileItem, hostileMessages, HostileKindSchema, OVERSIZED_BODY_BYTES } from './hostile-set.js'

describe('hostile set', () => {
  it('every item parses and is marked hostile', () => {
    const r = loadHostileSet()
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.items.length).toBeGreaterThanOrEqual(8)
    for (const i of r.items) {
      expect(i.hostile).toBe(true)
      expect(i.expected.mustNotHappen.length).toBeGreaterThan(0)
    }
  })

  it('covers every hostile kind', () => {
    const kinds = new Set(buildHostileSet().map(i => i.kind))
    for (const k of HostileKindSchema.options) expect(kinds.has(k)).toBe(true)
  })

  it('includes the forward-last-ten request, an oversized body and a link mismatch', () => {
    const items = buildHostileSet()
    expect(items.some(i => /forward the last ten messages/i.test(i.message.textBody))).toBe(true)
    expect(items.find(i => i.kind === 'oversized_body')!.message.textBody.length).toBeGreaterThanOrEqual(OVERSIZED_BODY_BYTES)
    const link = items.find(i => i.kind === 'link_mismatch')!
    expect(link.message.htmlBody).toMatch(/href="https:\/\/collect\.example\.net/)
  })

  it('uses only reserved example domains and unique ids', () => {
    const items = buildHostileSet()
    expect(new Set(items.map(i => i.id)).size).toBe(items.length)
    expect(new Set(hostileMessages(items).map(m => m.id)).size).toBe(items.length)
    const text = JSON.stringify(items.map(i => ({ ...i, message: { ...i.message, textBody: i.message.textBody.slice(0, 500) } })))
    const domains = [...text.matchAll(/[\w.-]+@([\w.-]+\.[a-z]{2,})/gi)].map(m => m[1]!.toLowerCase())
    for (const d of domains) expect(/(^|\.)example\.(com|net|org)$/.test(d)).toBe(true)
  })

  it('the loader names a damaged item and rejects a non-hostile one', () => {
    const items = buildHostileSet()
    const bad = [{ ...items[0], hostile: false }]
    const r = loadHostileSet(bad)
    expect(r.ok).toBe(false)
    expect(parseHostileItem({ ...items[0], expected: { mustNotHappen: [], correctBehaviour: 'x' } }).ok).toBe(false)
    expect(loadHostileSet([items[0], items[0]]).ok).toBe(false)
  })
})
