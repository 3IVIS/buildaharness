import { describe, it, expect } from 'vitest'
import { webcrypto } from 'node:crypto'
import { IDBFactory } from 'fake-indexeddb'
import { InMemorySecretStore, IndexedDbSecretStore, SecretStoreError } from './secret-store.js'
import { ShortLivedTokenSource, RefreshTokenSource, SignInNeededError, TOKEN_EXPIRY_SKEW_MS } from './token-source.js'
import { networkFromFetch } from './network.js'
import type { NetworkPort } from './network.js'

const crypto = webcrypto as unknown as Crypto
const TOKEN = 'ya29.super-secret-token-value'

function rawDump(factory: IDBFactory, name: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = factory.open(name)
    r.onerror = () => reject(r.error)
    r.onsuccess = () => {
      const db = r.result
      const tx = db.transaction('secrets')
      const all = tx.objectStore('secrets').getAll()
      all.onsuccess = () => {
        const parts = (all.result as { iv: Uint8Array; data: ArrayBuffer }[]).map((row) =>
          Buffer.concat([Buffer.from(row.iv), Buffer.from(row.data)]).toString('latin1'),
        )
        db.close()
        resolve(parts.join('|'))
      }
      all.onerror = () => reject(all.error)
    }
  })
}

describe('InMemorySecretStore', () => {
  it('round trips and deletes', async () => {
    const s = new InMemorySecretStore()
    await s.set('a', 'x')
    expect(await s.get('a')).toBe('x')
    await s.delete('a')
    expect(await s.get('a')).toBeUndefined()
  })
})

describe('IndexedDbSecretStore', () => {
  it('round trips a value, per account', async () => {
    const f = new IDBFactory()
    const s = await IndexedDbSecretStore.open(f, crypto, 'db1')
    await s.set('acct-1', TOKEN)
    await s.set('acct-2', 'other')
    expect(await s.get('acct-1')).toBe(TOKEN)
    expect(await s.get('acct-2')).toBe('other')
    expect(await s.get('acct-3')).toBeUndefined()
    s.close()
  })

  it('persists across reopen', async () => {
    const f = new IDBFactory()
    const a = await IndexedDbSecretStore.open(f, crypto, 'db2')
    await a.set('acct', TOKEN)
    a.close()
    const b = await IndexedDbSecretStore.open(f, crypto, 'db2')
    expect(await b.get('acct')).toBe(TOKEN)
    b.close()
  })

  it('does not keep the value readable as plain text in the underlying store', async () => {
    const f = new IDBFactory()
    const s = await IndexedDbSecretStore.open(f, crypto, 'db3')
    await s.set('acct', TOKEN)
    const dump = await rawDump(f, 'db3')
    expect(dump.length).toBeGreaterThan(0)
    expect(dump).not.toContain(TOKEN)
    expect(dump).not.toContain('super-secret')
    s.close()
  })

  it('uses a non-extractable key', async () => {
    const f = new IDBFactory()
    const s = await IndexedDbSecretStore.open(f, crypto, 'db4')
    await s.set('acct', TOKEN)
    const key = await new Promise<CryptoKey>((resolve, reject) => {
      const r = f.open('db4')
      r.onsuccess = () => {
        const g = r.result.transaction('keys').objectStore('keys').get('master')
        g.onsuccess = () => resolve(g.result as CryptoKey)
        g.onerror = () => reject(g.error)
      }
    })
    expect(key.extractable).toBe(false)
    await expect(crypto.subtle.exportKey('raw', key)).rejects.toThrow()
    s.close()
  })

  it('delete removes the value', async () => {
    const f = new IDBFactory()
    const s = await IndexedDbSecretStore.open(f, crypto, 'db5')
    await s.set('acct', TOKEN)
    await s.delete('acct')
    expect(await s.get('acct')).toBeUndefined()
    expect(await rawDump(f, 'db5')).toBe('')
    s.close()
  })

  it('a wrong key cannot decrypt', async () => {
    const f = new IDBFactory()
    const s = await IndexedDbSecretStore.open(f, crypto, 'db6')
    await s.set('acct', TOKEN)
    // Replace the master key with a different one.
    const other = await crypto.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    await new Promise<void>((resolve, reject) => {
      const tx = (s as unknown as { db: IDBDatabase }).db.transaction('keys', 'readwrite')
      tx.objectStore('keys').put(other, 'master')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    await expect(s.get('acct')).rejects.toBeInstanceOf(SecretStoreError)
    s.close()
  })

  it('a missing key reports undecryptable', async () => {
    const f = new IDBFactory()
    const s = await IndexedDbSecretStore.open(f, crypto, 'db7')
    await s.set('acct', TOKEN)
    await new Promise<void>((resolve, reject) => {
      const tx = (s as unknown as { db: IDBDatabase }).db.transaction('keys', 'readwrite')
      tx.objectStore('keys').delete('master')
      tx.oncomplete = () => resolve()
      tx.onerror = () => reject(tx.error)
    })
    await expect(s.get('acct')).rejects.toMatchObject({ code: 'undecryptable' })
    s.close()
  })

  it('a sealed value copied under another account id does not decrypt', async () => {
    const f = new IDBFactory()
    const s = await IndexedDbSecretStore.open(f, crypto, 'db8')
    await s.set('acct-a', TOKEN)
    const db = (s as unknown as { db: IDBDatabase }).db
    const row = await new Promise<unknown>((resolve) => {
      const g = db.transaction('secrets').objectStore('secrets').get('acct-a')
      g.onsuccess = () => resolve(g.result)
    })
    await new Promise<void>((resolve) => {
      const tx = db.transaction('secrets', 'readwrite')
      tx.objectStore('secrets').put(row, 'acct-b')
      tx.oncomplete = () => resolve()
    })
    await expect(s.get('acct-b')).rejects.toBeInstanceOf(SecretStoreError)
    expect(await s.get('acct-a')).toBe(TOKEN)
    s.close()
  })
})

describe('token sources', () => {
  it('short-lived: valid, near expiry, expired, missing', async () => {
    let now = 1_000_000
    const secrets = new InMemorySecretStore()
    const src = new ShortLivedTokenSource('a', secrets, () => now)
    await expect(src.getAccessToken()).rejects.toMatchObject({ reason: 'missing' })
    await src.save({ accessToken: 't1', expiresAt: now + 10 * TOKEN_EXPIRY_SKEW_MS })
    expect(await src.getAccessToken()).toBe('t1')
    now += 10 * TOKEN_EXPIRY_SKEW_MS - TOKEN_EXPIRY_SKEW_MS / 2
    await expect(src.getAccessToken()).rejects.toBeInstanceOf(SignInNeededError)
    now += 10 * TOKEN_EXPIRY_SKEW_MS
    await expect(src.getAccessToken()).rejects.toMatchObject({ reason: 'expired' })
  })

  it('short-lived: an unreadable stored value asks for sign-in', async () => {
    const secrets = new InMemorySecretStore()
    await secrets.set('a', 'not json')
    await expect(new ShortLivedTokenSource('a', secrets).getAccessToken()).rejects.toMatchObject({ reason: 'missing' })
  })

  function refreshSetup(responses: { status: number; body: string }[]) {
    let now = 5_000_000
    const calls: { url: string; body?: string }[] = []
    const network: NetworkPort = async (r) => {
      calls.push({ url: r.url, body: r.body })
      const next = responses.shift()!
      return { status: next.status, headers: {}, text: async () => next.body }
    }
    const secrets = new InMemorySecretStore()
    const src = new RefreshTokenSource({
      accountId: 'a',
      secrets,
      network,
      tokenEndpoint: 'https://idp.example.com/token',
      clientId: 'cid',
      now: () => now,
    })
    return { src, secrets, calls, advance: (ms: number) => (now += ms) }
  }

  it('refresh: uses a fresh cached token without a network call', async () => {
    const { src, calls } = refreshSetup([])
    await src.save({ refreshToken: 'r1', accessToken: 'fresh', expiresAt: 5_000_000 + 3_600_000 })
    expect(await src.getAccessToken()).toBe('fresh')
    expect(calls).toHaveLength(0)
  })

  it('refresh: renews an expired token, stores the rotated refresh token, shares one request', async () => {
    const { src, secrets, calls, advance } = refreshSetup([
      { status: 200, body: JSON.stringify({ access_token: 'n1', expires_in: 3600, refresh_token: 'r2' }) },
    ])
    await src.save({ refreshToken: 'r1', accessToken: 'old', expiresAt: 5_000_000 + 1000 })
    advance(5000)
    const [a, b] = await Promise.all([src.getAccessToken(), src.getAccessToken()])
    expect(a).toBe('n1')
    expect(b).toBe('n1')
    expect(calls).toHaveLength(1)
    expect(calls[0].body).toContain('refresh_token=r1')
    expect(JSON.parse((await secrets.get('a'))!).refreshToken).toBe('r2')
  })

  it('refresh: a rejected grant deletes the stored token and asks for sign-in', async () => {
    const { src, secrets } = refreshSetup([{ status: 400, body: '{"error":"invalid_grant"}' }])
    await src.save({ refreshToken: 'r1' })
    await expect(src.getAccessToken()).rejects.toMatchObject({ reason: 'refresh_rejected' })
    expect(await secrets.get('a')).toBeUndefined()
  })

  it('refresh: a server error is not a sign-in problem and keeps the token', async () => {
    const { src, secrets } = refreshSetup([{ status: 503, body: '' }])
    await src.save({ refreshToken: 'r1' })
    const err = await src.getAccessToken().catch((e) => e)
    expect(err).not.toBeInstanceOf(SignInNeededError)
    expect(await secrets.get('a')).toBeDefined()
  })

  it('refresh: nothing stored asks for sign-in', async () => {
    const { src } = refreshSetup([])
    await expect(src.getAccessToken()).rejects.toMatchObject({ reason: 'missing' })
  })
})

describe('networkFromFetch', () => {
  it('maps a fetch-shaped function and lowercases header names', async () => {
    const port = networkFromFetch(async (url, init) => ({
      status: 201,
      headers: { forEach: (cb) => cb('v', 'X-Thing') },
      text: async () => `${init.method} ${url}`,
    }))
    const res = await port({ url: 'https://x.example.com/', method: 'POST' })
    expect(res.status).toBe(201)
    expect(res.headers).toEqual({ 'x-thing': 'v' })
    expect(await res.text()).toBe('POST https://x.example.com/')
  })
  it('refuses an already-aborted request', async () => {
    const port = networkFromFetch(async () => {
      throw new Error('should not be called')
    })
    await expect(port({ url: 'https://x.example.com/', signal: { aborted: true } })).rejects.toThrow('aborted')
  })
})

describe('no direct fetch in mail code', () => {
  it('only network.ts mentions fetch( as a call', async () => {
    const { readdirSync, readFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    const dir = __dirname
    for (const f of readdirSync(dir)) {
      if (!f.endsWith('.ts') || f.endsWith('.test.ts') || f === 'network.ts') continue
      const src = readFileSync(join(dir, f), 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '')
      expect(src, f).not.toMatch(/\bfetch\s*\(/)
    }
  })
})
