/**
 * G-5 — TaxonomyClassifier
 *
 * LLM-powered text classifier. Taxonomy is entirely caller-provided.
 * Port of adapter/harness/taxonomy_classifier.py. No domain vocabulary.
 * LLM dependency is injected at construction time — no litellm import.
 */

export interface TaxonomyType {
  id: string
  label: string
  description: string
}

export interface ClassifierConfig {
  taxonomy: TaxonomyType[]
  fallbackTypeId: string
  contextStateKey?: string
  model?: string
  temperature?: number
}

export interface ClassificationResult {
  detectedTypes: string[]
  primaryType: string
  confidenceScores: Record<string, number>
  rationale: string
}

export class TaxonomyClassifier {
  private readonly _config: ClassifierConfig
  private readonly _llmCall: (prompt: string, model: string, temperature: number) => Promise<string>
  private readonly _validIds: Set<string>
  private readonly _model: string
  private readonly _temperature: number

  constructor(
    config: ClassifierConfig,
    llmCall: (prompt: string, model: string, temperature: number) => Promise<string>,
  ) {
    if (!config.taxonomy || config.taxonomy.length === 0) {
      throw new Error('taxonomy must not be empty')
    }
    const validIds = new Set(config.taxonomy.map((t) => t.id))
    if (!validIds.has(config.fallbackTypeId)) {
      throw new Error(`fallbackTypeId '${config.fallbackTypeId}' is not in the taxonomy`)
    }
    this._config = config
    this._llmCall = llmCall
    this._validIds = validIds
    this._model = config.model ?? 'claude-haiku-4-5-20251001'
    this._temperature = config.temperature ?? 0.0
  }

  private _fallback(): ClassificationResult {
    const fid = this._config.fallbackTypeId
    return {
      detectedTypes: [fid],
      primaryType: fid,
      confidenceScores: { [fid]: 1.0 },
      rationale: 'fallback',
    }
  }

  private _buildPrompt(text: string, context?: Record<string, unknown>): string {
    const taxonomyLines = this._config.taxonomy
      .map((t) => `${t.id}: ${t.description}`)
      .join('\n')

    let ctxSection = ''
    if (this._config.contextStateKey && context) {
      const ctxValue = context[this._config.contextStateKey]
      if (ctxValue != null) {
        ctxSection = `\n\nBackground context:\n${ctxValue}`
      }
    }

    const validIds = [...this._validIds].join(', ')
    return (
      `Classify the following text against the taxonomy below.\n\n` +
      `Taxonomy:\n${taxonomyLines}\n\n` +
      `Text to classify:\n${text}${ctxSection}\n\n` +
      `Respond with a JSON object using this exact schema:\n` +
      `{"detected_types": ["TYPE_ID", ...], "primary_type": "TYPE_ID", ` +
      `"confidence_scores": {"TYPE_ID": 0.0-1.0, ...}, "rationale": "..."}\n` +
      `Use only these valid type IDs: ${validIds}`
    )
  }

  async classify(
    text: string,
    context?: Record<string, unknown>,
  ): Promise<ClassificationResult> {
    if (!text || !text.trim()) {
      return this._fallback()
    }

    let raw: string
    try {
      const prompt = this._buildPrompt(text, context)
      raw = await this._llmCall(prompt, this._model, this._temperature)
    } catch {
      return this._fallback()
    }

    let parsed: Record<string, unknown>
    try {
      // Try non-greedy match first, fall back to greedy if it fails
      const nonGreedy = raw.match(/\{[\s\S]*?\}/)
      const greedy = raw.match(/\{[\s\S]*\}/)
      let jsonStr: string | null = null
      if (nonGreedy) {
        try {
          JSON.parse(nonGreedy[0])
          jsonStr = nonGreedy[0]
        } catch {
          jsonStr = greedy ? greedy[0] : null
        }
      } else {
        jsonStr = greedy ? greedy[0] : null
      }
      if (!jsonStr) return this._fallback()
      parsed = JSON.parse(jsonStr) as Record<string, unknown>
    } catch {
      return this._fallback()
    }

    try {
      const rawDetected = (parsed['detected_types'] as string[] | null) ?? []
      const rawPrimary = (parsed['primary_type'] as string) ?? ''
      const rawConfidence = (parsed['confidence_scores'] as Record<string, number> | null) ?? {}
      const rationale = (parsed['rationale'] as string) ?? ''

      // Strip invalid type IDs
      let detected = rawDetected.filter((t) => this._validIds.has(t))
      const confidence: Record<string, number> = {}
      for (const [k, v] of Object.entries(rawConfidence)) {
        if (this._validIds.has(k)) confidence[k] = v
      }

      // If detected_types absent but primary_type is valid, use [primary]
      if (detected.length === 0 && this._validIds.has(rawPrimary)) {
        detected = [rawPrimary]
      }

      if (detected.length === 0) return this._fallback()

      // Validate primary_type
      let primary = rawPrimary
      if (!this._validIds.has(primary)) {
        // Pick highest-confidence remaining valid type
        primary = detected.reduce((best, t) =>
          (confidence[t] ?? 0.5) >= (confidence[best] ?? 0.5) ? t : best,
        )
      }

      // Default confidence to 0.5 for any detected type missing a score
      for (const t of detected) {
        if (!(t in confidence)) confidence[t] = 0.5
      }

      return { detectedTypes: detected, primaryType: primary, confidenceScores: confidence, rationale }
    } catch {
      return this._fallback()
    }
  }
}
