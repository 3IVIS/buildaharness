/**
 * G-5 — TaxonomyClassifier
 *
 * LLM-powered text classifier. Taxonomy is entirely caller-provided.
 * Port of adapter/harness/taxonomy_classifier.py. No domain vocabulary.
 * LLM dependency is injected at construction time — no litellm import.
 */
export interface TaxonomyType {
    id: string;
    label: string;
    description: string;
}
export interface ClassifierConfig {
    taxonomy: TaxonomyType[];
    fallbackTypeId: string;
    contextStateKey?: string;
    model?: string;
    temperature?: number;
}
export interface ClassificationResult {
    detectedTypes: string[];
    primaryType: string;
    confidenceScores: Record<string, number>;
    rationale: string;
}
export declare class TaxonomyClassifier {
    private readonly _config;
    private readonly _llmCall;
    private readonly _validIds;
    private readonly _model;
    private readonly _temperature;
    constructor(config: ClassifierConfig, llmCall: (prompt: string, model: string, temperature: number) => Promise<string>);
    private _fallback;
    private _buildPrompt;
    classify(text: string, context?: Record<string, unknown>): Promise<ClassificationResult>;
}
