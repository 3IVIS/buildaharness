export enum DimensionType {
  ratio = 'ratio',
  composite = 'composite',
  entropy = 'entropy',
  match_confidence = 'match_confidence',
}

export class NormalisationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'NormalisationError'
  }
}

export type CompositeInput = { components: number[]; weights: number[] }
export type NormaliseInput = number | CompositeInput | number[]

export function normalise(raw: NormaliseInput, type: DimensionType): number {
  switch (type) {
    case DimensionType.ratio:
    case DimensionType.match_confidence:
      return Math.max(0, Math.min(1, raw as number))

    case DimensionType.composite: {
      const { components, weights } = raw as CompositeInput
      const sumWeights = weights.reduce((a, b) => a + b, 0)
      if (sumWeights === 0) return 0
      const weightedSum = components.reduce((acc, c, i) => acc + c * (weights[i] ?? 0), 0)
      return Math.max(0, Math.min(1, weightedSum / sumWeights))
    }

    case DimensionType.entropy: {
      const counts = raw as number[]
      const numSources = counts.length
      if (numSources <= 1) return 0
      const total = counts.reduce((a, b) => a + b, 0)
      if (total === 0) return 0
      const probs = counts.map(c => c / total)
      const entropy = -probs.filter(p => p > 0).reduce((acc, p) => acc + p * Math.log2(p), 0)
      const maxEntropy = Math.log2(numSources)
      return Math.max(0, Math.min(1, entropy / maxEntropy))
    }
  }
}

export function assertNormalised(value: number, label: string): void {
  if (value < 0 || value > 1) {
    throw new NormalisationError(`assertNormalised: "${label}" = ${value} is outside [0, 1]`)
  }
}
