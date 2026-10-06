import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'

/**
 * The product is called Aielia. The desktop app used to show "Assistant" in several places (reply label,
 * composer placeholder, error text). This guard fails if a user-facing source string brings the generic
 * name back. It only looks at the standalone word "Assistant" or the phrase "the assistant" in code with
 * comments stripped; identifiers such as `PersonalAssistant` and the stored role value `'assistant'` do not match.
 */
function sourceFiles(dir: string): string[] {
  const out: string[] = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === 'e2e' || name === 'plan-viz') continue
      out.push(...sourceFiles(full))
    } else if (/\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name)) {
      out.push(full)
    }
  }
  return out
}

function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, '')).replace(/(^|[^:'"`])\/\/.*$/gm, '$1')
}

describe('product name', () => {
  it('does not show the generic name "Assistant" in user-facing source', () => {
    const offenders: string[] = []
    for (const file of sourceFiles(__dirname)) {
      const lines = stripComments(readFileSync(file, 'utf-8')).split('\n')
      lines.forEach((line, i) => {
        if (/^\s*import\b/.test(line)) return
        if (/\bAssistant\b|\b[Tt]he assistant\b/.test(line)) offenders.push(`${file.replace(__dirname, 'src')}:${i + 1}: ${line.trim()}`)
      })
    }
    expect(offenders).toEqual([])
  })
})
