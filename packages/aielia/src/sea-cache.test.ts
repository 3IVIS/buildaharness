import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { extractAssetOnce, seaCacheDir } from './sea-cache.js'

const dirs: string[] = []
function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), 'sea-cache-'))
  dirs.push(d)
  return d
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true })
})

describe('seaCacheDir', () => {
  it('nests the version under the personal-assistant data dir', () => {
    expect(seaCacheDir('1.2.3', '/home/u')).toBe(join('/home/u', '.buildaharness', 'personal-assistant', 'sea-cache', '1.2.3'))
  })
})

describe('extractAssetOnce', () => {
  it('writes a string asset, creating missing directories', () => {
    const dir = join(tmp(), 'a', 'b')
    const path = extractAssetOnce(dir, 'app.mjs', () => 'export {}')
    expect(path).toBe(join(dir, 'app.mjs'))
    expect(readFileSync(path, 'utf8')).toBe('export {}')
  })

  it('writes a binary (ArrayBuffer) asset byte-for-byte', () => {
    const bytes = new Uint8Array([0, 1, 2, 254, 255])
    const path = extractAssetOnce(tmp(), 'blob.bin', () => bytes.buffer)
    expect([...readFileSync(path)]).toEqual([...bytes])
  })

  it('does not re-extract when the versioned path already exists', () => {
    const dir = tmp()
    writeFileSync(join(dir, 'app.mjs'), 'original')
    let reads = 0
    extractAssetOnce(dir, 'app.mjs', () => {
      reads++
      return 'replacement'
    })
    expect(reads).toBe(0)
    expect(readFileSync(join(dir, 'app.mjs'), 'utf8')).toBe('original')
  })

  it('leaves no temp file behind', () => {
    const dir = tmp()
    extractAssetOnce(dir, 'app.mjs', () => 'x')
    expect(readdirSync(dir)).toEqual(['app.mjs'])
  })

  it('leaves nothing at the target path if reading the asset throws', () => {
    const dir = tmp()
    expect(() =>
      extractAssetOnce(dir, 'app.mjs', () => {
        throw new Error('no such asset')
      }),
    ).toThrow('no such asset')
    expect(existsSync(join(dir, 'app.mjs'))).toBe(false)
  })
})
