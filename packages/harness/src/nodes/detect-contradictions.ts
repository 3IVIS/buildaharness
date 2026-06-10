import type { WorldModel, Contradiction, Belief } from '../state/world-model.js'
import type { EvidenceStore } from '../state/evidence-store.js'
import type { HypothesisSet } from '../state/hypothesis-set.js'

type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'SYSTEM_BREAKING'
type Scope = 'local' | 'task' | 'global'

function computeSeverity(relA: string, relB: string): Severity {
  const highCount = (relA === 'HIGH' ? 1 : 0) + (relB === 'HIGH' ? 1 : 0)
  if (highCount === 2) return 'SYSTEM_BREAKING'
  const medCount = (relA === 'MEDIUM' ? 1 : 0) + (relB === 'MEDIUM' ? 1 : 0)
  if (highCount === 1 || medCount === 2) return 'HIGH'
  if (medCount === 1) return 'MEDIUM'
  return 'LOW'
}

function computeScope(content: string): Scope {
  const lower = content.toLowerCase()
  if (lower.includes('objective') || lower.includes('global')) return 'global'
  if (lower.includes('task')) return 'task'
  return 'local'
}

function addContradiction(c: Contradiction, worldModel: WorldModel): void {
  worldModel.contradictions.push(c)
  applyResolutionPolicy(c, worldModel)
}

function applyResolutionPolicy(c: Contradiction, worldModel: WorldModel): void {
  if (c.severity === 'SYSTEM_BREAKING') {
    worldModel.completeness_flags[`contradiction_${c.id}`] = false
  }
}

export function detectContradictions(
  worldModel: WorldModel,
  _evidenceStore: EvidenceStore,
  _hypothesisSet: HypothesisSet,
): void {
  const beliefs = worldModel.beliefs
  const detected = new Set<string>()

  // 1. Pairwise: belief content "NOT: <X>" directly negates another belief with content "<X>"
  for (let i = 0; i < beliefs.length; i++) {
    for (let j = i + 1; j < beliefs.length; j++) {
      const a = beliefs[i], b = beliefs[j]
      const aIsNeg = a.content.startsWith('NOT: ')
      const bIsNeg = b.content.startsWith('NOT: ')

      let baseContent = ''
      let beliefIds: string[] = []

      if (aIsNeg && b.content === a.content.slice(5)) {
        baseContent = b.content
        beliefIds = [a.id, b.id]
      } else if (bIsNeg && a.content === b.content.slice(5)) {
        baseContent = a.content
        beliefIds = [a.id, b.id]
      }

      if (beliefIds.length > 0) {
        const key = `pairwise_${[...beliefIds].sort().join('__')}`
        if (!detected.has(key)) {
          detected.add(key)
          addContradiction({
            id: key,
            type: 'pairwise',
            severity: computeSeverity(a.reliability, b.reliability),
            scope: computeScope(baseContent),
            description: `Pairwise contradiction between "${a.id}" and "${b.id}"`,
            belief_ids: beliefIds,
          }, worldModel)
        }
      }
    }
  }

  // 2. Temporal: versioned beliefs (<base>_v<n>) with same base but different content
  const byBase = new Map<string, Belief[]>()
  for (const b of beliefs) {
    const m = b.id.match(/^(.+)_v(\d+)$/)
    if (m) {
      const base = m[1]
      if (!byBase.has(base)) byBase.set(base, [])
      byBase.get(base)!.push(b)
    }
  }
  for (const [base, versions] of byBase) {
    if (versions.length > 1 && new Set(versions.map(v => v.content)).size > 1) {
      const key = `temporal_${base}`
      if (!detected.has(key)) {
        detected.add(key)
        const sorted = [...versions].sort((x, y) => x.timestamp.localeCompare(y.timestamp))
        const older = sorted[0], newer = sorted[sorted.length - 1]
        addContradiction({
          id: key,
          type: 'temporal',
          severity: computeSeverity(older.reliability, newer.reliability),
          scope: computeScope(older.content + ' ' + newer.content),
          description: `Temporal contradiction: belief "${base}" changed between versions`,
          belief_ids: versions.map(v => v.id),
        }, worldModel)
      }
    }
  }

  // 3. Set-level: beliefs tagged "SET:<id>:<value>:" are jointly inconsistent when values conflict
  const bySets = new Map<string, Belief[]>()
  for (const b of beliefs) {
    const m = b.content.match(/^SET:(\w+):(\w+):/)
    if (m) {
      const setId = m[1]
      if (!bySets.has(setId)) bySets.set(setId, [])
      bySets.get(setId)!.push(b)
    }
  }
  for (const [setId, members] of bySets) {
    const values = members.map(b => {
      const m = b.content.match(/^SET:\w+:(\w+):/)
      return m ? m[1] : ''
    })
    const valSet = new Set(values)
    if (members.length > 1 && valSet.has('true') && valSet.has('false')) {
      const key = `setlevel_${setId}`
      if (!detected.has(key)) {
        detected.add(key)
        addContradiction({
          id: key,
          type: 'set-level',
          severity: computeSeverity(members[0].reliability, members[1]?.reliability ?? 'LOW'),
          scope: computeScope(members.map(m => m.content).join(' ')),
          description: `Set-level contradiction in set "${setId}"`,
          belief_ids: members.map(m => m.id),
        }, worldModel)
      }
    }
  }

  // 4. Abstraction: beliefs "hi:<concept>" and "lo:<concept>" with conflicting content
  const hiBeliefs = beliefs.filter(b => b.id.startsWith('hi:'))
  const loBeliefs = beliefs.filter(b => b.id.startsWith('lo:'))
  for (const hi of hiBeliefs) {
    const concept = hi.id.slice(3)
    const lo = loBeliefs.find(b => b.id.slice(3) === concept)
    if (lo && hi.content !== lo.content) {
      const key = `abstraction_${concept}`
      if (!detected.has(key)) {
        detected.add(key)
        addContradiction({
          id: key,
          type: 'abstraction',
          severity: computeSeverity(hi.reliability, lo.reliability),
          scope: computeScope(hi.content + ' ' + lo.content),
          description: `Abstraction contradiction for concept "${concept}"`,
          belief_ids: [hi.id, lo.id],
        }, worldModel)
      }
    }
  }
}
