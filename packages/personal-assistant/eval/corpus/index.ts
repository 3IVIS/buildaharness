/**
 * Corpus loader — reads every `*.json` in this directory, validates it, returns the task list
 * sorted by id. Node-only (uses `node:fs`); imported by the runner and by `corpus.test.ts`.
 */
import { readdirSync, readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { parseTaskSpec, type TaskSpec } from './schema.js'

const CORPUS_DIR = dirname(fileURLToPath(import.meta.url))

export function loadCorpus(): TaskSpec[] {
  const files = readdirSync(CORPUS_DIR).filter((f) => f.endsWith('.json'))
  const tasks = files.map((f) => {
    const raw = JSON.parse(readFileSync(join(CORPUS_DIR, f), 'utf8')) as unknown
    const task = parseTaskSpec(raw, f)
    if (`${task.id}.json` !== f) {
      throw new Error(`task id "${task.id}" does not match filename "${f}" (expected "${task.id}.json")`)
    }
    return task
  })
  const ids = new Set<string>()
  for (const t of tasks) {
    if (ids.has(t.id)) throw new Error(`duplicate task id: ${t.id}`)
    ids.add(t.id)
  }
  return tasks.sort((a, b) => a.id.localeCompare(b.id))
}

export { CORPUS_DIR }
