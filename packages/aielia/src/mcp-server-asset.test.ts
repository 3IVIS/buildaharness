import { describe, it, expect, afterEach } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveMcpServerPath, MCP_SERVER_FILE_NAME, MCP_SERVER_PATTERN_FILES } from './mcp-server-asset.js'
import { CLI_VERSION } from './version.js'

const home = mkdtempSync(join(tmpdir(), 'mcp-asset-home-'))

afterEach(() => rmSync(join(home, '.buildaharness'), { recursive: true, force: true }))

describe('resolveMcpServerPath', () => {
  it('non-SEA: resolves to the file beside this module (the npm-install behaviour, unchanged)', () => {
    const expected = fileURLToPath(new URL(MCP_SERVER_FILE_NAME, import.meta.url))
    expect(resolveMcpServerPath(null)).toBe(expected)
    expect(existsSync(expected)).toBe(true)
  })

  it('SEA: extracts the server and its pattern files into the versioned cache and returns that path', () => {
    const requested: string[] = []
    const sea = {
      isSea: () => true,
      getRawAsset: (key: string) => {
        requested.push(key)
        return new TextEncoder().encode(`asset:${key}`).buffer as ArrayBuffer
      },
    }
    const path = resolveMcpServerPath(sea, home)
    const dir = join(home, '.buildaharness', 'personal-assistant', 'sea-cache', CLI_VERSION)
    expect(path).toBe(join(dir, MCP_SERVER_FILE_NAME))
    expect(readFileSync(path, 'utf8')).toBe(`asset:${MCP_SERVER_FILE_NAME}`)
    for (const name of MCP_SERVER_PATTERN_FILES) {
      expect(readFileSync(join(dir, 'lexical', 'patterns', name), 'utf8')).toBe(`asset:lexical/patterns/${name}`)
    }

    // A second launch reuses the extraction rather than re-reading any asset.
    requested.length = 0
    expect(resolveMcpServerPath(sea, home)).toBe(path)
    expect(requested).toEqual([])
  })

  it('the pattern files the server reads at startup are exactly the ones extracted', () => {
    const src = readFileSync(fileURLToPath(new URL(MCP_SERVER_FILE_NAME, import.meta.url)), 'utf8')
    const read = [...src.matchAll(/join\(__dirname, 'lexical\/patterns\/([^']+)'\)/g)].map((m) => m[1]).sort()
    expect([...MCP_SERVER_PATTERN_FILES].sort()).toEqual(read)
  })
})
