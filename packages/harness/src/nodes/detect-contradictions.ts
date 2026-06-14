import type { WorldModel, Contradiction, Belief } from '../state/world-model.js'
import type { EvidenceStore } from '../state/evidence-store.js'
import type { HypothesisSet } from '../state/hypothesis-set.js'

type Severity = 'LOW' | 'MEDIUM' | 'HIGH' | 'SYSTEM_BREAKING'
type Scope = 'local' | 'task' | 'global'

function computeSeverity(confA: number, confB: number): Severity {
  const highA = confA >= 0.8
  const highB = confB >= 0.8
  const medA = confA >= 0.5
  const medB = confB >= 0.5
  if (highA && highB) return 'SYSTEM_BREAKING'
  if (highA || highB || (medA && medB)) return 'HIGH'
  if (medA || medB) return 'MEDIUM'
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

  // 1. Pairwise: belief statement "NOT: <X>" directly negates another belief with statement "<X>"
  for (let i = 0; i < beliefs.length; i++) {
    for (let j = i + 1; j < beliefs.length; j++) {
      const a = beliefs[i], b = beliefs[j]
      const aIsNeg = a.statement.startsWith('NOT: ')
      const bIsNeg = b.statement.startsWith('NOT: ')

      let baseContent = ''
      let beliefIds: string[] = []

      if (aIsNeg && b.statement === a.statement.slice(5)) {
        baseContent = b.statement
        beliefIds = [a.id, b.id]
      } else if (bIsNeg && a.statement === b.statement.slice(5)) {
        baseContent = a.statement
        beliefIds = [a.id, b.id]
      }

      if (beliefIds.length > 0) {
        const key = `pairwise_${[...beliefIds].sort().join('__')}`
        if (!detected.has(key)) {
          detected.add(key)
          addContradiction({
            id: key,
            type: 'pairwise',
            severity: computeSeverity(a.confidence, b.confidence),
            scope: computeScope(baseContent),
            description: `Pairwise contradiction between "${a.id}" and "${b.id}"`,
            involved_belief_ids: beliefIds,
          }, worldModel)
        }
      }
    }
  }

  // 2. Temporal: versioned beliefs (<base>_v<n>) with same base but different statement
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
    if (versions.length > 1 && new Set(versions.map(v => v.statement)).size > 1) {
      const key = `temporal_${base}`
      if (!detected.has(key)) {
        detected.add(key)
        const sorted = [...versions].sort((x, y) => x.recorded_at.localeCompare(y.recorded_at))
        const older = sorted[0], newer = sorted[sorted.length - 1]
        addContradiction({
          id: key,
          type: 'temporal',
          severity: computeSeverity(older.confidence, newer.confidence),
          scope: computeScope(older.statement + ' ' + newer.statement),
          description: `Temporal contradiction: belief "${base}" changed between versions`,
          involved_belief_ids: versions.map(v => v.id),
        }, worldModel)
      }
    }
  }

  // 3. Set-level: beliefs tagged "SET:<id>:<value>:" are jointly inconsistent when values conflict
  const bySets = new Map<string, Belief[]>()
  for (const b of beliefs) {
    const m = b.statement.match(/^SET:(\w+):(\w+):/)
    if (m) {
      const setId = m[1]
      if (!bySets.has(setId)) bySets.set(setId, [])
      bySets.get(setId)!.push(b)
    }
  }
  for (const [setId, members] of bySets) {
    const values = members.map(b => {
      const m = b.statement.match(/^SET:\w+:(\w+):/)
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
          severity: computeSeverity(members[0].confidence, members[1]?.confidence ?? 0.0),
          scope: computeScope(members.map(m => m.statement).join(' ')),
          description: `Set-level contradiction in set "${setId}"`,
          involved_belief_ids: members.map(m => m.id),
        }, worldModel)
      }
    }
  }

  // 4. Abstraction: beliefs "hi:<concept>" and "lo:<concept>" with conflicting statement
  const hiBeliefs = beliefs.filter(b => b.id.startsWith('hi:'))
  const loBeliefs = beliefs.filter(b => b.id.startsWith('lo:'))
  for (const hi of hiBeliefs) {
    const concept = hi.id.slice(3)
    const lo = loBeliefs.find(b => b.id.slice(3) === concept)
    if (lo && hi.statement !== lo.statement) {
      const key = `abstraction_${concept}`
      if (!detected.has(key)) {
        detected.add(key)
        addContradiction({
          id: key,
          type: 'abstraction',
          severity: computeSeverity(hi.confidence, lo.confidence),
          scope: computeScope(hi.statement + ' ' + lo.statement),
          description: `Abstraction contradiction for concept "${concept}"`,
          involved_belief_ids: [hi.id, lo.id],
        }, worldModel)
      }
    }
  }
}
