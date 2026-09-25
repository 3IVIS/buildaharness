/**
 * Per-layer corpus rules (AL1a). Pure checkers — `corpus.test.ts` applies them to the real corpus
 * for every layer that has tasks declaring it, and to fixtures to prove each rule can fail.
 *
 * Rules, per layer that has any tagged task:
 *   - >= MIN_FAMILIES scenario families, each with >= MIN_STRESS_PER_FAMILY stress tasks
 *     (a family is `TaskSpec.family`; broad = the layer's real failure modes, not one phrasing)
 *   - >= MIN_CALM_CONTROLS calm controls (`role: 'calm-control'`) naming the layer that must stay quiet
 *   - every tagged task has a `note` >= MIN_NOTE_CHARS chars
 *   - no two prompts within a layer are near-duplicates (token-set Jaccard >= NEAR_DUPLICATE_JACCARD)
 */
import type { TaskSpec } from './schema.js'
import { AUDIT_SLICE_MECHANISM } from './mechanisms.js'

export const MIN_FAMILIES = 3
export const MIN_STRESS_PER_FAMILY = 4
export const MIN_CALM_CONTROLS = 6
export const MIN_NOTE_CHARS = 40
export const NEAR_DUPLICATE_JACCARD = 0.8

/** The layer a task targets: explicit `mechanism`, else the mechanism of its audit slice. */
export function mechanismOf(t: TaskSpec): string | undefined {
  return t.mechanism ?? (t.slice ? AUDIT_SLICE_MECHANISM[t.slice] : undefined)
}

function tokens(s: string): Set<string> {
  return new Set(s.toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 2))
}

export function promptSimilarity(a: string, b: string): number {
  const ta = tokens(a)
  const tb = tokens(b)
  if (ta.size === 0 && tb.size === 0) return 1
  let inter = 0
  for (const w of ta) if (tb.has(w)) inter++
  return inter / (ta.size + tb.size - inter)
}

const fullPrompt = (t: TaskSpec): string => [t.prompt, ...t.followups.map((f) => f.prompt)].join('\n')

/** Rejects near-duplicate prompts among the given tasks; returns one message per offending pair. */
export function nearDuplicatePrompts(tasks: readonly TaskSpec[]): string[] {
  const out: string[] = []
  for (let i = 0; i < tasks.length; i++) {
    for (let j = i + 1; j < tasks.length; j++) {
      const sim = promptSimilarity(fullPrompt(tasks[i]), fullPrompt(tasks[j]))
      if (sim >= NEAR_DUPLICATE_JACCARD) out.push(`${tasks[i].id} ~ ${tasks[j].id} (similarity ${sim.toFixed(2)})`)
    }
  }
  return out
}

/** Every rule for one layer's tasks; returns human-readable violations (empty = clean). */
export function checkMechanismTasks(mechanism: string, tasks: readonly TaskSpec[]): string[] {
  const v: string[] = []
  const stress = tasks.filter((t) => t.role === 'stress')
  const calm = tasks.filter((t) => t.role === 'calm-control')
  const byFamily = new Map<string, number>()
  for (const t of stress) {
    if (!t.family) v.push(`${mechanism}: stress task ${t.id} has no scenario family`)
    else byFamily.set(t.family, (byFamily.get(t.family) ?? 0) + 1)
  }
  const goodFamilies = [...byFamily.entries()].filter(([, n]) => n >= MIN_STRESS_PER_FAMILY)
  if (goodFamilies.length < MIN_FAMILIES) {
    v.push(`${mechanism}: needs >= ${MIN_FAMILIES} families with >= ${MIN_STRESS_PER_FAMILY} stress tasks each, has ${goodFamilies.length} (${[...byFamily.entries()].map(([f, n]) => `${f}:${n}`).join(', ') || 'none'})`)
  }
  if (calm.length < MIN_CALM_CONTROLS) v.push(`${mechanism}: needs >= ${MIN_CALM_CONTROLS} calm controls, has ${calm.length}`)
  for (const t of tasks) {
    if (!t.role) v.push(`${mechanism}: ${t.id} declares a mechanism but no role`)
    if ((t.note ?? '').trim().length < MIN_NOTE_CHARS) v.push(`${mechanism}: ${t.id} note must be >= ${MIN_NOTE_CHARS} chars stating what must and must not happen`)
  }
  for (const d of nearDuplicatePrompts(tasks)) v.push(`${mechanism}: near-duplicate prompts ${d}`)
  return v
}

/** Group a corpus by targeted layer and check each layer that has at least one tagged task. */
export function checkCorpusMechanisms(tasks: readonly TaskSpec[]): string[] {
  const groups = new Map<string, TaskSpec[]>()
  for (const t of tasks) {
    const m = t.mechanism // slice-derived mechanisms are not yet role-tagged; only explicit tags are enforced
    if (!m) continue
    groups.set(m, [...(groups.get(m) ?? []), t])
  }
  return [...groups.entries()].flatMap(([m, ts]) => checkMechanismTasks(m, ts))
}
