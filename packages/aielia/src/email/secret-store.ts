/**
 * Secret store for mail credentials (decision 4). Interface: get, set, delete by account id. Tokens never go to
 * `localStorage`, config files or logs. Implementations: in-memory (tests, and the "no keyring" session-only fallback),
 * a browser one that encrypts into IndexedDB with a non-extractable WebCrypto key, and (phase D-series) a Tauri keychain
 * one. No `node:*` and no DOM imports: IndexedDB and WebCrypto are passed in.
 */

export interface SecretStore {
  get(accountId: string): Promise<string | undefined>
  set(accountId: string, value: string): Promise<void>
  delete(accountId: string): Promise<void>
}

export class SecretStoreError extends Error {
  constructor(
    public readonly code: 'undecryptable' | 'unavailable' | 'no_keyring',
    message: string,
  ) {
    super(message)
    this.name = 'SecretStoreError'
  }
}

export class InMemorySecretStore implements SecretStore {
  private readonly values = new Map<string, string>()
  async get(accountId: string): Promise<string | undefined> {
    return this.values.get(accountId)
  }
  async set(accountId: string, value: string): Promise<void> {
    this.values.set(accountId, value)
  }
  async delete(accountId: string): Promise<void> {
    this.values.delete(accountId)
  }
}

/**
 * Wraps a durable store (the OS keychain) and, when it reports `no_keyring`, keeps the secret for this session only in
 * memory and calls `onSessionOnly` once so the page can show the notice. Never writes anywhere else. Other errors
 * (a locked or failing keychain) pass through unchanged.
 */
export class SessionFallbackSecretStore implements SecretStore {
  private readonly session = new InMemorySecretStore()
  private fellBack = false
  constructor(
    private readonly durable: SecretStore,
    private readonly onSessionOnly?: () => void,
  ) {}

  /** True once the keyring was found missing: secrets now live in memory and are lost on quit. */
  get sessionOnly(): boolean {
    return this.fellBack
  }

  private fallBack(e: unknown): boolean {
    if (!(e instanceof SecretStoreError) || e.code !== 'no_keyring') return false
    if (!this.fellBack) {
      this.fellBack = true
      this.onSessionOnly?.()
    }
    return true
  }

  async get(accountId: string): Promise<string | undefined> {
    if (this.fellBack) return this.session.get(accountId)
    try {
      return await this.durable.get(accountId)
    } catch (e) {
      if (this.fallBack(e)) return this.session.get(accountId)
      throw e
    }
  }
  async set(accountId: string, value: string): Promise<void> {
    if (!this.fellBack) {
      try {
        return await this.durable.set(accountId, value)
      } catch (e) {
        if (!this.fallBack(e)) throw e
      }
    }
    await this.session.set(accountId, value)
  }
  async delete(accountId: string): Promise<void> {
    await this.session.delete(accountId)
    if (this.fellBack) return
    try {
      await this.durable.delete(accountId)
    } catch (e) {
      if (!this.fallBack(e)) throw e
    }
  }
}

const DB_VERSION = 1
const KEYS = 'keys'
const SECRETS = 'secrets'
const MASTER = 'master'

interface SealedRow {
  iv: Uint8Array<ArrayBuffer>
  data: ArrayBuffer
}

const req = <T>(r: IDBRequest<T>): Promise<T> =>
  new Promise((resolve, reject) => {
    r.onsuccess = () => resolve(r.result)
    r.onerror = () => reject(r.error)
  })
const done = (tx: IDBTransaction): Promise<void> =>
  new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve()
    tx.onerror = () => reject(tx.error)
    tx.onabort = () => reject(tx.error)
  })

/**
 * AES-GCM with a non-extractable master key kept as a `CryptoKey` object in IndexedDB (the key bytes are never
 * readable by script). The account id is bound as additional authenticated data, so a sealed value copied under another
 * account id does not decrypt. This protects against a plain read of the stored data and against copying rows between
 * accounts; it does not protect against script running in the same origin (that can call the key), which is stated in
 * the plan's threat model.
 */
export class IndexedDbSecretStore implements SecretStore {
  private constructor(
    private readonly db: IDBDatabase,
    private readonly subtle: SubtleCrypto,
    private readonly random: (a: Uint8Array<ArrayBuffer>) => Uint8Array<ArrayBuffer>,
  ) {}

  static async open(
    factory: IDBFactory,
    crypto: Crypto,
    name = 'aielia-email-secrets',
  ): Promise<IndexedDbSecretStore> {
    const openReq = factory.open(name, DB_VERSION)
    openReq.onupgradeneeded = () => {
      const db = openReq.result
      db.createObjectStore(KEYS)
      db.createObjectStore(SECRETS)
    }
    const db = await req(openReq)
    return new IndexedDbSecretStore(db, crypto.subtle, (a) => crypto.getRandomValues(a))
  }

  close(): void {
    this.db.close()
  }

  private async masterKey(create: boolean): Promise<CryptoKey | undefined> {
    const existing = (await req(this.db.transaction(KEYS).objectStore(KEYS).get(MASTER))) as CryptoKey | undefined
    if (existing || !create) return existing
    const key = await this.subtle.generateKey({ name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt'])
    const tx = this.db.transaction(KEYS, 'readwrite')
    // Another tab may have created one meanwhile: keep the first writer's key.
    const again = (await req(tx.objectStore(KEYS).get(MASTER))) as CryptoKey | undefined
    if (again) return again
    tx.objectStore(KEYS).put(key, MASTER)
    await done(tx)
    return key
  }

  async set(accountId: string, value: string): Promise<void> {
    const key = (await this.masterKey(true))!
    const iv = this.random(new Uint8Array(12))
    const data = await this.subtle.encrypt(
      { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(accountId) },
      key,
      new TextEncoder().encode(value),
    )
    const tx = this.db.transaction(SECRETS, 'readwrite')
    tx.objectStore(SECRETS).put({ iv, data } satisfies SealedRow, accountId)
    await done(tx)
  }

  async get(accountId: string): Promise<string | undefined> {
    const row = (await req(this.db.transaction(SECRETS).objectStore(SECRETS).get(accountId))) as SealedRow | undefined
    if (!row) return undefined
    const key = await this.masterKey(false)
    if (!key) throw new SecretStoreError('undecryptable', 'the secret store key is missing')
    try {
      const plain = await this.subtle.decrypt(
        { name: 'AES-GCM', iv: row.iv, additionalData: new TextEncoder().encode(accountId) },
        key,
        row.data,
      )
      return new TextDecoder().decode(plain)
    } catch {
      throw new SecretStoreError('undecryptable', 'the stored secret cannot be decrypted with the current key')
    }
  }

  async delete(accountId: string): Promise<void> {
    const tx = this.db.transaction(SECRETS, 'readwrite')
    tx.objectStore(SECRETS).delete(accountId)
    await done(tx)
  }
}
