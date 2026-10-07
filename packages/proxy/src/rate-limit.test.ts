import { describe, it, expect } from 'vitest'
import { clientIp, ConcurrencyTracker, WindowCounter, recordGuardRejection, guardRejectCounter, resetWebRateLimitState } from './rate-limit'

describe('WindowCounter', () => {
  it('allows requests under the limit and denies once the limit is reached', () => {
    const counter = new WindowCounter()
    const now = 1_000_000
    expect(counter.consume('k', 1, 2, 60_000, now).allowed).toBe(true)
    expect(counter.consume('k', 1, 2, 60_000, now).allowed).toBe(true)
    const third = counter.consume('k', 1, 2, 60_000, now)
    expect(third.allowed).toBe(false)
    expect(third.retryAfterSeconds).toBeGreaterThan(0)
  })

  it('resets the window once windowMs has elapsed', () => {
    const counter = new WindowCounter()
    const now = 1_000_000
    counter.consume('k', 1, 1, 60_000, now)
    expect(counter.consume('k', 1, 1, 60_000, now).allowed).toBe(false)
    expect(counter.consume('k', 1, 1, 60_000, now + 60_001).allowed).toBe(true)
  })

  it('peek reports exceeded without consuming', () => {
    const counter = new WindowCounter()
    const now = 1_000_000
    counter.consume('k', 5, 10, 60_000, now)
    expect(counter.peek('k', 5, 60_000, now).allowed).toBe(false)
    expect(counter.peek('k', 10, 60_000, now).allowed).toBe(true)
    // peek must not have consumed anything
    expect(counter.currentCount('k', 60_000, now)).toBe(5)
  })

  it('currentCount is 0 for an unknown or expired key', () => {
    const counter = new WindowCounter()
    expect(counter.currentCount('missing', 60_000, 1_000_000)).toBe(0)
    counter.consume('k', 1, 10, 60_000, 1_000_000)
    expect(counter.currentCount('k', 60_000, 1_000_000 + 60_001)).toBe(0)
  })

  it('reset clears all keys', () => {
    const counter = new WindowCounter()
    counter.consume('k', 1, 1, 60_000, 1_000_000)
    counter.reset()
    expect(counter.currentCount('k', 60_000, 1_000_000)).toBe(0)
  })
})

describe('ConcurrencyTracker', () => {
  it('rejects the (max+1)th acquire until one is released', () => {
    const tracker = new ConcurrencyTracker()
    expect(tracker.acquire('k', 2)).toBe(true)
    expect(tracker.acquire('k', 2)).toBe(true)
    expect(tracker.acquire('k', 2)).toBe(false)
    tracker.release('k')
    expect(tracker.acquire('k', 2)).toBe(true)
  })

  it('release is a no-op once the key has no holders', () => {
    const tracker = new ConcurrencyTracker()
    expect(() => tracker.release('never-acquired')).not.toThrow()
  })
})

describe('recordGuardRejection', () => {
  it('warns exactly once when the threshold is first crossed', () => {
    resetWebRateLimitState()
    const warnSpy: string[] = []
    const original = console.warn
    console.warn = (msg: unknown) => warnSpy.push(String(msg))
    try {
      for (let i = 0; i < 5; i++) recordGuardRejection('sub-a', 3, 1_000_000)
    } finally {
      console.warn = original
    }
    expect(guardRejectCounter.currentCount('sub:sub-a', 60 * 60 * 1000, 1_000_000)).toBe(5)
    expect(warnSpy).toHaveLength(1)
    expect(JSON.parse(warnSpy[0])).toMatchObject({ alert: 'repeated_guard_rejections', sub: 'sub-a', count: 3 })
  })
})

describe('clientIp', () => {
  const h = (o: Record<string, string>) => ({ get: (n: string) => o[n] ?? null })
  it('ignores forwarding headers unless trusted, falling back to the peer address', () => {
    const headers = h({ 'cf-connecting-ip': '9.9.9.9', 'x-forwarded-for': '8.8.8.8', 'x-real-ip': '7.7.7.7' })
    expect(clientIp(headers)).toBe('unknown')
    expect(clientIp(headers, { remoteAddress: '10.1.1.1' })).toBe('10.1.1.1')
  })
  it('honours cf-connecting-ip only when trustCloudflare', () => {
    expect(clientIp(h({ 'cf-connecting-ip': '9.9.9.9' }), { trustCloudflare: true })).toBe('9.9.9.9')
  })
  it('uses the last x-forwarded-for entry (the trusted proxy\'s) when trustForwarded', () => {
    expect(clientIp(h({ 'x-forwarded-for': 'spoofed, 5.5.5.5' }), { trustForwarded: true })).toBe('5.5.5.5')
  })
})

describe('WindowCounter memory bound', () => {
  it('does not grow without limit when keys are sprayed', () => {
    const counter = new WindowCounter()
    for (let i = 0; i < 60_000; i++) counter.consume(`k${i}`, 1, 5, 3_600_000, 1000)
    expect((counter as unknown as { windows: Map<string, unknown> }).windows.size).toBeLessThanOrEqual(50_000)
  })
})
