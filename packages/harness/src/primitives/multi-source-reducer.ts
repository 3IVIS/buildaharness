/**
 * G-4 — MultiSourceDiversityReducer
 *
 * Collects items from N parallel branches, tags each with source and reliability
 * metadata, deduplicates near-identical items via Jaccard token-overlap similarity,
 * and enforces a minimum diversity count.
 * Port of adapter/harness/multi_source_reducer.py. No domain vocabulary.
 */

export type ReliabilityLevel = 'HIGH' | 'MEDIUM' | 'LOW'

export interface BranchConfig {
  stateKey: string
  sourceLabel: string
  reliability: ReliabilityLevel
  internalOnly?: boolean
  reliabilityFn?: (item: unknown) => ReliabilityLevel
}

const RELIABILITY_RANK: Record<ReliabilityLevel, number> = {
  HIGH: 3,
  MEDIUM: 2,
  LOW: 1,
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\w\s]/g, '')
      .split(/\s+/)
      .filter(Boolean),
  )
}

export function jaccardSimilarity(textA: string, textB: string): number {
  if (!textA || !textB) return 0.0
  const setA = tokenize(textA)
  const setB = tokenize(textB)
  let intersection = 0
  for (const token of setA) {
    if (setB.has(token)) intersection++
  }
  const union = setA.size + setB.size - intersection
  if (union === 0) return 0.0
  return intersection / union
}

export function makeMultiSourceReducer(
  branches: BranchConfig[],
  itemTextFn: (item: unknown) => string,
  options?: {
    similarityThreshold?: number
    minDiversityCount?: number
    outputKey?: string
    diversityWarningKey?: string
  },
): (branchStates: Record<string, unknown>[]) => Record<string, unknown> {
  const similarityThreshold = options?.similarityThreshold ?? 0.85
  const minDiversityCount = options?.minDiversityCount ?? 2
  const outputKey = options?.outputKey ?? 'items'
  const diversityWarningKey = options?.diversityWarningKey ?? 'diversity_warning'

  return function reduce(branchStates: Record<string, unknown>[]): Record<string, unknown> {
    const candidates: Array<[Record<string, unknown>, number]> = []

    for (let i = 0; i < branches.length; i++) {
      if (i >= branchStates.length) break
      const config = branches[i]
      const items = branchStates[i][config.stateKey]
      if (!items) continue
      for (const item of items as unknown[]) {
        const reliability =
          config.reliabilityFn != null ? config.reliabilityFn(item) : config.reliability
        const tagged: Record<string, unknown> = { ...(item as Record<string, unknown>) }
        tagged['source'] = config.sourceLabel
        tagged['reliability'] = reliability
        if (config.internalOnly) tagged['internal_only'] = true
        candidates.push([tagged, i])
      }
    }

    const retained: Array<[Record<string, unknown>, number]> = []

    for (const [candidateItem, candidateBranch] of candidates) {
      const candidateText = itemTextFn(candidateItem)
      let replacedAt: number | null = null
      let skip = false

      for (let j = 0; j < retained.length; j++) {
        const [existingItem] = retained[j]
        const existingText = itemTextFn(existingItem)

        if (!candidateText || !existingText) continue

        if (jaccardSimilarity(candidateText, existingText) > similarityThreshold) {
          const candRank = RELIABILITY_RANK[candidateItem['reliability'] as ReliabilityLevel] ?? 0
          const existRank = RELIABILITY_RANK[existingItem['reliability'] as ReliabilityLevel] ?? 0
          if (candRank > existRank) {
            replacedAt = j
          } else {
            skip = true
          }
          break
        }
      }

      if (replacedAt !== null) {
        retained[replacedAt] = [candidateItem, candidateBranch]
      } else if (!skip) {
        retained.push([candidateItem, candidateBranch])
      }
    }

    const resultItems = retained.map(([item]) => item)
    const diversityWarning = resultItems.length < minDiversityCount

    return { [outputKey]: resultItems, [diversityWarningKey]: diversityWarning }
  }
}
